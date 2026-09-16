/**
 * Offloaded record "data": the client half of the storage offload contract.
 *
 * When a record's stored payload is over the server's offload threshold (RECORD_DATA_OFFLOAD_BYTES,
 * 32 KiB of the stored "!J%<json>" form), post_record keeps the JSON in the record bucket at
 *   {publ|auth}/<service>/<owner>/<uploader>/records/<rid>/<group>/bin/<ts>/<size>/__data__/__json__.json
 * and the record item holds only the marker { __data__: "<ts>/<size>/__data__/__json__.json" }, with
 * the file's url in `bin`. What this suite pins:
 *
 * - Every request says `resolves_offloaded_data: true` in Content-Meta. A request without it is an
 *   older client, and the server replaces markers with the stored "!J%<json>" form for it.
 * - bulkPostRecords and postRecord hand back the payload they just sent instead of downloading it
 *   again, and a write that sent no payload fetches the stored one instead of returning undefined.
 * - getFeed resolves its records concurrently, like getRecords.
 * - A marker whose bin url is missing (an update's follow-up bin write has not landed yet), or whose
 *   bin url still names the old group of an access group move, is fetched from the url the file is
 *   written at.
 * - The server-inlined form an older response carries still decodes.
 *
 * Offline: fetch is mocked, and the CDN is a Map of url -> body.
 *
 * Run: node ./tests/record-data-offload.cjs
 * SKAPI_BUNDLE=<path to another build's skapi.cjs> runs it against that build.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { Skapi } = require(process.env.SKAPI_BUNDLE || '../dist/skapi.cjs');

const FIXTURES = path.join(__dirname, 'fixtures');
const OWNER = '4d4a36a5-b318-4093-92ae-7cf11feae989';
const SERVICE = 'ap21AAAAAAAAAAAAAAAA';
const BIN_HOST = 'https://cdn.example.com';

const jsonResponse = o => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

// The endpoint manifests are read through response.blob() + FileReader.readAsDataURL.
globalThis.FileReader = class FileReader {
    readAsDataURL(blob) {
        blob.arrayBuffer().then(ab => {
            this.result = 'data:application/json;base64,' + Buffer.from(ab).toString('base64');
            if (this.onloadend) this.onloadend();
        }).catch(err => { if (this.onerror) this.onerror(err); });
    }
};

const markerPath = (ts = 'T1', size = 'Z9') => `${ts}/${size}/__data__/__json__.json`;

/** The url post_record writes an offloaded payload at. */
function dataFileUrl({ rid, service = SERVICE, uploader = OWNER, group = '00', ts = 'T1', size = 'Z9' }) {
    const prefix = group === '00' ? 'publ' : 'auth';
    return `${BIN_HOST}/${prefix}/${service}/${OWNER}/${uploader}/records/${rid}/${group}/bin/${markerPath(ts, size)}`;
}

/** An ordinary attachment url of a record. */
function userFileUrl({ rid, service = SERVICE, uploader = OWNER, group = '00', name = 'photo.png' }) {
    const prefix = group === '00' ? 'publ' : 'auth';
    return `${BIN_HOST}/${prefix}/${service}/${OWNER}/${uploader}/records/${rid}/${group}/bin/T0/5/pic/${name}`;
}

/**
 * A raw record item as the backend returns it. get-records and get-feed project `usr_tbl`;
 * the post-record echo is the whole item, carrying `usr` and `tbl`.
 */
function rawRecord({ rid, data, bin, service = SERVICE, uploader = OWNER, group = '00', shape = 'get' }) {
    const out = { rec: rid, srvc: `${service}/${OWNER}`, ip: '1.1.1.1', upd: 1, data };
    if (shape === 'post') {
        out.usr = uploader;
        out.tbl = `t/${service}/${group}`;
        out.usr_tbl = `${uploader}/t/${service}/${group}`;
    }
    else {
        out.usr_tbl = `${uploader}/t/${service}/${group}`;
    }
    if (bin) out.bin = bin;
    return out;
}

// --- mock network ---------------------------------------------------------------------------

let CDN = new Map();         // url -> body served by the record CDN
let CDN_FETCHES = [];        // every CDN url requested, query stripped
let CDN_DELAY_MS = 0;
let inflight = 0;
let maxInflight = 0;
let API_META = [];           // { url, meta } for every API call
let onPost = null;           // body -> response
let onGet = null;            // () -> response
let onFeed = null;           // () -> response
let onDelete = null;         // () -> response

globalThis.fetch = async (url, opt) => {
    const u = String(url);
    if (/\/admin-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'admin-v1.json')));
    if (/\/record-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'record-v1.json')));

    if (u.startsWith(BIN_HOST)) {
        const clean = u.split('?')[0];
        CDN_FETCHES.push(clean);
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        try {
            if (CDN_DELAY_MS) await new Promise(r => setTimeout(r, CDN_DELAY_MS));
            if (!CDN.has(clean)) return new Response('not found', { status: 404 });
            return new Response(CDN.get(clean), { status: 200 });
        }
        finally {
            inflight--;
        }
    }

    const metaHeader = opt && opt.headers && opt.headers['Content-Meta'];
    const isApi = ['post-record', 'get-records', 'get-feed', 'del-records'].some(p => u.includes(p));
    if (isApi) {
        API_META.push({ url: u, meta: metaHeader ? JSON.parse(metaHeader) : null });
    }
    if (u.includes('post-record')) return jsonResponse(onPost(JSON.parse(opt.body)));
    if (u.includes('get-records')) return jsonResponse(onGet());
    if (u.includes('get-feed')) return jsonResponse(onFeed());
    if (u.includes('del-records')) return jsonResponse(onDelete());
    return jsonResponse({ ip: '1.1.1.1', locale: 'KR', service_name: 't', group: 99, opt: {} });
};

const results = [];
async function test(name, fn) {
    CDN = new Map();
    CDN_FETCHES = [];
    CDN_DELAY_MS = 0;
    inflight = 0;
    maxInflight = 0;
    API_META = [];
    onPost = onGet = onFeed = onDelete = null;
    try {
        await fn();
        results.push(true);
        console.log(`ok    ${name}`);
    } catch (err) {
        results.push(false);
        console.log(`FAIL  ${name}\n      ${err && err.message}`);
    }
}

(async () => {
    const skapi = new Skapi(SERVICE, OWNER, { autoLogin: false });
    await skapi.__connection;

    /**
     * Authenticated calls read a live session (getJwtToken). Fake one, the same way
     * tests/record-data-json-marker.cjs does. Both the session and the user are pinned with
     * getters: a query-shaped call replaces __connection with a pending refresh that nulls them
     * when it settles, and the access group check on a non-public table reads __user.
     */
    async function asLoggedIn(fn) {
        await skapi.__connection;
        const exp = Math.floor(Date.now() / 1000) + 86400;
        const session = {
            getIdToken: () => ({ getExpiration: () => exp }),
            idToken: { jwtToken: 'test.id.token', payload: { exp, sub: OWNER } },
            accessToken: { jwtToken: 'test.access.token' },
            refreshToken: { token: 'test.refresh.token' }
        };
        const user = { user_id: OWNER, access_group: 99 };
        Object.defineProperty(skapi, '__user', { configurable: true, get: () => user, set: () => { } });
        Object.defineProperty(skapi, 'session', { configurable: true, get: () => session, set: () => { } });
        try { return await fn(); }
        finally {
            delete skapi.session;
            delete skapi.__user;
            skapi.session = null;
            skapi.__user = null;
        }
    }

    const readAll = async () => (await skapi.getRecords({ table: { name: 't', access_group: 0 } })).list;

    // --- the request flag ---------------------------------------------------------------------

    await test('every record request says resolves_offloaded_data: true in Content-Meta', async () => {
        onGet = () => ({ list: [], endOfList: true });
        onPost = body => body._is_bulk_
            ? body._is_bulk_.map((c, i) => rawRecord({ rid: 'VQflagbulk0000' + i, data: 1, shape: 'post' }))
            : rawRecord({ rid: 'VQflagsingle0001', data: 1, shape: 'post' });
        await readAll();
        await skapi.bulkPostRecords([{ table: { name: 't', access_group: 0 }, data: 1 }]);
        await skapi.postRecord({ a: 1 }, { table: { name: 't', access_group: 0 } });

        assert.strictEqual(API_META.length, 3, 'three API calls were made');
        for (const { url, meta } of API_META) {
            assert.ok(meta, `Content-Meta is sent on ${url}`);
            assert.strictEqual(meta.resolves_offloaded_data, true, `the flag is the boolean true on ${url}`);
            assert.strictEqual(meta.service, SERVICE, 'service still rides in Content-Meta');
            assert.strictEqual(meta.owner, OWNER, 'owner still rides in Content-Meta');
        }
    });

    // --- bulkPostRecords -----------------------------------------------------------------------

    await test('bulkPostRecords returns the posted payloads of offloaded echoes with zero CDN fetches', async () => {
        const posted = [
            { rows: 'a'.repeat(50), n: 1 },
            { rows: 'b'.repeat(50), n: 2 }   // same stored size as the first: same marker path
        ];
        onPost = body => body._is_bulk_.map((c, i) => {
            const rid = 'VQbulkecho0000' + i;
            const url = dataFileUrl({ rid });
            CDN.set(url, JSON.stringify(c.data));
            return rawRecord({ rid, data: { __data__: markerPath() }, bin: [url], shape: 'post' });
        });

        const out = await skapi.bulkPostRecords(posted.map(data => ({ table: { name: 't', access_group: 0 }, data })));
        assert.strictEqual(CDN_FETCHES.length, 0, 'nothing just sent is downloaded again');
        assert.deepStrictEqual(out[0].data, posted[0]);
        assert.deepStrictEqual(out[1].data, posted[1], 'each element gets its own payload back');
        assert.strictEqual(out[0].record_id, 'VQbulkecho00000');
        assert.deepStrictEqual(out[0].bin, {}, 'the data file stays out of bin');
    });

    await test('bulkPostRecords still fetches the stored payload for an element that sent no data', async () => {
        const stored = { kept: true, big: 'x'.repeat(40) };
        onPost = body => body._is_bulk_.map((c, i) => {
            const rid = 'VQbulkmeta0000' + i;
            const url = dataFileUrl({ rid });
            CDN.set(url, JSON.stringify(c.data !== undefined ? c.data : stored));
            return rawRecord({ rid, data: { __data__: markerPath() }, bin: [url], shape: 'post' });
        });

        const out = await asLoggedIn(() => skapi.bulkPostRecords([
            { record_id: 'VQbulkmeta00000', tags: ['x'] },
            { record_id: 'VQbulkmeta00001', tags: ['y'], data: undefined },
            { record_id: 'VQbulkmeta00002', data: { sent: 1 } }
        ]));
        assert.deepStrictEqual(out[0].data, stored, 'a metadata-only element reads the stored payload');
        assert.deepStrictEqual(out[1].data, stored, 'data: undefined sends no data key, so it is metadata-only too');
        assert.deepStrictEqual(out[2].data, { sent: 1 });
        assert.deepStrictEqual(CDN_FETCHES.sort(), [
            dataFileUrl({ rid: 'VQbulkmeta00000' }),
            dataFileUrl({ rid: 'VQbulkmeta00001' })
        ].sort(), 'exactly the two elements without a payload fetched');
    });

    await test('bulkPostRecords leaves an inline echo alone', async () => {
        const posted = { small: true };
        onPost = body => body._is_bulk_.map((c, i) =>
            rawRecord({ rid: 'VQbulkinline000' + i, data: '!J%' + JSON.stringify(c.data), shape: 'post' }));
        const out = await skapi.bulkPostRecords([{ table: { name: 't', access_group: 0 }, data: posted }]);
        assert.deepStrictEqual(out[0].data, posted);
        assert.strictEqual(CDN_FETCHES.length, 0);
    });

    // --- postRecord ---------------------------------------------------------------------------

    await test('postRecord(null, { record_id, data }) returns config.data for an offloaded echo', async () => {
        const payload = { from: 'config', rows: [1, 2, 3] };
        const rid = 'VQpostconfig0001';
        const url = dataFileUrl({ rid });
        onPost = body => {
            CDN.set(url, JSON.stringify(body.data));
            return rawRecord({ rid, data: { __data__: markerPath() }, bin: [url], shape: 'post' });
        };
        const out = await asLoggedIn(() => skapi.postRecord(null, { record_id: rid, data: payload }));
        assert.deepStrictEqual(out.data, payload, 'a payload passed in the config must come back, not undefined');
        assert.strictEqual(CDN_FETCHES.length, 0, 'and it is not downloaded again');
    });

    await test('postRecord(form, config) returns the form payload for an offloaded echo', async () => {
        const payload = { from: 'form' };
        const rid = 'VQpostform000001';
        const url = dataFileUrl({ rid });
        onPost = body => {
            CDN.set(url, JSON.stringify(body.data));
            return rawRecord({ rid, data: { __data__: markerPath() }, bin: [url], shape: 'post' });
        };
        const out = await skapi.postRecord(payload, { table: { name: 't', access_group: 0 } });
        assert.deepStrictEqual(out.data, payload);
        assert.strictEqual(CDN_FETCHES.length, 0);
    });

    await test('a metadata-only postRecord update on an offloaded record returns the stored payload', async () => {
        const stored = { stored: 'payload', big: 'y'.repeat(40) };
        const rid = 'VQpostmeta000001';
        const url = dataFileUrl({ rid });
        CDN.set(url, JSON.stringify(stored));
        let sentDataKey = null;
        onPost = body => {
            sentDataKey = Object.prototype.hasOwnProperty.call(body, 'data');
            return rawRecord({ rid, data: { __data__: markerPath() }, bin: [url], shape: 'post' });
        };
        const out = await asLoggedIn(() => skapi.postRecord(undefined, { record_id: rid, tags: ['z'] }));
        assert.strictEqual(sentDataKey, false, 'no data key went on the wire');
        assert.deepStrictEqual(out.data, stored, 'the stored payload is the only copy, so it is fetched');
        assert.deepStrictEqual(CDN_FETCHES, [url]);
    });

    // --- getFeed ------------------------------------------------------------------------------

    await test('getFeed resolves offloaded records concurrently, in order', async () => {
        const payloads = [{ i: 0 }, { i: 1 }, { i: 2 }];
        const list = payloads.map((p, i) => {
            const rid = 'VQfeed000000000' + i;
            const url = dataFileUrl({ rid });
            CDN.set(url, JSON.stringify(p));
            return rawRecord({ rid, data: { __data__: markerPath() }, bin: [url] });
        });
        onFeed = () => ({ list, endOfList: true });
        CDN_DELAY_MS = 40;

        const out = await asLoggedIn(() => skapi.getFeed());
        assert.deepStrictEqual(out.list.map(r => r.data), payloads, 'every record resolved, in feed order');
        assert.strictEqual(CDN_FETCHES.length, 3);
        assert.ok(maxInflight >= 2, `the file fetches overlap (max in flight ${maxInflight}), not one at a time`);
    });

    // --- what an older response looks like ------------------------------------------------------

    await test('a server-inlined "!J%" payload with the data url stripped from bin decodes', async () => {
        // A request the server treated as unflagged: marker replaced by the stored form, and the
        // __data__/__json__.json url removed from bin. Other files stay.
        const payload = { inlined: true, rows: ['r'.repeat(30)] };
        const rid = 'VQinlined0000001';
        onGet = () => ({
            list: [rawRecord({ rid, data: '!J%' + JSON.stringify(payload), bin: [userFileUrl({ rid })] })],
            endOfList: true
        });
        const [rec] = await readAll();
        assert.deepStrictEqual(rec.data, payload);
        assert.strictEqual(CDN_FETCHES.length, 0, 'nothing to fetch');
        assert.deepStrictEqual(Object.keys(rec.bin), ['pic'], 'the attachment is still listed');
    });

    // --- a marker with no bin url -------------------------------------------------------------

    await test('a marker with no bin url is fetched from its derived url (host from the same record)', async () => {
        const service = 'ap21DERIVEDSAMEREC01';
        const rid = 'VQderived0000001';
        const payload = { derived: 'same record' };
        const expected = dataFileUrl({ rid, service });
        CDN.set(expected, JSON.stringify(payload));
        onGet = () => ({
            list: [rawRecord({ rid, service, data: { __data__: markerPath() }, bin: [userFileUrl({ rid, service })] })],
            endOfList: true
        });
        const [rec] = await readAll();
        assert.deepStrictEqual(CDN_FETCHES, [expected], 'the derived url is exactly where post_record writes the file');
        assert.deepStrictEqual(rec.data, payload);
        assert.deepStrictEqual(Object.keys(rec.bin), ['pic']);
    });

    await test('the host can come from a LATER record of the same page', async () => {
        const service = 'ap21DERIVEDLATERREC1';
        const payload = { derived: 'later record' };
        const expected = dataFileUrl({ rid: 'VQderivedlater01', service });
        CDN.set(expected, JSON.stringify(payload));
        onGet = () => ({
            list: [
                rawRecord({ rid: 'VQderivedlater01', service, data: { __data__: markerPath() } }),
                rawRecord({ rid: 'VQderivedlater02', service, data: { plain: 1 }, bin: [userFileUrl({ rid: 'VQderivedlater02', service })] })
            ],
            endOfList: true
        });
        const list = await readAll();
        assert.deepStrictEqual(list[0].data, payload);
        assert.deepStrictEqual(list[1].data, { plain: 1 });
        assert.deepStrictEqual(CDN_FETCHES, [expected]);
    });

    await test('the host is remembered per service from an earlier read', async () => {
        const service = 'ap21DERIVEDEARLIER01';
        onGet = () => ({
            list: [rawRecord({ rid: 'VQderivedearly01', service, data: 1, bin: [userFileUrl({ rid: 'VQderivedearly01', service })] })],
            endOfList: true
        });
        await readAll();

        const payload = { derived: 'earlier read' };
        const expected = dataFileUrl({ rid: 'VQderivedearly02', service, ts: 'T7', size: 'A1' });
        CDN.set(expected, JSON.stringify(payload));
        onGet = () => ({
            list: [rawRecord({ rid: 'VQderivedearly02', service, data: { __data__: markerPath('T7', 'A1') } })],
            endOfList: true
        });
        const [rec] = await readAll();
        assert.deepStrictEqual(rec.data, payload);
        assert.deepStrictEqual(CDN_FETCHES, [expected]);
    });

    await test('a non-public record derives an auth/ url with its own access group', async () => {
        const service = 'ap21DERIVEDAUTHGRP01';
        const rid = 'VQderivedauth001';
        const payload = { derived: 'authorized' };
        const expected = dataFileUrl({ rid, service, group: '01' });
        assert.ok(expected.includes('/auth/') && expected.includes('/01/bin/'));
        CDN.set(expected, JSON.stringify(payload));
        onGet = () => ({
            list: [rawRecord({ rid, service, group: '01', data: { __data__: markerPath() }, bin: [userFileUrl({ rid, service, group: '01' })] })],
            endOfList: true
        });
        const [rec] = await asLoggedIn(async () => (await skapi.getRecords({ table: { name: 't', access_group: 1 } })).list);
        assert.deepStrictEqual(CDN_FETCHES, [expected]);
        assert.deepStrictEqual(rec.data, payload);
    });

    await test('a bin url left at the old access group falls back to the current group url', async () => {
        // An access group move (00 -> 01): move_folder_s3 has copied the file to the 01 prefix and
        // deleted the 00 object, but the S3 events have not swapped the bin url yet.
        const service = 'ap21DERIVEDMOVEDGRP1';
        const rid = 'VQderivedmoved01';
        const payload = { derived: 'moved' };
        const staleUrl = dataFileUrl({ rid, service, group: '00' });
        const movedUrl = dataFileUrl({ rid, service, group: '01' });
        CDN.set(movedUrl, JSON.stringify(payload));
        onGet = () => ({
            list: [rawRecord({ rid, service, group: '01', data: { __data__: markerPath() }, bin: [staleUrl] })],
            endOfList: true
        });
        const [rec] = await asLoggedIn(async () => (await skapi.getRecords({ table: { name: 't', access_group: 1 } })).list);
        assert.deepStrictEqual(CDN_FETCHES, [staleUrl, movedUrl], 'the bin url first, then the current group url');
        assert.deepStrictEqual(rec.data, payload);
    });

    await test('a bin url that fails at its own location is not fetched twice', async () => {
        const service = 'ap21DERIVEDSAMEFAIL1';
        const rid = 'VQderivedsame404';
        const url = dataFileUrl({ rid, service });
        onGet = () => ({
            list: [rawRecord({ rid, service, data: { __data__: markerPath() }, bin: [url] })],
            endOfList: true
        });
        const [rec] = await readAll();
        assert.deepStrictEqual(CDN_FETCHES, [url], 'the derived url equals the bin url, so no retry');
        assert.strictEqual(rec.data, null, 'a failed fetch still reads as data: null');
    });

    await test('with no known host for the service, the marker comes back verbatim and nothing is fetched', async () => {
        const service = 'ap21DERIVEDUNKNOWN01';
        const marker = { __data__: markerPath() };
        onGet = () => ({ list: [rawRecord({ rid: 'VQderivedunkn001', service, data: marker })], endOfList: true });
        const [rec] = await readAll();
        assert.deepStrictEqual(rec.data, marker);
        assert.strictEqual(CDN_FETCHES.length, 0);
    });

    await test('a derived url that is not there yet leaves the marker verbatim', async () => {
        const service = 'ap21DERIVEDMISSING01';
        const rid = 'VQderivedmiss001';
        const marker = { __data__: markerPath() };
        onGet = () => ({
            list: [rawRecord({ rid, service, data: marker, bin: [userFileUrl({ rid, service })] })],
            endOfList: true
        });
        const [rec] = await readAll();
        assert.deepStrictEqual(CDN_FETCHES, [dataFileUrl({ rid, service })], 'it was tried');
        assert.deepStrictEqual(rec.data, marker, 'and the failure reads the same as having no url');
    });

    await test('a malformed marker path is never spliced into a url', async () => {
        const service = 'ap21DERIVEDMALFORM01';
        const rid = 'VQderivedbad0001';
        const marker = { __data__: 'a/../../x/__data__/__json__.json' };
        onGet = () => ({
            list: [rawRecord({ rid, service, data: marker, bin: [userFileUrl({ rid, service })] })],
            endOfList: true
        });
        const [rec] = await readAll();
        assert.strictEqual(CDN_FETCHES.length, 0);
        assert.deepStrictEqual(rec.data, marker);
    });

    await test('deleteRecords still fetches nothing for a marker with no bin url', async () => {
        const service = 'ap21DERIVEDDELETE001';
        const rid = 'VQderiveddel0001';
        const marker = { __data__: markerPath() };
        CDN.set(dataFileUrl({ rid, service }), JSON.stringify({ never: 'fetched' }));
        onDelete = () => ({
            list: [rawRecord({ rid, service, data: marker, bin: [userFileUrl({ rid, service })] })],
            startKey: null,
            endOfList: true
        });
        const res = await asLoggedIn(() => skapi.deleteRecords({ table: { name: 't', access_group: 0 } }));
        assert.deepStrictEqual(res.list[0].data, marker);
        assert.strictEqual(CDN_FETCHES.length, 0, 'the files are being deleted, so no fetch');
    });

    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})();

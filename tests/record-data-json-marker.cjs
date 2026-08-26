/**
 * The record "data" JSON codec: "!J%<json text>".
 *
 * A record's "data" is arbitrary caller JSON that the backend writes straight into a DynamoDB item
 * attribute, and DynamoDB refuses three shapes of perfectly valid JSON: an empty map key at any
 * depth ("ValidationException: Empty attribute name"), a map key over 65535 UTF-8 bytes, and
 * nesting past 32 levels. Model-written data hits the first one regularly, e.g.
 * { "": "All three frequencies detected", "display": "..." } where a field's key was left empty.
 *
 * Rather than refuse the write, post_record stores such a payload as its JSON text behind a '!J%'
 * prefix and the SDK parses it back, here. Everything else keeps its native DynamoDB form, so the
 * encoding only ever appears on records that could not have been stored at all.
 *
 * Three older stored forms are still READ, because all three are out there: '!D%{}' and '!L%[]'
 * (an empty dict and an empty list, before both stored natively) and { __json__: text }, this
 * codec's first form, which was live in five regions from 2026-08-22.
 *
 * The decode is deliberately conservative: text that carries the prefix but does not parse is an
 * ordinary user value and must come back verbatim, which is why the server also encodes a caller
 * payload that would itself be read as a marker.
 *
 * Run: node ./tests/record-data-json-marker.cjs
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { Skapi } = require(process.env.SKAPI_BUNDLE || '../dist/skapi.cjs');

const FIXTURES = path.join(__dirname, 'fixtures');
const OWNER = '4d4a36a5-b318-4093-92ae-7cf11feae989';
const SERVICE = 'ap21AAAAAAAAAAAAAAAA';
const RID = 'VQxxxxxxxxxxxxxx';

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

// What the server would have stored for the payload the client just posted. Mirrors
// encode_record_data in infra/layer/database_interface/python/database_interface.py.
let storedFor = null;

// A record carrying an offloaded "data" file. The url shape is what normalizeRecord pre-scans
// for: <host>/<auth>/<svc>/<owner>/<uploader>/records/<rid>/<group>/bin/<ts>/<size>/__data__/__json__.json
const BIN_HOST = 'https://cdn.example.com';
const DATA_FILE_PATH = '0/0/__data__/__json__.json';
const DATA_FILE_URL = `${BIN_HOST}/publ/svc/${OWNER}/${OWNER}/records/${RID}/00/bin/${DATA_FILE_PATH}`;
// Body the mock storage serves for that file.
let offloadedBody = null;

const rawRecord = data => ({
    rec: RID,
    srvc: 'x/y',
    usr: OWNER,
    ip: '',
    tbl: 't/svc/00',
    data
});

globalThis.fetch = async (url, opt) => {
    const u = String(url);
    // Matched by prefix, not by version: the SDK's __endpoint_version moves (it is v2 now) while
    // the fixtures keep their filename.
    if (/\/admin-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'admin-v1.json')));
    if (/\/record-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'record-v1.json')));
    if (u.includes('post-record')) {
        const body = JSON.parse(opt.body);
        return jsonResponse(body._is_bulk_.map(c => rawRecord(storedFor === null ? c.data : storedFor)));
    }
    if (u.includes('get-records')) {
        const rec = rawRecord(storedFor);
        if (offloadedBody !== null) rec.bin = [DATA_FILE_URL];
        return jsonResponse({ list: [rec], endOfList: true });
    }
    if (u.startsWith(BIN_HOST)) {
        return new Response(offloadedBody, { status: 200 });
    }
    if (u.includes('del-records')) {
        // the query form echoes the records it deleted, RAW, exactly as the backend does
        return jsonResponse({ list: [rawRecord(storedFor)], startKey: null, endOfList: true });
    }
    return jsonResponse({ ip: '1.1.1.1', locale: 'KR', service_name: 't', group: 99, opt: {} });
};

const results = [];
async function test(name, fn) {
    storedFor = null;
    offloadedBody = null;
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

    // deleteRecords is an authenticated call (request(..., { auth: true })), and the token
    // getter in user.ts wants a live session, not just a bearer token: an unexpired
    // idToken, or it tries to refresh. Fake one far enough in the future that the refresh
    // branch is never taken. The mock server ignores the token.
    /**
     * deleteRecords is an authenticated call, and getJwtToken reads a live session:
     * session.getIdToken().getExpiration(), refreshing anything within an hour of expiry.
     * Fake that shape rather than doing a Cognito round trip.
     *
     * It is pinned with a getter rather than assigned. getJwtToken starts with
     * `await this.__connection`, and a query-shaped call replaces __connection with a
     * PENDING refresh that nulls `session` when it settles, so a plain assignment is gone
     * by the time the token is read and the call fails with "User login is required".
     * The getter ignores those writes for the duration of the call.
     */
    async function asLoggedIn(fn) {
        await skapi.__connection;
        const exp = Math.floor(Date.now() / 1000) + 86400;
        const session = {
            getIdToken: () => ({ getExpiration: () => exp }),
            idToken: { jwtToken: 'test.id.token', payload: { exp } },
            accessToken: { jwtToken: 'test.access.token' },
            refreshToken: { token: 'test.refresh.token' }
        };
        skapi.__user = { user_id: OWNER, access_group: 99 };
        Object.defineProperty(skapi, 'session', { configurable: true, get: () => session, set: () => { } });
        try { return await fn(); }
        finally {
            delete skapi.session;
            skapi.session = null;
            skapi.__user = null;
        }
    }

    /** Post `data`, with the server storing `stored`, and return the record the caller sees. */
    const post = async (data, stored) => {
        storedFor = stored === undefined ? null : stored;
        const out = await skapi.bulkPostRecords([{ table: { name: 't', access_group: 0 }, data }]);
        return out[0];
    };

    /** Read back a record the server has stored as `stored`. */
    const read = async stored => {
        storedFor = stored;
        const out = await skapi.getRecords({ table: { name: 't', access_group: 0 } });
        return out.list[0];
    };

    // --- the payload that started this -------------------------------------------------

    const REAL = {
        title: 'TACT mode distress-signal detection and SAR SCAN activation',
        display_examples: [
            { detected_frequency: '406.025 MHz', display: '351.975/-- with (406) indication' },
            { '': 'All three distress frequencies detected', display: '351.975/-- with (406), (121), (243)' },
            { '': 'Tactical direction issued to pilot', display: '351.975/44' }
        ]
    };

    await test('THE PROOF: data with an empty key round-trips through !J%', async () => {
        const out = await read('!J%' + JSON.stringify(REAL));
        assert.deepStrictEqual(out.data, REAL);
        assert.strictEqual(out.data.display_examples[1][''], 'All three distress frequencies detected',
            'the empty key itself must survive, it is the whole point');
    });

    await test('the encoding is decoded on postRecord responses too, not only reads', async () => {
        const out = await post(REAL, '!J%' + JSON.stringify(REAL));
        assert.deepStrictEqual(out.data, REAL);
    });

    await test('every JSON type survives the round trip', async () => {
        const value = { '': null, a: 1, b: 1.5, c: false, d: [1, 'two', { '': 3 }], e: {}, f: [], g: '' };
        const out = await read('!J%' + JSON.stringify(value));
        assert.deepStrictEqual(out.data, value);
    });

    await test('non-Latin text survives (the server writes it unescaped)', async () => {
        const value = { '': '한국어 🐰', 'key 이름': 'ok' };
        const out = await read('!J%' + JSON.stringify(value));
        assert.deepStrictEqual(out.data, value);
    });

    await test('a top-level array is returned as an array, not an object', async () => {
        const value = [{ a: 1 }, { '': 2 }];
        const out = await read('!J%' + JSON.stringify(value));
        assert.ok(Array.isArray(out.data));
        assert.deepStrictEqual(out.data, value);
    });

    await test('a payload nested deeper than DynamoDB allows round-trips', async () => {
        let value = 'leaf';
        for (let i = 0; i < 40; i++) value = { a: value };
        const out = await read('!J%' + JSON.stringify(value));
        assert.deepStrictEqual(out.data, value);
    });

    // --- values that only LOOK like the encoding -------------------------------------

    await test('text that carries the prefix but does not parse is returned verbatim', async () => {
        // the server encodes a payload that really is such a string, so this can only be
        // somebody's real text
        const value = '!J%not json {';
        assert.strictEqual((await read(value)).data, value);
    });

    await test('a string merely containing !J% is untouched', async () => {
        const value = 'see !J%{} in the docs';
        assert.strictEqual((await read(value)).data, value);
    });

    await test('the update command protocol is not a data value', async () => {
        // '*add' inside data used to be hijacked by update() into a DynamoDB ADD
        const value = { note: 'use *add here' };
        assert.deepStrictEqual((await read('!J%' + JSON.stringify(value))).data, value);
    });

    // --- the three legacy stored forms ------------------------------------------------

    await test('the legacy empty-dict and empty-list sentinels still decode', async () => {
        assert.deepStrictEqual((await read('!D%{}')).data, {});
        assert.deepStrictEqual((await read('!L%[]')).data, []);
    });

    await test('the legacy { __json__: text } form still decodes', async () => {
        // live in five regions from 2026-08-22, so records hold it
        const out = await read({ __json__: JSON.stringify(REAL) });
        assert.deepStrictEqual(out.data, REAL);
    });

    await test('a legacy-shaped value that does not parse is returned verbatim', async () => {
        const value = { __json__: 'not json {' };
        assert.deepStrictEqual((await read(value)).data, value);
    });

    await test('__json__ holding a non-string is an ordinary value', async () => {
        const value = { __json__: 123 };
        assert.deepStrictEqual((await read(value)).data, value);
    });

    await test('__json__ alongside another key is an ordinary value', async () => {
        const value = { __json__: '[1,2]', other: 1 };
        assert.deepStrictEqual((await read(value)).data, value);
    });

    await test('an offload marker with no matching bin file falls through verbatim', async () => {
        const value = { __data__: '0/0/__data__/__json__.json' };
        assert.deepStrictEqual((await read(value)).data, value);
    });

    await test('!J% carries every JSON type, which is now how all of them are stored', async () => {
        assert.deepStrictEqual((await read('!J%{}')).data, {});
        assert.deepStrictEqual((await read('!J%[]')).data, []);
        assert.strictEqual((await read('!J%null')).data, null);
        assert.strictEqual((await read('!J%true')).data, true);
        assert.strictEqual((await read('!J%3')).data, 3);
        assert.strictEqual((await read('!J%"x"')).data, 'x');
    });

    await test('a list keeps its duplicates and order', async () => {
        // a list is stored as text now, so it never reaches put()'s Set conversion. The
        // native case is a record written before that changed.
        assert.deepStrictEqual((await read([1, 1, 1, 1, 1])).data, [1, 1, 1, 1, 1]);
        assert.deepStrictEqual((await read('!J%[1,1,1]')).data, [1, 1, 1]);
    });

    await test('a natively stored empty dict, list or string still reads back', async () => {
        assert.deepStrictEqual((await read({})).data, {});
        assert.deepStrictEqual((await read([])).data, []);
        assert.strictEqual((await read('')).data, '');
    });

    // --- the offloaded-data file is parsed ONCE ------------------------------------------

    await test('an offloaded payload comes back parsed', async () => {
        const value = { rows: [1, 2, 3], note: 'big' };
        offloadedBody = JSON.stringify(value);
        const out = await read({ __data__: DATA_FILE_PATH });
        assert.deepStrictEqual(out.data, value);
    });

    await test('an offloaded payload that IS marker-shaped is NOT unwrapped again', async () => {
        // The offloaded file always holds the ORIGINAL payload (post_record offloads
        // decode_record_data(...)), so a file whose contents are marker-shaped belongs to a
        // caller who really stored that shape. Running the decode over the fetched body
        // would silently unwrap their data. This test is what stops that "fix".
        const value = { __json__: '{"unwrapped":true}' };
        offloadedBody = JSON.stringify(value);
        const out = await read({ __data__: DATA_FILE_PATH });
        assert.deepStrictEqual(out.data, value);
    });

    await test('an offload marker is never itself encoded', async () => {
        // post_record writes { __data__: path } as a RAW map, because the '!J%' branch
        // runs first and would return the marker object instead of fetching the payload.
        // This is the client half of that contract.
        const value = { rows: [1, 2, 3] };
        offloadedBody = JSON.stringify(value);
        assert.deepStrictEqual((await read({ __data__: DATA_FILE_PATH })).data, value,
            'a raw marker fetches the file');
        offloadedBody = JSON.stringify(value);
        assert.deepStrictEqual((await read('!J%' + JSON.stringify({ __data__: DATA_FILE_PATH }))).data,
            { __data__: DATA_FILE_PATH },
            'an ENCODED marker is data, not a marker: it parses and returns, never fetching');
    });

    await test('ordinary data is untouched', async () => {
        const value = { a: 1, b: [1, 2, { c: 'd' }] };
        assert.deepStrictEqual((await read(value)).data, value);
        assert.deepStrictEqual((await read('plain string')).data, 'plain string');
        assert.deepStrictEqual((await read(0)).data, 0);
    });

    // --- deleteRecords used to be the one method that never normalized ------------------

    await test('deleteRecords parses !J% in the records it returns', async () => {
        storedFor = '!J%' + JSON.stringify(REAL);
        const res = await asLoggedIn(() => skapi.deleteRecords({ table: { name: 't', access_group: 0 } }));
        assert.deepStrictEqual(res.list[0].data, REAL,
            'the deleted record\'s data must not come back as raw !J% text');
    });

    await test('deleteRecords decodes ONLY data, leaving the rest of the item alone', async () => {
        // full normalization would put the caller's id token into bin[].url (getFile
        // 'endpoint' appends it) and fire a private-access request per record, racing the
        // asynchronous file deletion. The record therefore keeps its raw shape.
        storedFor = '!J%' + JSON.stringify({ a: 1 });
        const res = await asLoggedIn(() => skapi.deleteRecords({ table: { name: 't', access_group: 0 } }));
        const rec = res.list[0];
        assert.deepStrictEqual(rec.data, { a: 1 }, 'data is decoded');
        assert.strictEqual(rec.rec, RID, 'the raw item is otherwise untouched');
        assert.strictEqual(rec.bin, undefined, 'no bin resolution, so no token in a url');
    });

    await test('deleteRecords still passes a plain success string through', async () => {
        // deleting by record_id returns a string, not a list, and must not be touched
        const prev = globalThis.fetch;
        globalThis.fetch = async (url, opt) => {
            if (String(url).includes('del-records')) return jsonResponse('SUCCESS: Deleted 1 record.');
            return prev(url, opt);
        };
        try {
            const res = await asLoggedIn(() => skapi.deleteRecords({ record_id: RID }));
            assert.strictEqual(res, 'SUCCESS: Deleted 1 record.');
        }
        finally { globalThis.fetch = prev; }
    });

    await test('deleteRecords leaves an offloaded record as its marker, making no network call', async () => {
        // the files are deleted asynchronously, so fetching here would race that
        let fetched = false;
        const prev = globalThis.fetch;
        globalThis.fetch = async (url, opt) => {
            if (String(url).startsWith(BIN_HOST)) { fetched = true; }
            return prev(url, opt);
        };
        try {
            storedFor = { __data__: DATA_FILE_PATH };
            offloadedBody = JSON.stringify({ never: 'fetched' });
            const res = await asLoggedIn(() => skapi.deleteRecords({ table: { name: 't', access_group: 0 } }));
            assert.deepStrictEqual(res.list[0].data, { __data__: DATA_FILE_PATH });
            assert.strictEqual(fetched, false, 'no file fetch on a delete');
        }
        finally { globalThis.fetch = prev; }
    });

    // --- a stored null ------------------------------------------------------------------

    await test('a stored null reads back as null, not as a missing field', async () => {
        const res = await read('!J%null');
        assert.strictEqual(res.data, null);
        assert.ok('data' in res, 'the key is present, carrying null');
    });

    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})();

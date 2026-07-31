/**
 * Regression test: the unique_id -> record_id cache must be scoped per service.
 *
 * THE BUG. `__my_unique_ids` used to be a flat { unique_id: record_id } map on the Skapi
 * instance. One instance routinely serves many services (the MCP server keeps a single
 * instance per user and names the target project on every call), so two projects holding
 * the same unique_id, e.g. the SAME FILENAME uploaded to both, collided on one key.
 * Whichever project wrote last won, and every later post that referenced that unique_id
 * was silently rewritten to the OTHER project's record_id before leaving the process.
 * The backend then answered, correctly, 'Reference "VQ..." does not exists.'
 *
 * Measured in production: 71 of 71 outgoing bulk bodies carried a record_id and not one
 * carried the "src::" string the caller actually passed.
 *
 * These tests drive the REAL built bundle (dist/skapi.cjs) with the network stubbed, and
 * assert on the bytes that would go on the wire.
 *
 * Run: node ./tests/unique-id-scope.cjs
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// SKAPI_BUNDLE lets this run against another build. Pointing it at the pre-1.8.2
// published bundle is the mutation check: these tests MUST fail there.
const { Skapi } = require(process.env.SKAPI_BUNDLE || '../dist/skapi.cjs');

const FIXTURES = path.join(__dirname, 'fixtures');
const OWNER = '4d4a36a5-b318-4093-92ae-7cf11feae989';
const SERVICE_A = 'ap21AAAAAAAAAAAAAAAA';
const SERVICE_B = 'ap21BBBBBBBBBBBBBBBB';
const UNIQUE_ID = 'src::B507 기체 1 + 판금.xlsx';
const RECORD_IN_A = 'VQs5vPsSKrIUxckv';

// --- offline environment -----------------------------------------------------------

// The SDK reads its endpoint config as a Blob through FileReader, which Node does not
// provide. Minimal shim: enough for readAsDataURL on a real Blob.
globalThis.FileReader = class FileReader {
    readAsDataURL(blob) {
        blob.arrayBuffer()
            .then(ab => {
                this.result = 'data:application/json;base64,' + Buffer.from(ab).toString('base64');
                if (this.onloadend) this.onloadend();
            })
            .catch(err => { if (this.onerror) this.onerror(err); });
    }
};

const captured = [];

// The cache is written from the SERVER's answer, not from the request, and a record's
// unique_id travels back inside `ip` as "<ip>#<unique_id>". Setting these lets a test
// drive the write path without sending a unique_id, which an unauthenticated caller is
// not allowed to do.
let echoUniqueId = null;
let echoRecordId = 'VQechoedRECxckv';

function jsonResponse(obj) {
    return new Response(JSON.stringify(obj), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}

globalThis.fetch = async (url, opt) => {
    const u = String(url);

    if (u.includes('admin-v1.json')) {
        return new Response(fs.readFileSync(path.join(FIXTURES, 'admin-v1.json')));
    }
    if (u.includes('record-v1.json')) {
        return new Response(fs.readFileSync(path.join(FIXTURES, 'record-v1.json')));
    }
    if (u.includes('post-record')) {
        let body = null;
        try { body = JSON.parse(opt && opt.body); } catch (e) { body = opt && opt.body; }
        captured.push({ url: u, body });
        // Echo one saved record back so the normalize + cache-write path is exercised.
        const echo = () => ({
            rec: echoRecordId,
            srvc: 'x/y',
            usr: OWNER,
            ip: echoUniqueId ? `127.0.0.1#${echoUniqueId}` : ''
        });
        return jsonResponse((body && body._is_bulk_) ? body._is_bulk_.map(echo) : echo());
    }
    if (u.includes('get-records')) {
        let body = null;
        try { body = JSON.parse(opt && opt.body); } catch (e) { body = opt && opt.body; }
        captured.push({ url: u, body, query: u.split('?')[1] || '' });
        return jsonResponse({ list: [], endOfList: true });
    }
    // connection / service info and anything else
    return jsonResponse({
        ip: '127.0.0.1', locale: 'KR', service_name: 'test', group: 99, opt: {}
    });
};

// --- helpers ------------------------------------------------------------------------

async function makeSkapi() {
    const s = new Skapi(SERVICE_A, OWNER, { autoLogin: false });
    await s.__connection;
    return s;
}

function lastBulkReference() {
    const post = [...captured].reverse().find(c => c.url.includes('post-record'));
    assert.ok(post, 'expected a post-record request');
    const list = post.body && post.body._is_bulk_;
    assert.ok(Array.isArray(list) && list.length, 'expected a bulk list on the wire');
    return list[0].reference;
}

const results = [];
async function test(name, fn) {
    captured.length = 0;
    try {
        await fn();
        results.push(['ok', name]);
        console.log(`ok    ${name}`);
    } catch (err) {
        results.push(['FAIL', name, err && err.message]);
        console.log(`FAIL  ${name}\n      ${err && err.message}`);
    }
}

// --- tests --------------------------------------------------------------------------

(async () => {
    const skapi = await makeSkapi();

    /**
     * Populate the cache the way production does: by actually posting a record into
     * `service` and letting the server's answer carry the unique_id back. Seeding the
     * map by hand would only ever match the shape of the build under test, which would
     * make these tests unable to fail against the pre-fix bundle.
     */
    async function seedViaPost(service, recordId) {
        echoUniqueId = UNIQUE_ID;
        echoRecordId = recordId;
        try {
            await skapi.bulkPostRecords([{
                table: { name: 'files', access_group: 0 }, data: {},
                service, owner: OWNER
            }]);
        } finally { echoUniqueId = null; echoRecordId = 'VQechoedRECxckv'; }
    }

    await test('a cached unique_id still resolves inside its OWN service', async () => {
        skapi.__my_unique_ids = {};
        await seedViaPost(SERVICE_A, RECORD_IN_A);
        await skapi.bulkPostRecords([{
            table: { name: 'rows', access_group: 0 }, reference: UNIQUE_ID, data: { a: 1 },
            service: SERVICE_A, owner: OWNER
        }]);
        assert.strictEqual(lastBulkReference(), RECORD_IN_A,
            'the local resolve is the whole point of the cache; it must still work in-scope');
    });

    await test('THE BUG: a cached unique_id must NOT leak into another service', async () => {
        skapi.__my_unique_ids = {};
        await seedViaPost(SERVICE_A, RECORD_IN_A);
        await skapi.bulkPostRecords([{
            table: { name: 'rows', access_group: 0 }, reference: UNIQUE_ID, data: { a: 1 },
            service: SERVICE_B, owner: OWNER
        }]);
        assert.strictEqual(lastBulkReference(), UNIQUE_ID,
            'posting into service B must send the unique_id verbatim and let the backend '
            + 'resolve it, NOT service A\'s record_id');
    });

    await test('a write in one service does not populate another service\'s bucket', async () => {
        skapi.__my_unique_ids = {};
        echoUniqueId = UNIQUE_ID;
        try {
            await skapi.bulkPostRecords([{
                table: { name: 'files', access_group: 0 }, data: {},
                service: SERVICE_A, owner: OWNER
            }]);
        } finally { echoUniqueId = null; }
        const buckets = Object.keys(skapi.__my_unique_ids);
        assert.deepStrictEqual(buckets, [`${SERVICE_A}/${OWNER}`],
            `expected exactly service A's bucket, got ${JSON.stringify(buckets)}`);
        assert.ok(!skapi.__my_unique_ids[`${SERVICE_B}/${OWNER}`],
            'service B must be untouched');
    });

    await test('same unique_id in two services keeps two INDEPENDENT record ids', async () => {
        skapi.__my_unique_ids = {};
        echoUniqueId = UNIQUE_ID;
        try {
            echoRecordId = 'VQrecordInAxckv';
            await skapi.bulkPostRecords([{
                table: { name: 'files', access_group: 0 }, data: {},
                service: SERVICE_A, owner: OWNER
            }]);
            echoRecordId = 'VQrecordInBxckv';
            await skapi.bulkPostRecords([{
                table: { name: 'files', access_group: 0 }, data: {},
                service: SERVICE_B, owner: OWNER
            }]);
        } finally { echoUniqueId = null; echoRecordId = 'VQechoedRECxckv'; }

        assert.strictEqual(skapi.__my_unique_ids[`${SERVICE_A}/${OWNER}`][UNIQUE_ID], 'VQrecordInAxckv',
            'service A entry must survive service B being written (this is the last-writer-wins bug)');
        assert.strictEqual(skapi.__my_unique_ids[`${SERVICE_B}/${OWNER}`][UNIQUE_ID], 'VQrecordInBxckv',
            'service B entry was written under its own scope');
    });

    await test('after both projects are cached, each post uses ITS OWN record id', async () => {
        // The exact production sequence: project A indexes, project B indexes, then A posts
        // another row. Before the fix A's row went out carrying B's record id.
        skapi.__my_unique_ids = {
            [`${SERVICE_A}/${OWNER}`]: { [UNIQUE_ID]: 'VQrecordInAxckv' },
            [`${SERVICE_B}/${OWNER}`]: { [UNIQUE_ID]: 'VQrecordInBxckv' }
        };
        await skapi.bulkPostRecords([{
            table: { name: 'rows', access_group: 0 }, reference: UNIQUE_ID, data: {},
            service: SERVICE_A, owner: OWNER
        }]);
        assert.strictEqual(lastBulkReference(), 'VQrecordInAxckv');
        await skapi.bulkPostRecords([{
            table: { name: 'rows', access_group: 0 }, reference: UNIQUE_ID, data: {},
            service: SERVICE_B, owner: OWNER
        }]);
        assert.strictEqual(lastBulkReference(), 'VQrecordInBxckv');
    });

    await test('owner is part of the scope, not just service', async () => {
        const OTHER_OWNER = '11111111-2222-3333-4444-555555555555';
        skapi.__my_unique_ids = {};
        await seedViaPost(SERVICE_A, RECORD_IN_A);
        await skapi.bulkPostRecords([{
            table: { name: 'rows', access_group: 0 }, reference: UNIQUE_ID, data: {},
            service: SERVICE_A, owner: OTHER_OWNER
        }]);
        assert.strictEqual(lastBulkReference(), UNIQUE_ID,
            'same service under a different owner is a different tenant');
    });

    await test('with no service named, the instance\'s own scope is used', async () => {
        skapi.__my_unique_ids = {};
        await seedViaPost(SERVICE_A, RECORD_IN_A);
        await skapi.bulkPostRecords([{ table: { name: 'rows', access_group: 0 }, reference: UNIQUE_ID, data: {} }]);
        assert.strictEqual(lastBulkReference(), RECORD_IN_A,
            'an unqualified call belongs to the instance service, which here is A');
    });

    /**
     * Updating a record is refused outright for a public caller, so these tests need a
     * session. Fake one shaped the way getJwtToken reads it (an unexpired id token), which
     * is enough for the request layer without a Cognito round trip.
     */
    async function asLoggedIn(fn) {
        const exp = Math.floor(Date.now() / 1000) + 3600;
        skapi.__user = { user_id: OWNER, access_group: 99 };
        skapi.session = {
            getIdToken: () => ({ getExpiration: () => exp }),
            idToken: { jwtToken: 'test.id.token', payload: { exp } },
            accessToken: { jwtToken: 'test.access.token' },
            refreshToken: { token: 'test.refresh.token' }
        };
        try { return await fn(); }
        finally { skapi.__user = null; skapi.session = null; }
    }

    // The UPDATE path: since 1.7.1 a unique_id may stand in for record_id, resolved from
    // this same cache by a DIFFERENT validator. It is the path updateRecords uses, so it
    // needs its own coverage rather than riding on the `reference` tests.
    await test('update by unique_id resolves inside its own service', async () => {
        skapi.__my_unique_ids = {};
        await seedViaPost(SERVICE_A, RECORD_IN_A);
        await asLoggedIn(() => skapi.bulkPostRecords([{
            record_id: UNIQUE_ID, table: { name: 'rows', access_group: 0 }, data: { a: 1 },
            service: SERVICE_A, owner: OWNER
        }]));
        const post = [...captured].reverse().find(c => c.url.includes('post-record'));
        assert.strictEqual(post.body._is_bulk_[0].record_id, RECORD_IN_A);
    });

    await test('update by unique_id must NOT resolve across services', async () => {
        skapi.__my_unique_ids = {};
        await seedViaPost(SERVICE_A, RECORD_IN_A);
        await asLoggedIn(() => skapi.bulkPostRecords([{
            record_id: UNIQUE_ID, table: { name: 'rows', access_group: 0 }, data: { a: 1 },
            service: SERVICE_B, owner: OWNER
        }]));
        const post = [...captured].reverse().find(c => c.url.includes('post-record'));
        assert.strictEqual(post.body._is_bulk_[0].record_id, UNIQUE_ID,
            'an update in service B must send the unique_id for the backend to resolve, '
            + 'not service A\'s record_id (which would silently UPDATE THE WRONG RECORD if '
            + 'that id happened to exist)');
    });

    await test('getRecords by unique_id does not resolve across services', async () => {
        skapi.__my_unique_ids = {};
        await seedViaPost(SERVICE_A, RECORD_IN_A);
        await skapi.getRecords({ unique_id: UNIQUE_ID, service: SERVICE_B, owner: OWNER });
        const get = [...captured].reverse().find(c => c.url.includes('get-records'));
        assert.ok(get, 'expected a get-records request');
        // An unauthenticated read is a GET, so the params ride in the query string, not
        // the body. Check BOTH, or this passes vacuously against a leaking build.
        const wire = decodeURIComponent(get.url) + ' ' + JSON.stringify(get.body || {});
        assert.ok(!wire.includes(RECORD_IN_A),
            `getRecords in service B must not be rewritten to service A's record_id.\n      wire: ${wire.slice(0, 300)}`);
        assert.ok(wire.includes(UNIQUE_ID),
            `the unique_id must be sent verbatim for the backend to resolve.\n      wire: ${wire.slice(0, 300)}`);
    });

    await test('a backend per-element error survives normalizeRecord', async () => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (url, opt) => {
            if (String(url).includes('post-record')) {
                return jsonResponse([{ error: { code: 'NOT_EXISTS', message: 'Reference "VQx" does not exists.' } }]);
            }
            return realFetch(url, opt);
        };
        try {
            const out = await skapi.bulkPostRecords([{
                table: { name: 'rows', access_group: 0 }, reference: UNIQUE_ID, data: {},
                service: SERVICE_B, owner: OWNER
            }]);
            assert.strictEqual(out.length, 1, 'one element back');
            assert.ok(!out[0].record_id, 'a rejected element still has no record_id');
            assert.ok(out[0].error, 'the backend error must be carried across, not dropped');
            assert.match(out[0].error.message, /does not exists/,
                'the real reason must be readable by the caller');
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    const failed = results.filter(r => r[0] === 'FAIL');
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
})();

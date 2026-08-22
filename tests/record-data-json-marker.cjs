/**
 * The record "data" JSON marker: { __json__: "<text>" }.
 *
 * A record's "data" is arbitrary caller JSON that the backend writes straight into a DynamoDB item
 * attribute, and DynamoDB refuses three shapes of perfectly valid JSON: an empty map key at any
 * depth ("ValidationException: Empty attribute name"), a map key over 65535 UTF-8 bytes, and
 * nesting past 32 levels. Model-written data hits the first one regularly, e.g.
 * { "": "All three frequencies detected", "display": "..." } where a field's key was left empty.
 *
 * Rather than refuse the write, post_record stores such a payload as { __json__: json.dumps(data) }
 * and the SDK parses it back, here. Everything else keeps its native DynamoDB map, so the marker
 * only ever appears on records that could not have been stored at all.
 *
 * The decode is deliberately conservative and mirrors the server's shape test exactly: ONE key,
 * named __json__, holding a STRING. Anything else is an ordinary user value that merely resembles
 * a marker and must come back verbatim -- which is why the server also encodes a caller payload
 * that happens to have that exact shape, so the two can never be confused.
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
// encode_record_data / record_data_is_ddb_storable in
// infra/layer/database_interface/python/database_interface.py.
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

    await test('THE PROOF: data with an empty key round-trips through the marker', async () => {
        const out = await read({ __json__: JSON.stringify(REAL) });
        assert.deepStrictEqual(out.data, REAL);
        assert.strictEqual(out.data.display_examples[1][''], 'All three distress frequencies detected',
            'the empty key itself must survive, it is the whole point');
    });

    await test('the marker is decoded on postRecord responses too, not only reads', async () => {
        const out = await post(REAL, { __json__: JSON.stringify(REAL) });
        assert.deepStrictEqual(out.data, REAL);
    });

    await test('every JSON type survives the round trip', async () => {
        const value = { '': null, a: 1, b: 1.5, c: false, d: [1, 'two', { '': 3 }], e: {}, f: [], g: '' };
        const out = await read({ __json__: JSON.stringify(value) });
        assert.deepStrictEqual(out.data, value);
    });

    await test('non-Latin text survives (the server writes it unescaped)', async () => {
        const value = { '': '한국어 🐰', 'key 이름': 'ok' };
        const out = await read({ __json__: JSON.stringify(value) });
        assert.deepStrictEqual(out.data, value);
    });

    await test('a top-level array is returned as an array, not an object', async () => {
        const value = [{ a: 1 }, { '': 2 }];
        const out = await read({ __json__: JSON.stringify(value) });
        assert.ok(Array.isArray(out.data));
        assert.deepStrictEqual(out.data, value);
    });

    await test('a payload nested deeper than DynamoDB allows round-trips', async () => {
        let value = 'leaf';
        for (let i = 0; i < 40; i++) value = { a: value };
        const out = await read({ __json__: JSON.stringify(value) });
        assert.deepStrictEqual(out.data, value);
    });

    // --- values that only LOOK like a marker --------------------------------------------

    await test('__json__ holding a non-string is an ordinary value, returned verbatim', async () => {
        const value = { __json__: 123 };
        const out = await read(value);
        assert.deepStrictEqual(out.data, value);
    });

    await test('__json__ alongside another key is an ordinary value, returned verbatim', async () => {
        const value = { __json__: '[1,2]', other: 1 };
        const out = await read(value);
        assert.deepStrictEqual(out.data, value);
    });

    await test('__json__ nested deeper is an ordinary value, returned verbatim', async () => {
        const value = { a: { __json__: '[1,2]' } };
        const out = await read(value);
        assert.deepStrictEqual(out.data, value);
    });

    await test('a marker-shaped value that does not parse is returned verbatim', async () => {
        // only the encoder writes this shape, so a record predating it keeps what it stored
        const value = { __json__: 'not json {' };
        const out = await read(value);
        assert.deepStrictEqual(out.data, value);
    });

    // --- the sibling markers must still work --------------------------------------------

    await test('the empty-map and empty-list markers still decode', async () => {
        assert.deepStrictEqual((await read('!D%{}')).data, {});
        assert.deepStrictEqual((await read('!L%[]')).data, []);
    });

    await test('an offload marker with no matching bin file still falls through verbatim', async () => {
        // proves the new decode did not swallow the { __data__: path } case that follows it
        const value = { __data__: '0/0/__data__/__json__.json' };
        const out = await read(value);
        assert.deepStrictEqual(out.data, value);
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
        // decode_record_data(...)), so a file whose contents are { __json__: "..." } is a
        // caller who really stored that shape. Running the __json__ decode over the fetched
        // body would silently unwrap their data. This test is what stops that "fix".
        const value = { __json__: '{"unwrapped":true}' };
        offloadedBody = JSON.stringify(value);
        const out = await read({ __data__: DATA_FILE_PATH });
        assert.deepStrictEqual(out.data, value);
    });

    await test('ordinary data is untouched', async () => {
        const value = { a: 1, b: [1, 2, { c: 'd' }] };
        assert.deepStrictEqual((await read(value)).data, value);
        assert.deepStrictEqual((await read('plain string')).data, 'plain string');
        assert.deepStrictEqual((await read(0)).data, 0);
    });

    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})();

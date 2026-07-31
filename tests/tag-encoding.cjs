/**
 * Wire encoding: every key segment must round-trip losslessly, and the length limit.
 *
 * Started as a tags test, now covers the whole encode/decode contract: table names, tags, index
 * names, index values, the list-endpoint filters, nest-query name fragments, and bin filenames. The
 * one rule behind all of it: a field is escaped on the way out if and only if it is unescaped on the
 * way back, and a field that is never escaped must never be decoded. Every bug below was one side of
 * that pair existing without the other.
 *
 * WHAT I GOT WRONG, recorded so nobody repeats it. A production indexing run showed 41 tags on the
 * wire as "품명 %2F 수량", "G%2FB COWLING", "sheet1%2F2". That looks exactly like an agent inventing
 * percent-escapes to dodge the backend's forbidden-character rule, and I diagnosed it as corruption
 * and started stripping "/" out of tags. It is not corruption: `blockKeyDelimiters` in
 * param_restrictions.ts does NOT block, it ENCODES, and normalizeRecord decodes on the way back. The
 * wire form is the SDK working exactly as designed, and stripping would have destroyed real data.
 * The first test below is the proof, and it is why the stripping was removed.
 *
 * THE LENGTH LIMIT was the real bug. MAX_TAG_LENGTH was 64 while the backend allows 256
 * (validate_tag_value -> validate_key_segment, max_len=256), so the SDK refused legal tags four
 * times shorter than the platform accepts. It is now 256, re-checked AFTER escaping because that is
 * the string the server measures.
 *
 * Run: node ./tests/tag-encoding.cjs
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { Skapi } = require(process.env.SKAPI_BUNDLE || '../dist/skapi.cjs');

const FIXTURES = path.join(__dirname, 'fixtures');
const OWNER = '4d4a36a5-b318-4093-92ae-7cf11feae989';
const SERVICE = 'ap21AAAAAAAAAAAAAAAA';
const RID = 'VQxxxxxxxxxxxxxx';
const BIN_HOST = 'https://cdn.example.com';
const BIN_TABLE = '__bin_fixture__';
// Real filenames a user can create. '100%off.pdf' is the one that used to make decodeURIComponent
// throw URIError, and '50%20off.pdf' the one it used to silently rename to '50 off.pdf'.
const BIN_FILENAMES = ['100%off.pdf', '50%20off.pdf', 'plain.pdf'];

globalThis.FileReader = class FileReader {
    readAsDataURL(blob) {
        blob.arrayBuffer().then(ab => {
            this.result = 'data:application/json;base64,' + Buffer.from(ab).toString('base64');
            if (this.onloadend) this.onloadend();
        }).catch(err => { if (this.onerror) this.onerror(err); });
    }
};

let captured = [];
// Query bodies sent to the list endpoints, so the tests can assert what actually went on the wire.
let capturedQuery = [];
const jsonResponse = o => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

/**
 * Params as they actually went out. Not every endpoint posts a JSON body: getRecords is a GET whose
 * params ride in the query string, each value JSON-encoded, so reading opt.body there throws.
 */
const sentParams = (u, opt) => {
    if (opt && opt.body) return JSON.parse(opt.body);
    const out = {};
    for (const [k, v] of new URL(u).searchParams) {
        try { out[k] = JSON.parse(v); }
        catch { out[k] = v; }
    }
    return out;
};

globalThis.fetch = async (url, opt) => {
    const u = String(url);
    if (u.includes('admin-v1.json')) return new Response(fs.readFileSync(path.join(FIXTURES, 'admin-v1.json')));
    if (u.includes('record-v1.json')) return new Response(fs.readFileSync(path.join(FIXTURES, 'record-v1.json')));
    if (u.includes('post-record')) {
        const body = JSON.parse(opt.body);
        captured.push(body);
        // Echo the record back exactly as the server would store it: composite keys built from the
        // ENCODED segments the client just sent, which is what normalizeRecord has to take apart.
        return jsonResponse(body._is_bulk_.map(c => {
            const rec = {
                rec: RID, srvc: 'x/y', usr: OWNER, ip: '',
                tags: c.tags,
                tbl: `${c.table.name}/svc/00`,
                idx: c.index ? `${c.index.name}!S%${c.index.value}` : undefined
            };
            // post_record copies the whole "source" block into prv_acs verbatim.
            if (c.source) rec.prv_acs = c.source;
            // A record carrying binaries. The storage pipeline never percent-encodes the filename:
            // uploadFiles sends `key + '/' + f.name` raw and the S3 notification stores
            // unquote_plus of the event key, so the name sits in the url exactly as the user typed it.
            if (c.table.name === BIN_TABLE) {
                rec.bin = BIN_FILENAMES.map(n => `${BIN_HOST}/publ/svc/${OWNER}/${OWNER}/records/${RID}/00/bin/0/0/pic/${n}`);
            }
            return rec;
        }));
    }
    // The three list endpoints. Each echoes the query back inside the composite key the server
    // would have matched, so a test can prove the query was escaped AND the response decoded.
    if (u.includes('get-records')) {
        const body = sentParams(u, opt);
        capturedQuery.push(body);
        return jsonResponse({ list: [], endOfList: true });
    }
    if (u.includes('get-table')) {
        const body = sentParams(u, opt);
        capturedQuery.push(body);
        return jsonResponse({ list: [{ tbl: body.table, cnt_rec: 1 }], endOfList: true });
    }
    if (u.includes('get-tag')) {
        const body = sentParams(u, opt);
        capturedQuery.push(body);
        return jsonResponse({ list: [{ tag: `${body.tag}/${body.table}`, cnt_rec: 1 }], endOfList: true });
    }
    if (u.includes('get-index')) {
        const body = sentParams(u, opt);
        capturedQuery.push(body);
        // Mirrors get_index: idx = index + order.value, searched as "<service>/<table>/<idx>".
        const idxSegment = `${body.index || ''}${body.order && body.order.value !== undefined ? body.order.value : ''}`;
        return jsonResponse({ list: [{ idx: `svc/${body.table}/${idxSegment}`, cnt_rec: 1 }], endOfList: true });
    }
    return jsonResponse({ ip: '1.1.1.1', locale: 'KR', service_name: 't', group: 99, opt: {} });
};

const results = [];
async function test(name, fn) {
    captured = [];
    capturedQuery = [];
    try {
        await fn();
        results.push(true);
        console.log(`ok    ${name}`);
    } catch (err) {
        results.push(false);
        console.log(`FAIL  ${name}\n      ${err && err.message}`);
    }
}

const wireTags = () => lastWire().tags;
/** The most recent query body sent to a list/fetch endpoint. */
const capturedRecordQuery = () => capturedQuery[capturedQuery.length - 1];
/** The most recent record put on the wire. `captured` accumulates within one test(). */
const lastWire = () => captured[captured.length - 1]._is_bulk_[0];

(async () => {
    const skapi = new Skapi(SERVICE, OWNER, { autoLogin: false });
    await skapi.__connection;

    const post = tags => skapi.bulkPostRecords([{ table: { name: 't', access_group: 0 }, tags, data: {} }]);

    await test('THE PROOF: / ! * # round-trip losslessly, they are NOT corruption', async () => {
        const sent = ['G/B COWLING', '품명 / 수량', 'a!b', 'c*d', 'e#f', 'plain'];
        const out = await post(sent);
        assert.deepStrictEqual(wireTags(),
            ['G%2FB COWLING', '품명 %2F 수량', 'a%21b', 'c%2Ad', 'e%23f', 'plain'],
            'the wire carries the escaped form, which is what production logs show');
        assert.deepStrictEqual(out[0].tags, sent,
            'and reading the record back returns exactly what the caller wrote');
    });

    await test('a literal %2F written by the caller survives as a literal', async () => {
        // encodeReservedDelimiters escapes "%" to "%25" first precisely so this stays distinguishable
        // from a real "/". Anything that stripped or blanket-decoded tags would collapse the two.
        const out = await post(['already%2Fescaped/real']);
        assert.strictEqual(out[0].tags[0], 'already%2Fescaped/real');
    });

    await test('a tag longer than 64 characters is now ACCEPTED (it was refused)', async () => {
        const long = 'x'.repeat(100);
        const out = await post([long]);
        assert.strictEqual(out[0].tags[0], long, '100 chars is legal for the backend and must be legal here');
    });

    await test('a 256-character tag is accepted', async () => {
        const max = 'y'.repeat(256);
        const out = await post([max]);
        assert.strictEqual(out[0].tags[0], max);
    });

    await test('a 257-character tag is refused', async () => {
        await assert.rejects(() => post(['z'.repeat(257)]), /256 characters/);
    });

    await test('length is measured AFTER escaping, as the server measures it', async () => {
        // 100 slashes escape to 300 characters, which the backend would reject. Catch it here, with
        // a message that explains why, rather than as an opaque server error.
        await assert.rejects(() => post(['/'.repeat(100)]), /count as 3 characters each/);
        // 85 slashes -> 255 characters, still inside the limit.
        const ok = '/'.repeat(85);
        const out = await post([ok]);
        assert.strictEqual(wireTags()[0].length, 255);
        assert.strictEqual(out[0].tags[0], ok);
    });

    await test('control characters are still rejected', async () => {
        await assert.rejects(() => post(['a b']), /control characters/);
        await assert.rejects(() => post(['ab']), /control characters/);
    });

    // --- the other three key-segment limits, all 256 on the platform ---------------------

    const postWith = cfg => skapi.bulkPostRecords([{ table: { name: 't', access_group: 0 }, data: {}, ...cfg }]);

    await test('TABLE NAME: 256 is accepted, 257 refused (was capped at 128)', async () => {
        await postWith({ table: { name: 'x'.repeat(256), access_group: 0 } });
        assert.strictEqual(lastWire().table.name.length, 256);
        await assert.rejects(() => postWith({ table: { name: 'x'.repeat(257), access_group: 0 } }), /256 characters/);
    });

    await test('TABLE NAME: escaping counts toward the limit', async () => {
        await assert.rejects(() => postWith({ table: { name: '/'.repeat(100), access_group: 0 } }),
            /count as 3 characters each/);
    });

    await test('INDEX NAME: 256 is accepted, 257 refused (was capped at 128)', async () => {
        await postWith({ index: { name: 'n'.repeat(256), value: 1 } });
        assert.strictEqual(lastWire().index.name.length, 256);
        // validator.Params wraps the index struct, so the specific "<= 256 characters" reason is
        // replaced by a generic 'is invalid in "index"'. It still rejects, which is what matters here.
        await assert.rejects(() => postWith({ index: { name: 'n'.repeat(257), value: 1 } }));
    });

    await test('INDEX VALUE: 256 accepted, 257 refused, and / is NOT escaped', async () => {
        await postWith({ index: { name: 'n', value: 'v'.repeat(256) } });
        await assert.rejects(() => postWith({ index: { name: 'n', value: 'v'.repeat(257) } }));
        // The platform allows / ! * # in an index VALUE (validate_index_string_value has no
        // forbidden_chars), so unlike a name or a tag it must go out untouched.
        await postWith({ index: { name: 'n', value: 'a/b' } });
        assert.strictEqual(lastWire().index.value, 'a/b');
    });

    // --- the escape was CONDITIONAL, the unescape never was --------------------------------
    //
    // encodeReservedDelimiters only ran when the value ALREADY held a raw / ! * #, while
    // decodeReservedDelimiters always ran. So a value carrying a percent-sequence but no raw
    // delimiter went out untouched and came back decoded: "a%2Fb" read back as "a/b", and
    // "100%25off" read back as "100%off". The '%' -> '%25' pass existed for exactly this, but the
    // gate made it unreachable unless a delimiter happened to share the string. The encode is now
    // unconditional, which is the only form a decoder can invert unambiguously.

    await test('TAG: a percent-sequence with no delimiter round-trips (it used to corrupt)', async () => {
        const sent = ['a%2Fb', 'a%2fb', '100%25off', '50% off', 'a%21b', 'x%23y'];
        const out = await post(sent);
        assert.deepStrictEqual(wireTags(),
            ['a%252Fb', 'a%252fb', '100%2525off', '50%25 off', 'a%2521b', 'x%2523y'],
            'the % must be escaped on the wire, or the read side cannot tell it from a real delimiter');
        assert.deepStrictEqual(out[0].tags, sent);
    });

    await test('TAG: lowercase %2f round-trips (decode is case-insensitive, encode was not)', async () => {
        const out = await post(['a%2fb']);
        assert.strictEqual(out[0].tags[0], 'a%2fb', 'read back as "a/b" before the fix');
    });

    await test('TABLE NAME: a percent-sequence with no delimiter round-trips', async () => {
        for (const name of ['a%2Fb', '100%25off', '50% off']) {
            const out = await postWith({ table: { name, access_group: 0 } });
            assert.strictEqual(out[0].table.name, name);
        }
    });

    await test('INDEX NAME: a percent-sequence with no delimiter round-trips', async () => {
        const out = await postWith({ index: { name: 'a%2Fb', value: 1 } });
        assert.strictEqual(lastWire().index.name, 'a%252Fb');
        assert.strictEqual(out[0].index.name, 'a%2Fb');
    });

    await test('length is now measured after % escaping too', async () => {
        // 246 plain + 10 '%' is 256 raw, but 276 once escaped, which the server would reject.
        await assert.rejects(() => post(['x'.repeat(246) + '%'.repeat(10)]), /count as 3 characters each/);
        // 200 plain + 10 '%' is 220 escaped, comfortably legal.
        const ok = 'x'.repeat(200) + '%'.repeat(10);
        const out = await post([ok]);
        assert.strictEqual(out[0].tags[0], ok);
    });

    // --- index VALUE is raw in BOTH directions ---------------------------------------------
    //
    // It was decoded on read but never encoded on write, so "a%2Fb" came back as "a/b". Escaping it
    // to match is NOT the fix: the platform allows / ! * # in an index value, and values are
    // compared lexicographically for gt/lt/range, so "%2F" would sort nowhere near "/" and silently
    // change every range query. Raw end to end is the only lossless option.

    await test('INDEX VALUE: raw both directions, percent-sequences survive', async () => {
        for (const value of ['a/b', 'a%2Fb', '100%25off', 'a!b']) {
            const out = await postWith({ index: { name: 'n', value } });
            assert.strictEqual(lastWire().index.value, value, 'must go out untouched');
            assert.strictEqual(out[0].index.value, value, 'and must come back untouched');
        }
    });

    // --- the list endpoints escape their filters --------------------------------------------
    //
    // Their responses were decoded but their query params went out raw, so a lookup for a table
    // literally named "a/b" searched for "a/b" while storage held "a%2Fb", and matched nothing.

    await test('getTables escapes the table filter and decodes the response', async () => {
        const res = await skapi.getTables({ table: 'a/b', condition: 'eq' });
        assert.strictEqual(capturedQuery[0].table, 'a%2Fb', 'the query must match the stored form');
        assert.strictEqual(res.list[0].table, 'a/b', 'and the response must come back decoded');
    });

    await test('getTags escapes both filters and decodes the response', async () => {
        const res = await skapi.getTags({ table: 'a/b', tag: 'c#d' });
        assert.strictEqual(capturedQuery[0].table, 'a%2Fb');
        assert.strictEqual(capturedQuery[0].tag, 'c%23d');
        assert.strictEqual(res.list[0].table, 'a/b');
        assert.strictEqual(res.list[0].tag, 'c#d');
    });

    await test('getIndexes escapes the table filter and decodes the response', async () => {
        const res = await skapi.getIndexes({ table: 'a/b', index: 'e*f' });
        assert.strictEqual(capturedQuery[0].table, 'a%2Fb');
        assert.strictEqual(capturedQuery[0].index, 'e%2Af');
        assert.strictEqual(res.list[0].table, 'a/b');
        assert.strictEqual(res.list[0].index, 'e*f');
    });

    await test('the "list everything" idiom still works on the query side', async () => {
        // skapi-mcp builds exactly this: a space or an empty string plus a condition. The query-side
        // validators must allow empty, or every listing call starts throwing "is required".
        await skapi.getTables({ table: ' ', condition: '>' });
        assert.strictEqual(capturedQuery[0].table, ' ');
        await skapi.getTables({ table: '', condition: '>' });
        await skapi.getTags({ table: 't', tag: '', condition: '>' });
    });

    // --- a decode with no matching encode is just as lossy -----------------------------------
    //
    // The same class of bug, found in three more places. Nothing in the upload pipeline ever
    // percent-encodes a bin filename, yet three read paths decoded one.

    await test('BIN: a filename with a bare % is not dropped from record.bin', async () => {
        const out = await postWith({ table: { name: BIN_TABLE, access_group: 0 } });
        const files = out[0].bin.pic || [];
        assert.strictEqual(files.length, 3,
            'decodeURIComponent("100%off.pdf") threw URIError, which the catch turned into a silent drop');
        assert.deepStrictEqual(files.map(f => f.filename), BIN_FILENAMES,
            '"50%20off.pdf" used to come back renamed to "50 off.pdf"');
    });

    await test('BIN: filename agrees with the path it came from', async () => {
        const out = await postWith({ table: { name: BIN_TABLE, access_group: 0 } });
        for (const f of out[0].bin.pic) {
            assert.ok(f.path.endsWith(f.filename),
                `filename ${JSON.stringify(f.filename)} does not match its own path ${JSON.stringify(f.path)}`);
        }
    });

    await test('remove_bin sends the url back exactly as stored', async () => {
        // remove_bin is refused for public users, so fake a session shaped the way getJwtToken
        // reads it (same approach as unique-id-scope.cjs) purely to reach the validator.
        const exp = Math.floor(Date.now() / 1000) + 3600;
        skapi.__user = { user_id: OWNER, access_group: 99 };
        skapi.session = {
            getIdToken: () => ({ getExpiration: () => exp }),
            idToken: { jwtToken: 'test.id.token', payload: { exp } },
            accessToken: { jwtToken: 'test.access.token' },
            refreshToken: { token: 'test.refresh.token' }
        };
        try {
            const url = `${BIN_HOST}/publ/svc/${OWNER}/${OWNER}/records/${RID}/00/bin/0/0/pic/a%2Fb.pdf`;
            await postWith({ table: { name: 't', access_group: 0 }, remove_bin: [url + '?t=sometoken'] });
            assert.deepStrictEqual(lastWire().remove_bin, [url],
                'the "?t=" token is stripped, but the filename must not be decoded or the DELETE matches nothing');
        }
        finally { skapi.__user = null; skapi.session = null; }
    });

    // --- the last escaped-on-write field that was never decoded on read ----------------------

    await test('source.referencing_index_restrictions[].name round-trips', async () => {
        const out = await postWith({
            source: { referencing_index_restrictions: [{ name: 'category/sub', value: 'x' }] }
        });
        const restriction = lastWire().source.referencing_index_restrictions[0];
        assert.strictEqual(restriction.name, 'category%2Fsub', 'the backend rejects a raw / in an index name');
        assert.strictEqual(restriction.value, 'x', 'the value stays raw, like every other index value');
        assert.strictEqual(out[0].source.referencing_index_restrictions[0].name, 'category/sub',
            'it used to come back escaped, and re-saving the record escaped it a second time');
    });

    // --- getIndexes order.value is a NAME fragment when ordering by index_name ---------------

    await test('getIndexes escapes order.value only when ordering by index_name', async () => {
        // get_index builds the key as index + order.value, so here the value is part of the name.
        const res = await skapi.getIndexes({ table: 't', index: 'Band.', order: { by: 'index_name', value: 'Mem/bers' } });
        assert.strictEqual(capturedQuery[0].order.value, 'Mem%2Fbers');
        assert.strictEqual(res.list[0].index, 'Band.Mem/bers',
            'the response decodes, so the query had to escape or the two could never agree');
    });

    await test('getIndexes leaves a non-index_name order.value alone', async () => {
        // "index" has to be a compound parent (trailing '.') whenever "order" is used.
        const lastQuery = () => capturedQuery[capturedQuery.length - 1];
        await skapi.getIndexes({ table: 't', index: 'n.', order: { by: 'average_number', value: 10, condition: '>' } });
        assert.strictEqual(lastQuery().order.value, 10, 'a threshold is not a name fragment');
        await skapi.getIndexes({ table: 't', index: 'n.', order: { by: 'total_number', value: 'a/b' } });
        assert.strictEqual(lastQuery().order.value, 'a/b', 'only index_name concatenates into the key');
    });

    // --- a nest query's "value" is a child NAME, so it escapes like a name -------------------

    await test('nest query escapes index.value, plain queries do not', async () => {
        // Stored as "Band.Rock%2FPop.year", because index NAMES are escaped on write.
        await postWith({ index: { name: 'Band.Rock/Pop.year', value: 2023 } });
        assert.strictEqual(lastWire().index.name, 'Band.Rock%2FPop.year');

        // The nest query addressing that child has to spell it the same way.
        capturedQuery = [];
        await skapi.getRecords({ table: 't', index: { name: 'Band.', value: 'Rock/Pop', condition: '=' } })
            .catch(() => { });
        assert.strictEqual(capturedRecordQuery().index.value, 'Rock%2FPop',
            'sent raw, this searched a range the stored escaped key falls outside of');

        // A normal index query is untouched: values are raw both directions.
        await skapi.getRecords({ table: 't', index: { name: 'plain', value: 'a/b' } }).catch(() => { });
        assert.strictEqual(capturedRecordQuery().index.value, 'a/b');
    });

    await test('nest query escapes index.range too', async () => {
        await skapi.getRecords({
            table: 't',
            index: { name: 'Band.', value: 'Rock/Pop', range: 'Rock/Pop!' }
        }).catch(() => { });
        const idx = capturedRecordQuery().index;
        assert.strictEqual(idx.value, 'Rock%2FPop');
        assert.strictEqual(idx.range, 'Rock%2FPop%21', 'the range bound is a child name segment too');
    });

    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})();

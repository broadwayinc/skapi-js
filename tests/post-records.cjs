/**
 * postRecords(items): several postRecord() calls as one call, with a result per item.
 *
 * Pinned here against a stubbed /post-record that behaves like the record Lambda's
 * `_is_bulk_` branch (runs the records in order, answers {error} for one it refuses and
 * STOPS there):
 *
 *   - each item is { data, config }; what goes on the wire is the config with the data on
 *     it, under `_is_bulk_`, 100 records to a request,
 *   - `list` holds the saved records in input order, `failed` the refused items with their
 *     index, code and message, and list.length + failed.length is the input length,
 *   - the records after a refused one are sent again in the next request, so a refusal
 *     costs one more request, not the rest of the batch,
 *   - an item that fails the local check is reported by index and never sent,
 *   - an item whose data carries a File is refused (files go through uploadFiles()),
 *   - postRecord() itself is untouched: one record, one request, no `_is_bulk_`.
 *
 * Run: node ./tests/post-records.cjs
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const _store = () => {
    const m = new Map();
    return {
        getItem: k => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: k => m.delete(k),
        clear: () => m.clear()
    };
};
globalThis.window = globalThis;
globalThis.addEventListener = () => { };
globalThis.removeEventListener = () => { };
globalThis.navigator = globalThis.navigator || { userAgent: 'node-test' };
globalThis.location = globalThis.location || { origin: 'https://app.example.com', href: 'https://app.example.com/' };
globalThis.alert = undefined;
for (const n of ['HTMLInputElement', 'HTMLFormElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLElement', 'SubmitEvent', 'Event', 'Node']) {
    if (typeof globalThis[n] === 'undefined') {
        globalThis[n] = class { };
    }
}
if (typeof globalThis.FileList === 'undefined') {
    globalThis.FileList = class FileList { };
}
globalThis.FileReader = class FileReader {
    readAsDataURL(blob) {
        blob.arrayBuffer().then(ab => {
            this.result = 'data:application/octet-stream;base64,' + Buffer.from(ab).toString('base64');
            if (this.onloadend) this.onloadend();
            if (this.onload) this.onload();
        }).catch(err => { if (this.onerror) this.onerror(err); });
    }
};
globalThis.sessionStorage = _store();
globalThis.localStorage = _store();
globalThis.document = {
    createElement: () => ({ href: '', click() { }, setAttribute() { }, style: {} }),
    body: { appendChild() { }, removeChild() { } }
};

const { Skapi, SkapiError } = require(process.env.SKAPI_BUNDLE || '../dist/skapi.cjs');

const FIXTURES = path.join(__dirname, 'fixtures');
const OWNER = '4d4a36a5-b318-4093-92ae-7cf11feae989';
const SERVICE = 'ap21AAAAAAAAAAAAAAAA';

const jsonResponse = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

/** Every /post-record body the SDK sent, in order. */
let posted = [];
/** Record numbers (data.n) the stubbed server refuses. */
let refuse = new Map();
let minted = 0;

function rawRecord(item) {
    minted++;
    const id = 'AbCdEfGhIjKlMnOpQ' + String(minted).padStart(3, '0'); // 20 chars: [timestamp][5][4]
    return { rec: id, usr: OWNER, tbl: 'notes/' + SERVICE + '/00', upd: 1700000000000 + minted, ip: '203.0.113.5', data: item.data };
}

globalThis.fetch = async (url, opt) => {
    const u = String(url);
    if (/\/admin-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'admin-v1.json')));
    if (/\/record-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'record-v1.json')));
    if (u.includes('post-record')) {
        const body = JSON.parse(opt.body);
        posted.push(body);
        if (!Array.isArray(body._is_bulk_)) {
            return jsonResponse(rawRecord(body));
        }
        const out = [];
        for (const item of body._is_bulk_) {
            const n = item.data && item.data.n;
            if (refuse.has(n)) {
                out.push({ error: refuse.get(n) });
                break; // the Lambda stops at the first refused record
            }
            out.push(rawRecord(item));
        }
        return jsonResponse(out);
    }
    return jsonResponse({ ip: '127.0.0.1', locale: 'KR', service_name: 'test', group: 99, opt: {} });
};

globalThis.XMLHttpRequest = class XMLHttpRequest {
    constructor() { this.upload = {}; this.status = 0; this._h = {}; this.readyState = 0; }
    open(m, u) { this._m = m; this._u = u; this.readyState = 1; }
    setRequestHeader(k, v) { this._h[k] = v; }
    getResponseHeader() { return null; }
    abort() { }
    send(body) {
        (async () => {
            try {
                const init = { method: this._m, headers: this._h };
                if (body && this._m !== 'GET' && this._m !== 'HEAD') init.body = body;
                const r = await fetch(this._u, init);
                this.status = r.status;
                this.responseText = await r.text();
                this.response = this.responseText;
                this.readyState = 4;
                this.onload && this.onload();
            }
            catch (e) {
                this.readyState = 4;
                this.onerror && this.onerror(e);
            }
        })();
    }
};

let skapi = null;
async function getSkapi() {
    if (!skapi) {
        skapi = new Skapi(SERVICE, OWNER, { autoLogin: false });
        await skapi.__connection;
    }
    return skapi;
}

const items = n => Array.from({ length: n }, (_, i) => ({ data: { n: i, title: 'note ' + i }, config: { table: { name: 'notes', access_group: 'public' } } }));

let pass = 0;
let fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

async function rejected(fn) {
    try { await fn(); } catch (err) { return err; }
    throw new Error('expected a rejection, got none');
}

test('three items are one request with three records under _is_bulk_, and resolve as list in order with nothing failed', async () => {
    const s = await getSkapi();
    const r = await s.postRecords(items(3));
    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0]._is_bulk_.length, 3);
    assert.deepStrictEqual(posted[0]._is_bulk_[1].data, { n: 1, title: 'note 1' });
    assert.strictEqual(posted[0]._is_bulk_[1].table.name, 'notes');
    assert.strictEqual(r.list.length, 3);
    assert.deepStrictEqual(r.failed, []);
    assert.deepStrictEqual(r.list.map(rec => rec.data.n), [0, 1, 2]);
    assert.ok(r.list.every(rec => typeof rec.record_id === 'string' && rec.record_id.length === 20));
    assert.strictEqual(r.list[0].table.name, 'notes');
});

test('250 items are three requests of 100, 100 and 50', async () => {
    const s = await getSkapi();
    const r = await s.postRecords(items(250));
    assert.deepStrictEqual(posted.map(p => p._is_bulk_.length), [100, 100, 50]);
    assert.strictEqual(r.list.length, 250);
    assert.deepStrictEqual(r.failed, []);
    assert.deepStrictEqual(r.list.map(rec => rec.data.n).slice(95, 105), [95, 96, 97, 98, 99, 100, 101, 102, 103, 104]);
});

test('a record the server refuses is in failed by index with its code and message; the records after it are sent again and saved', async () => {
    const s = await getSkapi();
    refuse.set(2, { code: 'NOT_EXISTS', message: 'Reference "missing" does not exists.' });
    const r = await s.postRecords(items(6));
    assert.deepStrictEqual(posted.map(p => p._is_bulk_.map(i => i.data.n)), [[0, 1, 2, 3, 4, 5], [3, 4, 5]]);
    assert.deepStrictEqual(r.list.map(rec => rec.data.n), [0, 1, 3, 4, 5]);
    assert.deepStrictEqual(r.failed, [{ index: 2, code: 'NOT_EXISTS', message: 'Reference "missing" does not exists.' }]);
    assert.strictEqual(r.list.length + r.failed.length, 6);
});

test('several refusals in one chunk each cost one more request, and every item is accounted for', async () => {
    const s = await getSkapi();
    refuse.set(1, { code: 'INVALID_REQUEST', message: 'one' });
    refuse.set(4, { code: 'INVALID_REQUEST', message: 'four' });
    const r = await s.postRecords(items(6));
    assert.strictEqual(posted.length, 3);
    assert.deepStrictEqual(r.failed.map(f => f.index), [1, 4]);
    assert.deepStrictEqual(r.list.map(rec => rec.data.n), [0, 2, 3, 5]);
});

test('an item that fails the local check is reported by index and never sent, the others are posted', async () => {
    const s = await getSkapi();
    const list = items(4);
    list[1] = { data: { n: 1 } };                                  // no config
    list[2] = { data: { n: 2 }, config: { table: { name: '' } } }; // refused by the same check postRecord() runs
    const r = await s.postRecords(list);
    assert.strictEqual(posted.length, 1);
    assert.deepStrictEqual(posted[0]._is_bulk_.map(i => i.data.n), [0, 3]);
    assert.deepStrictEqual(r.failed.map(f => f.index), [1, 2]);
    assert.strictEqual(r.failed[0].code, 'INVALID_PARAMETER');
    assert.strictEqual(r.failed[0].message, '"items[1].config" is required.');
    assert.strictEqual(r.failed[1].code, 'INVALID_PARAMETER');
    assert.deepStrictEqual(r.list.map(rec => rec.data.n), [0, 3]);
});

test('an item whose data is a form with a File is refused: files go through uploadFiles()', async () => {
    const s = await getSkapi();
    const list = items(2);
    const form = new FormData();
    form.append('n', '0');
    form.append('attachment', new File(['x'], 'x.txt'));
    list[0].data = form;
    const r = await s.postRecords(list);
    assert.deepStrictEqual(r.failed.map(f => f.index), [0]);
    assert.ok(/does not attach files/.test(r.failed[0].message));
    assert.deepStrictEqual(posted[0]._is_bulk_.map(i => i.data.n), [1]);
});

test('config.data wins over data, and an item with neither sends no data key', async () => {
    const s = await getSkapi();
    const r = await s.postRecords([
        { data: { n: 0, from: 'data' }, config: { table: { name: 'notes', access_group: 'public' }, data: { n: 0, from: 'config' } } },
        { config: { table: { name: 'notes', access_group: 'public' }, tags: ['x'] } },
    ]);
    assert.strictEqual(posted.length, 1, 'failed: ' + JSON.stringify(r.failed));
    assert.strictEqual(posted[0]._is_bulk_[0].data.from, 'config');
    assert.ok(!('data' in posted[0]._is_bulk_[1]));
    assert.strictEqual(r.list.length, 2);
});

test('the input is checked before anything is sent', async () => {
    const s = await getSkapi();
    for (const bad of [undefined, null, [], {}, 'x']) {
        const err = await rejected(() => s.postRecords(bad));
        assert.strictEqual(err.code, 'INVALID_PARAMETER');
        assert.strictEqual(err.message, '"items" should be a non-empty array.');
    }
    assert.strictEqual(posted.length, 0);
});

test('postRecord() is unchanged: one record, one request, no _is_bulk_', async () => {
    const s = await getSkapi();
    const rec = await s.postRecord({ n: 7 }, { table: { name: 'notes', access_group: 'public' } });
    assert.strictEqual(posted.length, 1);
    assert.ok(!('_is_bulk_' in posted[0]));
    assert.deepStrictEqual(rec.data, { n: 7 });
    assert.strictEqual(rec.record_id.length, 20);
});

(async () => {
    for (const [name, fn] of tests) {
        posted = [];
        refuse = new Map();
        try {
            await fn();
            pass++;
            console.log('  ok   ' + name);
        }
        catch (err) {
            fail++;
            console.log('  FAIL ' + name);
            console.log('       ' + (err && err.stack || err).toString().split('\n').join('\n       '));
        }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();

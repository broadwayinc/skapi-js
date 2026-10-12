/**
 * The 429 retry of every request is bounded.
 *
 * A 429 with Retry-After used to be retried for as long as the server kept answering 429:
 * no cap, so a throttled endpoint held the caller for ever. Pinned here against a stubbed
 * gateway, through skapi.mock() (a plain request, nothing else in the way):
 *
 *   - a 429 with Retry-After that never clears is retried 6 times, then the request
 *     rejects with TOO_MANY_REQUESTS and a message naming the endpoint,
 *   - a 429 that clears is retried and the request resolves,
 *   - a 429 without Retry-After still rejects at once, as before.
 *
 * Run: node ./tests/retry-429.cjs
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

/** What each request to /mock is answered with, in order: { status, body, headers }. */
let plan = [];
let hits = [];

globalThis.fetch = async (url, opt) => {
    const u = String(url);
    if (/\/admin-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'admin-v1.json')));
    if (/\/record-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'record-v1.json')));
    return new Response(JSON.stringify({ ip: '127.0.0.1', locale: 'KR', service_name: 'test', group: 99, opt: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
};

globalThis.XMLHttpRequest = class XMLHttpRequest {
    constructor() { this.upload = {}; this.status = 0; this._h = {}; this.readyState = 0; this._rh = {}; }
    open(m, u) { this._m = m; this._u = u; this.readyState = 1; }
    setRequestHeader(k, v) { this._h[k] = v; }
    getResponseHeader(k) { return this._rh[k] || null; }
    abort() { }
    send(body) {
        if (this._u.includes('/mock')) {
            hits.push(this._u);
            const step = plan.shift() || { status: 200, body: JSON.stringify({ ok: true }) };
            setTimeout(() => {
                this.status = step.status;
                this.responseText = step.body || '';
                this.response = this.responseText;
                this._rh = step.headers || {};
                this.readyState = 4;
                this.onload && this.onload();
            }, 0);
            return;
        }
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

const RATE_LIMITED = { status: 429, body: 'Too Many Requests', headers: { 'Retry-After': '0.01' } };

let skapi = null;
async function getSkapi() {
    if (!skapi) {
        skapi = new Skapi(SERVICE, OWNER, { autoLogin: false });
        await skapi.__connection;
    }
    return skapi;
}

let pass = 0;
let fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
let nonce = 0;

async function rejected(fn) {
    try { await fn(); } catch (err) { return err; }
    throw new Error('expected a rejection, got none');
}

test('a 429 with Retry-After that never clears is retried 6 times, then rejects with TOO_MANY_REQUESTS naming the endpoint', async () => {
    const s = await getSkapi();
    plan = Array(20).fill(RATE_LIMITED);
    const started = Date.now();
    const err = await rejected(() => s.mock({ nonce: ++nonce }));
    assert.ok(Date.now() - started < 5000, 'bounded');
    assert.ok(err instanceof SkapiError);
    assert.strictEqual(err.code, 'TOO_MANY_REQUESTS');
    assert.ok(/^Too many requests: "https:\/\/.*\/mock" still answered 429 after 6 retries\.$/.test(err.message), err.message);
    assert.strictEqual(hits.length, 7, 'one try and six retries');
});

test('a 429 that clears is retried and the request resolves', async () => {
    const s = await getSkapi();
    plan = [RATE_LIMITED, RATE_LIMITED, { status: 200, body: JSON.stringify({ ok: 'after two' }) }];
    const r = await s.mock({ nonce: ++nonce });
    assert.deepStrictEqual(r, { ok: 'after two' });
    assert.strictEqual(hits.length, 3);
});

test('a 429 without Retry-After still rejects at once, as before', async () => {
    const s = await getSkapi();
    plan = [{ status: 429, body: 'Too Many Requests' }];
    const err = await rejected(() => s.mock({ nonce: ++nonce }));
    // request() has always wrapped the bare rejection into the method's own error; the text is the same.
    assert.ok(/Too many requests$/.test(err && err.message || String(err)), String(err));
    assert.strictEqual(hits.length, 1, 'no retry without Retry-After');
});

(async () => {
    for (const [name, fn] of tests) {
        plan = [];
        hits = [];
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

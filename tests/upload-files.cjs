/**
 * uploadFiles(): per-file failures are REPORTED, and a file can be given a time limit.
 *
 * Storage answers each file's POST on its own, and a refused POST used to leave
 * nothing behind but the File in `failed`: no code, no message, so a file that
 * "would not upload" could not be told apart from a network blip, and a caller
 * that only looked at the resolved promise took the whole batch as stored. And
 * an XHR with no timeout waits for as long as the browser keeps the socket open.
 * So, pinned here with storage stubbed:
 *
 *   - the result still has `completed`, `failed` and `bin_endpoints` exactly as
 *     before, and gains `errors`: one entry per failed file, in order, with the
 *     File, its name and a SkapiError whose `code` is the storage code
 *     ('AccessDenied' ...) or 'NETWORK_ERROR' / 'TIMEOUT' / 'ABORTED',
 *   - the call RESOLVES on a failed file by default, and the next file is sent,
 *   - `throwOnFileError` rejects at the first failed file with that error, and
 *     the files after it are never sent,
 *   - `timeout` is put on the XHR, a file that does not finish in time is counted
 *     failed with code 'TIMEOUT' and the next file is sent; with no `timeout` the
 *     XHR has none,
 *   - a `timeout` that is not a number of milliseconds is refused before any byte
 *     moves.
 *
 * Run: node ./tests/upload-files.cjs
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

/* ------------------------------------------------------------------ *
 * A browser, as far as the SDK is concerned. MUST run before the bundle is
 * required: the SDK decides once, at module load, whether it is in one.
 * ------------------------------------------------------------------ */
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
const BUCKET = 'https://bucket.example.test/';

const jsonResponse = o => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

/** Signed-url requests the SDK made, in order. */
let signed = [];

globalThis.fetch = async (url, opt) => {
    const u = String(url);
    if (/\/admin-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'admin-v1.json')));
    if (/\/record-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'record-v1.json')));
    if (u.includes('get-signed-url')) {
        let body = null;
        try { body = JSON.parse(opt && opt.body); } catch (e) { body = opt && opt.body; }
        signed.push(body);
        return jsonResponse({ fields: { key: 'k', policy: 'p' }, url: BUCKET, cdn: 'https://cdn.example.test/' + signed.length });
    }
    return jsonResponse({ ip: '127.0.0.1', locale: 'KR', service_name: 'test', group: 99, opt: {} });
};

/**
 * Storage. `bucketPlan` is what each POST to the bucket is answered with, in
 * order: { status, body }, { networkError: true }, or { hang: true } (storage
 * never answers, so only a timeout can end the request). `bucketPosts` records
 * every POST with the timeout the SDK put on its XHR.
 */
let bucketPlan = [];
let bucketPosts = [];

globalThis.XMLHttpRequest = class XMLHttpRequest {
    constructor() { this.upload = {}; this.status = 0; this._h = {}; this.readyState = 0; this.timeout = 0; }
    open(m, u) { this._m = m; this._u = u; this.readyState = 1; }
    setRequestHeader(k, v) { this._h[k] = v; }
    getResponseHeader(k) { return (this._rh && this._rh[k]) || null; }
    abort() {
        if (this._pending) { clearTimeout(this._pending); this._pending = null; }
        this.readyState = 4;
        this.onabort && this.onabort();
    }
    send(body) {
        if (this._u === BUCKET) {
            const step = bucketPlan.shift() || { status: 204 };
            bucketPosts.push({ timeout: this.timeout, step });
            if (step.hang) {
                if (this.timeout > 0) {
                    this._pending = setTimeout(() => {
                        this._pending = null;
                        this.readyState = 4;
                        this.ontimeout && this.ontimeout();
                    }, this.timeout);
                }
                return;
            }
            setTimeout(() => {
                this.readyState = 4;
                if (step.networkError) {
                    this.onerror && this.onerror();
                    return;
                }
                this.status = step.status;
                this.responseText = step.body || '';
                this.response = this.responseText;
                this._rh = step.headers || {};
                this.onload && this.onload();
            }, 0);
            return;
        }
        // Everything else funnels into the mocked fetch above.
        (async () => {
            try {
                const init = { method: this._m, headers: this._h };
                if (body && this._m !== 'GET' && this._m !== 'HEAD') init.body = body;
                const r = await fetch(this._u, init);
                this.status = r.status;
                this.statusText = r.statusText;
                this.responseURL = r.url;
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

const ACCESS_DENIED = '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message><RequestId>r</RequestId></Error>';
const TOO_LARGE = '<?xml version="1.0" encoding="UTF-8"?><Error><Code>EntityTooLarge</Code><Message>Your proposed upload exceeds the maximum allowed size</Message></Error>';

function formOf(...names) {
    const fd = new FormData();
    for (const n of names) fd.append('doc', new File(['bytes of ' + n], n, { type: 'text/plain' }));
    return fd;
}
const names = files => files.map(f => f.name);

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */
let pass = 0;
let fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

async function rejected(fn) {
    try {
        await fn();
    }
    catch (err) {
        return err;
    }
    throw new Error('expected a rejection, got none');
}

/* ------------------------------------------------------------------ *
 * The result
 * ------------------------------------------------------------------ */

test('a file storage refuses is in `failed` AND in `errors` with the storage code, the call resolves, and the next file is sent', async () => {
    const s = await getSkapi();
    bucketPlan = [{ status: 204 }, { status: 403, body: ACCESS_DENIED }, { status: 204 }];
    const r = await s.uploadFiles(formOf('one.txt', 'two.txt', 'three.txt'), { record_id: 'rec1' });

    assert.deepStrictEqual(names(r.completed), ['one.txt', 'three.txt']);
    assert.deepStrictEqual(names(r.failed), ['two.txt']);
    assert.strictEqual(r.bin_endpoints.length, 3, 'bin_endpoints is one per file, as before');
    assert.strictEqual(r.errors.length, 1);
    assert.strictEqual(r.errors[0].file, r.failed[0], 'the same File object as in failed');
    assert.strictEqual(r.errors[0].name, 'two.txt');
    assert.ok(r.errors[0].error instanceof SkapiError);
    assert.strictEqual(r.errors[0].error.code, 'AccessDenied');
    assert.strictEqual(r.errors[0].error.message, 'Access Denied');
    assert.strictEqual(r.errors[0].error.cause, ACCESS_DENIED, 'the raw body stays on cause');
    assert.strictEqual(bucketPosts.length, 3, 'every file was sent');
    for (const p of bucketPosts) assert.strictEqual(p.timeout, 0, 'no timeout on the XHR by default');
});

test('every file stored: `errors` is empty', async () => {
    const s = await getSkapi();
    bucketPlan = [{ status: 204 }, { status: 204 }];
    const r = await s.uploadFiles(formOf('a.txt', 'b.txt'), { record_id: 'rec1' });
    assert.deepStrictEqual(names(r.completed), ['a.txt', 'b.txt']);
    assert.deepStrictEqual(r.failed, []);
    assert.deepStrictEqual(r.errors, []);
});

test('a transport failure is reported as NETWORK_ERROR', async () => {
    const s = await getSkapi();
    bucketPlan = [{ networkError: true }, { status: 204 }];
    const r = await s.uploadFiles(formOf('a.txt', 'b.txt'), { record_id: 'rec1' });
    assert.deepStrictEqual(names(r.failed), ['a.txt']);
    assert.deepStrictEqual(names(r.completed), ['b.txt']);
    assert.strictEqual(r.errors[0].error.code, 'NETWORK_ERROR');
    assert.strictEqual(r.errors[0].error.message, 'Network error');
});

test('a refusal with no XML code is still a SkapiError, with UPLOAD_FAILED', async () => {
    const s = await getSkapi();
    bucketPlan = [{ status: 500, body: 'storage is having a moment' }];
    const r = await s.uploadFiles(formOf('a.txt'), { record_id: 'rec1' });
    assert.strictEqual(r.errors[0].error.code, 'UPLOAD_FAILED');
    assert.strictEqual(r.errors[0].error.message, 'storage is having a moment');
});

/* ------------------------------------------------------------------ *
 * throwOnFileError
 * ------------------------------------------------------------------ */

test('throwOnFileError rejects at the first refused file with its error, and the files after it are never sent', async () => {
    const s = await getSkapi();
    bucketPlan = [{ status: 204 }, { status: 400, body: TOO_LARGE }, { status: 204 }];
    const err = await rejected(() => s.uploadFiles(formOf('one.txt', 'two.txt', 'three.txt'), { record_id: 'rec1', throwOnFileError: true }));
    assert.ok(err instanceof SkapiError);
    assert.strictEqual(err.code, 'EntityTooLarge');
    assert.strictEqual(err.message, 'Your proposed upload exceeds the maximum allowed size');
    assert.strictEqual(bucketPosts.length, 2, 'the third file was not sent');
});

test('throwOnFileError with nothing refused resolves as usual', async () => {
    const s = await getSkapi();
    bucketPlan = [{ status: 204 }];
    const r = await s.uploadFiles(formOf('a.txt'), { record_id: 'rec1', throwOnFileError: true });
    assert.deepStrictEqual(names(r.completed), ['a.txt']);
    assert.deepStrictEqual(r.errors, []);
});

/* ------------------------------------------------------------------ *
 * timeout
 * ------------------------------------------------------------------ */

test('timeout is put on the XHR; a file that does not finish in time is failed with TIMEOUT and the next file is sent', async () => {
    const s = await getSkapi();
    bucketPlan = [{ hang: true }, { status: 204 }];
    const started = Date.now();
    const r = await s.uploadFiles(formOf('slow.txt', 'quick.txt'), { record_id: 'rec1', timeout: 40 });
    assert.ok(Date.now() - started < 2000, 'the stalled file did not hold the call');
    assert.deepStrictEqual(names(r.failed), ['slow.txt']);
    assert.deepStrictEqual(names(r.completed), ['quick.txt']);
    assert.strictEqual(r.errors[0].error.code, 'TIMEOUT');
    assert.strictEqual(r.errors[0].error.message, 'Upload timeout: "slow.txt" was not finished within 40 ms.');
    assert.strictEqual(bucketPosts[0].timeout, 40);
    assert.strictEqual(bucketPosts[1].timeout, 40, 'every file gets the full time');
});

test('timeout together with throwOnFileError rejects with the TIMEOUT error', async () => {
    const s = await getSkapi();
    bucketPlan = [{ hang: true }, { status: 204 }];
    const err = await rejected(() => s.uploadFiles(formOf('slow.txt', 'quick.txt'), { record_id: 'rec1', timeout: 40, throwOnFileError: true }));
    assert.strictEqual(err.code, 'TIMEOUT');
    assert.strictEqual(bucketPosts.length, 1);
});

test('timeout: 0 means no limit, the same as leaving it out', async () => {
    const s = await getSkapi();
    bucketPlan = [{ status: 204 }];
    await s.uploadFiles(formOf('a.txt'), { record_id: 'rec1', timeout: 0 });
    assert.strictEqual(bucketPosts[0].timeout, 0);
});

test('a timeout that is not a number of milliseconds is refused before anything is sent', async () => {
    const s = await getSkapi();
    for (const bad of [-1, 'soon', NaN, Infinity, {}]) {
        bucketPlan = [{ status: 204 }];
        const err = await rejected(() => s.uploadFiles(formOf('a.txt'), { record_id: 'rec1', timeout: bad }));
        assert.strictEqual(err.code, 'INVALID_PARAMETER', `timeout ${String(bad)}`);
        assert.strictEqual(err.message, '"timeout" should be a number of milliseconds, 0 or more.');
    }
    assert.strictEqual(bucketPosts.length, 0);
    assert.strictEqual(signed.length, 0, 'no signed url was asked for');
});

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */
(async () => {
    for (const [name, fn] of tests) {
        signed = [];
        bucketPlan = [];
        bucketPosts = [];
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

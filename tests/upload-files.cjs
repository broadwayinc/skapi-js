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
 *     moves,
 *   - with five files or more the permits come from ONE /get-signed-urls request (100 to
 *     a request), with fewer from one /get-signed-url request per file as before; a region
 *     that answers 404, 501 or the gateway's 403 for the bulk route sends the instance back
 *     to one permit per file, for good; a file the server refuses a permit for is in
 *     `failed` and `errors` with the server's code and an empty endpoint slot, and the
 *     others are still stored,
 *   - a storage POST that keeps answering 429 with Retry-After is retried 6 times and then
 *     counted failed with TOO_MANY_REQUESTS naming the file, never retried for ever.
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
/** Bulk permit requests (/get-signed-urls) the SDK made, in order: the parsed bodies. */
let bulkSigned = [];
/**
 * What each bulk permit request is answered with, in order: {} signs every file,
 * { failed: [{ index, code, message }] } refuses those files, { missing: 403 | 404 | 501 }
 * answers the way a region without the route does.
 */
let bulkPlan = [];
let cdnCounter = 0;

globalThis.fetch = async (url, opt) => {
    const u = String(url);
    if (/\/admin-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'admin-v1.json')));
    if (/\/record-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'record-v1.json')));
    if (u.includes('get-signed-urls')) {
        let body = null;
        try { body = JSON.parse(opt && opt.body); } catch (e) { body = opt && opt.body; }
        bulkSigned.push(body);
        const step = bulkPlan.shift() || {};
        if (step.missing === 403) return new Response(JSON.stringify({ message: 'Missing Authentication Token' }), { status: 403, headers: { 'content-type': 'application/json' } });
        if (step.missing === 404) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: { 'content-type': 'application/json' } });
        if (step.missing === 501) return new Response('Not Implemented', { status: 501, headers: { 'content-type': 'text/plain' } });
        const failed = step.failed || [];
        const refused = new Set(failed.map(f => f.index));
        const list = body.files.map((f, i) => refused.has(i) ? null : { fields: { key: 'k' + i, policy: 'p' }, url: BUCKET, cdn: 'https://cdn.example.test/bulk' + (++cdnCounter) });
        return jsonResponse({ list, failed });
    }
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

/** A new instance: the "no bulk route here" memory is per instance. */
async function freshSkapi() {
    const s = new Skapi(SERVICE, OWNER, { autoLogin: false });
    await s.__connection;
    return s;
}

function formOfMany(n) {
    const fd = new FormData();
    for (let i = 0; i < n; i++) fd.append('doc', new File(['bytes ' + i], 'f' + i + '.txt', { type: 'text/plain' }));
    return fd;
}

const RATE_LIMITED = { status: 429, headers: { 'Retry-After': '0.01' } };

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
 * Bulk permits
 * ------------------------------------------------------------------ */

test('five files ask for their permits in ONE request to get-signed-urls, none to get-signed-url, and are stored as before', async () => {
    const s = await getSkapi();
    const r = await s.uploadFiles(formOfMany(5), { record_id: 'rec1' });
    assert.strictEqual(bulkSigned.length, 1);
    assert.strictEqual(signed.length, 0);
    const body = bulkSigned[0];
    assert.strictEqual(body.request, 'post');
    assert.strictEqual(body.id, 'rec1');
    assert.ok(typeof body.reserved_key === 'string' && body.reserved_key.length > 0);
    assert.strictEqual(body.files.length, 5);
    assert.deepStrictEqual(Object.keys(body.files[0]).sort(), ['contentType', 'key', 'sizeKey']);
    assert.ok(body.files[2].key.endsWith('/f2.txt'));
    assert.strictEqual(body.files[2].contentType, 'text/plain');
    assert.deepStrictEqual(names(r.completed), ['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt']);
    assert.deepStrictEqual(r.failed, []);
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.bin_endpoints.length, 5);
    assert.ok(r.bin_endpoints.every(e => e.startsWith('https://cdn.example.test/bulk')));
    assert.strictEqual(bucketPosts.length, 5, 'the files still go up one by one');
});

test('four files keep one permit request per file', async () => {
    const s = await getSkapi();
    const r = await s.uploadFiles(formOfMany(4), { record_id: 'rec1' });
    assert.strictEqual(bulkSigned.length, 0);
    assert.strictEqual(signed.length, 4);
    assert.strictEqual(r.completed.length, 4);
});

test('250 files are three permit requests of 100, 100 and 50', async () => {
    const s = await getSkapi();
    const r = await s.uploadFiles(formOfMany(250), { record_id: 'rec1' });
    assert.deepStrictEqual(bulkSigned.map(b => b.files.length), [100, 100, 50]);
    assert.strictEqual(signed.length, 0);
    assert.strictEqual(r.completed.length, 250);
    assert.strictEqual(r.bin_endpoints.length, 250);
    assert.strictEqual(bucketPosts.length, 250);
});

test('a file the server refuses a permit for is failed with the server code, keeps an empty endpoint slot, and the others are stored', async () => {
    const s = await getSkapi();
    bulkPlan = [{ failed: [{ index: 1, code: 'INVALID_REQUEST', message: 'Single record cannot hold more than 100 binary files.' }] }];
    const r = await s.uploadFiles(formOfMany(5), { record_id: 'rec1' });
    assert.deepStrictEqual(names(r.completed), ['f0.txt', 'f2.txt', 'f3.txt', 'f4.txt']);
    assert.deepStrictEqual(names(r.failed), ['f1.txt']);
    assert.strictEqual(r.errors.length, 1);
    assert.strictEqual(r.errors[0].name, 'f1.txt');
    assert.ok(r.errors[0].error instanceof SkapiError);
    assert.strictEqual(r.errors[0].error.code, 'INVALID_REQUEST');
    assert.strictEqual(r.errors[0].error.message, 'Single record cannot hold more than 100 binary files.');
    assert.strictEqual(r.bin_endpoints.length, 5);
    assert.strictEqual(r.bin_endpoints[1], '');
    assert.strictEqual(bucketPosts.length, 4, 'the refused file was never posted');
});

test('throwOnFileError rejects at a refused permit with the server error, and the files after it are not sent', async () => {
    const s = await getSkapi();
    bulkPlan = [{ failed: [{ index: 2, code: 'EXISTS', message: 'File already exists.' }] }];
    const err = await rejected(() => s.uploadFiles(formOfMany(5), { record_id: 'rec1', throwOnFileError: true }));
    assert.strictEqual(err.code, 'EXISTS');
    assert.strictEqual(err.message, 'File already exists.');
    assert.strictEqual(bucketPosts.length, 2);
});

test('a region without the bulk route (403 Missing Authentication Token) falls back to one permit per file, and the instance never asks again', async () => {
    const s = await freshSkapi();
    bulkPlan = [{ missing: 403 }];
    const r = await s.uploadFiles(formOfMany(5), { record_id: 'rec1' });
    assert.strictEqual(bulkSigned.length, 1, 'asked once');
    assert.strictEqual(signed.length, 5, 'then one permit per file');
    assert.deepStrictEqual(names(r.completed), ['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt']);
    assert.strictEqual(r.bin_endpoints.length, 5);
    assert.ok(r.bin_endpoints.every(e => e.startsWith('https://cdn.example.test/')));

    const again = await s.uploadFiles(formOfMany(6), { record_id: 'rec1' });
    assert.strictEqual(bulkSigned.length, 1, 'not asked a second time on this instance');
    assert.strictEqual(signed.length, 11);
    assert.strictEqual(again.completed.length, 6);
});

test('a 404 and a plain 501 for the bulk route fall back the same way', async () => {
    for (const missing of [404, 501]) {
        const s = await freshSkapi();
        bulkPlan = [{ missing }];
        signed = [];
        bulkSigned = [];
        bucketPlan = [];
        const r = await s.uploadFiles(formOfMany(5), { record_id: 'rec1' });
        assert.strictEqual(bulkSigned.length, 1, String(missing));
        assert.strictEqual(signed.length, 5, String(missing));
        assert.strictEqual(r.completed.length, 5, String(missing));
    }
});

test('any other failure of the bulk permit request rejects the call, as a failed single permit request always has', async () => {
    const s = await freshSkapi();
    globalThis.__bulkOverride = true;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opt) => {
        if (String(url).includes('get-signed-urls')) {
            return new Response(JSON.stringify({ message: 'Service has exceeded cloud storage limit.', code: 'EXCEED_LIMIT' }), { status: 400, headers: { 'content-type': 'application/json' } });
        }
        return realFetch(url, opt);
    };
    try {
        const err = await rejected(() => s.uploadFiles(formOfMany(5), { record_id: 'rec1' }));
        assert.strictEqual(err.code, 'EXCEED_LIMIT');
        assert.strictEqual(bucketPosts.length, 0);
    }
    finally {
        globalThis.fetch = realFetch;
    }
});

/* ------------------------------------------------------------------ *
 * 429 on the storage POST is bounded
 * ------------------------------------------------------------------ */

test('a storage POST that keeps answering 429 with Retry-After is retried 6 times, then failed with TOO_MANY_REQUESTS naming the file', async () => {
    const s = await getSkapi();
    bucketPlan = Array(12).fill(RATE_LIMITED);
    const started = Date.now();
    const r = await s.uploadFiles(formOf('slow.txt'), { record_id: 'rec1' });
    assert.ok(Date.now() - started < 5000, 'bounded');
    assert.deepStrictEqual(names(r.failed), ['slow.txt']);
    assert.strictEqual(r.errors[0].error.code, 'TOO_MANY_REQUESTS');
    assert.strictEqual(r.errors[0].error.message, `Too many requests: the upload of "slow.txt" to "${BUCKET}" still answered 429 after 6 retries.`);
    assert.strictEqual(bucketPosts.length, 7, 'one try and six retries');
});

test('a 429 that clears is retried and the file is stored', async () => {
    const s = await getSkapi();
    bucketPlan = [RATE_LIMITED, RATE_LIMITED, { status: 204 }];
    const r = await s.uploadFiles(formOf('a.txt'), { record_id: 'rec1' });
    assert.deepStrictEqual(names(r.completed), ['a.txt']);
    assert.strictEqual(bucketPosts.length, 3);
});

test('a 429 without Retry-After still fails at once, as before', async () => {
    const s = await getSkapi();
    bucketPlan = [{ status: 429 }];
    const r = await s.uploadFiles(formOf('a.txt'), { record_id: 'rec1' });
    assert.strictEqual(r.errors[0].error.code, 'TOO_MANY_REQUESTS');
    assert.strictEqual(r.errors[0].error.message, 'Too many requests');
    assert.strictEqual(bucketPosts.length, 1);
});

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */
(async () => {
    for (const [name, fn] of tests) {
        signed = [];
        bulkSigned = [];
        bulkPlan = [];
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

/**
 * forwardRequest(form, options): what actually goes on the wire.
 *
 * forwardRequest is the new spelling of clientSecretRequest, and the whole point
 * of it is that the two are ONE implementation: same queue, same poll, same ids,
 * so a request sent under either name is readable under either name. What is new
 * is only the shape of the call, and every one of those rules is a place a
 * request can go quietly wrong against a destination this SDK knows nothing
 * about. So they are pinned here, on the bytes, with the network stubbed:
 *
 *   - the form is FLATTENED into the request: into `params` for GET, DELETE and
 *     HEAD, into `data` for everything else, with repeated names collapsing to an
 *     array and FILES DROPPED, because that object travels as JSON,
 *   - on a key collision the explicit option wins, since it was typed at the call
 *     site while the form's value was collected from a page,
 *   - `multipart: true` sends the body verbatim as `body_b64` plus
 *     `body_content_type`, keeps the file, and is refused together with `data`,
 *   - `secretName` is OPTIONAL, and the "$CLIENT_SECRET" requirement applies only
 *     when a secret is actually named,
 *   - `skapiHeaders` says which of the identity headers to send, and a header of
 *     the caller's own under "x-skapi-" is refused whatever it says,
 *   - PATCH and HEAD are allowed methods,
 *   - `apiKeyHeader` and `apiKeyScheme` are gone and REFUSED, not ignored,
 *   - clientSecretRequest still sends `clientSecretName` and still requires it.
 *
 * Run: node ./tests/forward-request.cjs
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

/* ------------------------------------------------------------------ *
 * A browser, as far as the SDK is concerned. MUST run before the bundle is
 * required: the SDK decides once, at module load, whether it is in one, and the
 * form-reading branches are all behind that decision.
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
    // Feature-tested with instanceof by the form reader, so it only has to exist.
    globalThis.FileList = class FileList { };
}
globalThis.FileReader = class FileReader {
    readAsDataURL(blob) {
        blob.arrayBuffer().then(ab => {
            this.result = 'data:application/json;base64,' + Buffer.from(ab).toString('base64');
            if (this.onloadend) this.onloadend();
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
const URL_DEST = 'https://api.example.com/v1/report';

const jsonResponse = o => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

// Every csr / csr-poll body the SDK sent, newest last, and what the next one
// answers with.
let sent = [];
let answer = { ok: true };

globalThis.fetch = async (url, opt) => {
    const u = String(url);
    if (/\/admin-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'admin-v1.json')));
    if (/\/record-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'record-v1.json')));

    let body = null;
    try { body = JSON.parse(opt && opt.body); } catch (e) { body = opt && opt.body; }

    if (/\/csr(-poll|-cancel|-finalize)?(\?|$)/.test(u.split('/api/')[1] ? '/' + u.split('/api/')[1] : u)) {
        sent.push({ url: u, body });
        return jsonResponse(answer);
    }
    return jsonResponse({ ip: '127.0.0.1', locale: 'KR', service_name: 'test', group: 99, opt: {} });
};

// The browser branch of the network layer reaches for XHR, so everything funnels
// back into the mocked fetch above.
globalThis.XMLHttpRequest = class XMLHttpRequest {
    constructor() { this.upload = {}; this.status = 0; this._h = {}; this.readyState = 0; }
    open(m, u) { this._m = m; this._u = u; this.readyState = 1; }
    setRequestHeader(k, v) { this._h[k] = v; }
    getResponseHeader() { return null; }
    abort() { this._aborted = true; }
    send(body) {
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

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */
let pass = 0;
let fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** The csr body of the last request the SDK sent. */
function lastSent() {
    assert.ok(sent.length, 'no request was sent');
    return sent[sent.length - 1].body;
}

/** Runs `fn` and returns the SkapiError it threw. */
async function refused(fn) {
    try {
        await fn();
    }
    catch (err) {
        return err;
    }
    throw new Error('expected a refusal, got none');
}

/* ------------------------------------------------------------------ *
 * The form, flattened
 * ------------------------------------------------------------------ */

test('a form is flattened into "data", repeated names become an array, files are dropped', async () => {
    const s = await getSkapi();
    const fd = new FormData();
    fd.append('title', 'q3');
    fd.append('tag', 'a');
    fd.append('tag', 'b');
    fd.append('sheet', new Blob(['x,y\n1,2'], { type: 'text/csv' }), 'rows.csv');

    await s.forwardRequest(fd, { url: URL_DEST, method: 'POST' });

    const b = lastSent();
    assert.deepStrictEqual(b.data, { title: 'q3', tag: ['a', 'b'] });
    assert.ok(!('sheet' in b.data), 'the file must not survive the flattening');
    assert.strictEqual(b.method, 'post');
    assert.strictEqual(b.url, URL_DEST);
    assert.ok(!('params' in b), 'a POST does not collect the form into the query string');
});

test('a plain object works as the form, and its File values are dropped too', async () => {
    const s = await getSkapi();
    await s.forwardRequest(
        { note: 'hello', upload: new Blob(['bytes']) },
        { url: URL_DEST, method: 'POST' },
    );
    assert.deepStrictEqual(lastSent().data, { note: 'hello' });
});

test('null means no form body, which is legitimate', async () => {
    const s = await getSkapi();
    await s.forwardRequest(null, { url: URL_DEST, method: 'POST', data: { only: 'this' } });
    assert.deepStrictEqual(lastSent().data, { only: 'this' });
});

test('the explicit option wins on a key collision', async () => {
    const s = await getSkapi();
    const fd = new FormData();
    fd.append('who', 'from-the-form');
    fd.append('kept', 'yes');

    await s.forwardRequest(fd, {
        url: URL_DEST,
        method: 'POST',
        data: { who: 'from-the-options' },
    });

    assert.deepStrictEqual(lastSent().data, { kept: 'yes', who: 'from-the-options' });
});

test('GET, DELETE and HEAD collect the form into "params" instead', async () => {
    const s = await getSkapi();
    for (const method of ['GET', 'DELETE', 'HEAD']) {
        const fd = new FormData();
        fd.append('q', 'skapi');
        await s.forwardRequest(fd, { url: URL_DEST, method, params: { q: 'explicit', page: '2' } });
        const b = lastSent();
        assert.strictEqual(b.method, method.toLowerCase());
        assert.deepStrictEqual(b.params, { q: 'explicit', page: '2' }, method);
        assert.ok(!('data' in b), `${method} must not build a body out of the form`);
    }
});

test('PATCH is an allowed method and merges into "data"', async () => {
    const s = await getSkapi();
    const fd = new FormData();
    fd.append('patched', '1');
    await s.forwardRequest(fd, { url: URL_DEST, method: 'PATCH' });
    const b = lastSent();
    assert.strictEqual(b.method, 'patch');
    assert.deepStrictEqual(b.data, { patched: '1' });
});

test('the method defaults to POST', async () => {
    const s = await getSkapi();
    await s.forwardRequest(null, { url: URL_DEST, data: { a: 1 } });
    assert.strictEqual(lastSent().method, 'post');
});

test('an unknown method is refused', async () => {
    const s = await getSkapi();
    const err = await refused(() => s.forwardRequest(null, { url: URL_DEST, method: 'TRACE' }));
    assert.strictEqual(err.code, 'INVALID_PARAMETER');
});

/* ------------------------------------------------------------------ *
 * multipart
 * ------------------------------------------------------------------ */

test('multipart sends the body verbatim as body_b64 with its content type', async () => {
    const s = await getSkapi();
    const fd = new FormData();
    fd.append('title', 'q3');
    fd.append('sheet', new Blob(['x,y\n1,2'], { type: 'text/csv' }), 'rows.csv');

    await s.forwardRequest(fd, { url: URL_DEST, method: 'POST', multipart: true });

    const b = lastSent();
    assert.ok(!('data' in b), 'a raw body is the body: there is no "data" beside it');
    assert.ok(typeof b.body_b64 === 'string' && b.body_b64.length, 'body_b64 missing');
    assert.match(b.body_content_type, /^multipart\/form-data; boundary=/);

    // The bytes are the browser's own serialization, so the file survives whole.
    const raw = Buffer.from(b.body_b64, 'base64').toString('utf8');
    assert.ok(raw.includes('name="title"'), 'field part missing');
    assert.ok(raw.includes('filename="rows.csv"'), 'file part missing');
    assert.ok(raw.includes('x,y\n1,2'), 'file bytes missing');
    assert.ok(b.body_content_type.includes(raw.split('\r\n')[0].slice(2)), 'the boundary must match the body');
});

test('multipart is refused together with "data"', async () => {
    const s = await getSkapi();
    const err = await refused(() => s.forwardRequest(
        { a: 1 },
        { url: URL_DEST, method: 'POST', multipart: true, data: { b: 2 } },
    ));
    assert.strictEqual(err.code, 'INVALID_PARAMETER');
    assert.match(err.message, /multipart/);
});

test('an oversized multipart body is refused by its own message, not the generic one', async () => {
    const s = await getSkapi();
    const ok = new FormData();
    ok.append('f', new Blob(['a'.repeat(512 * 1024)]), 'small.bin');
    await s.forwardRequest(ok, { url: URL_DEST, method: 'POST', multipart: true });
    assert.ok(lastSent().body_b64.length > 0);

    const big = new FormData();
    big.append('f', new Blob(['a'.repeat(3 * 1024 * 1024)]), 'big.bin');
    const err = await refused(() => s.forwardRequest(big, { url: URL_DEST, method: 'POST', multipart: true }));
    assert.strictEqual(err.code, 'INVALID_PARAMETER');
    assert.match(err.message, /Multipart body is too large/);
});

test('multipart still allows a query string', async () => {
    const s = await getSkapi();
    await s.forwardRequest({ a: '1' }, {
        url: URL_DEST,
        method: 'POST',
        multipart: true,
        params: { v: '2' },
    });
    const b = lastSent();
    assert.deepStrictEqual(b.params, { v: '2' });
    assert.ok(b.body_b64);
});

/* ------------------------------------------------------------------ *
 * secretName
 * ------------------------------------------------------------------ */

test('no secret named means no placeholder is required, and nothing names one on the wire', async () => {
    const s = await getSkapi();
    await s.forwardRequest(null, { url: URL_DEST, method: 'POST', data: { a: 1 } });
    const b = lastSent();
    assert.ok(!('secretName' in b), 'a secret nobody named must not appear');
    assert.ok(!('clientSecretName' in b));
});

test('a foreign service and owner reach the server exactly as the old method sent them', async () => {
    // An admin dashboard acts on a USER'S project by naming it. validator.Params keeps
    // service and owner on every method, so clientSecretRequest always forwarded them.
    // forwardRequest builds its params from a list, and dropping these two from it
    // silently re-aimed the request at the dashboard's own service.
    const s = await getSkapi();
    const FOREIGN = { service: 'ap22usersproject0001', owner: 'user-owner-id-0001' };
    const common = { url: URL_DEST, method: 'POST', headers: { 'x-api-key': '$CLIENT_SECRET' } };

    await s.clientSecretRequest({ ...common, clientSecretName: 'my_secret', ...FOREIGN });
    const old = sent[sent.length - 1];
    await s.forwardRequest(null, { ...common, secretName: 'my_secret', ...FOREIGN });
    const neu = sent[sent.length - 1];

    const where = (w) => ({
        service: w.body && w.body.service,
        owner: w.body && w.body.owner,
        inUrl: w.url.includes(FOREIGN.service),
    });
    assert.deepStrictEqual(where(neu), where(old), 'the new method must aim the request where the old one did');
    // Not vacuous: the foreign project really does travel, somewhere, on the old path.
    const o = where(old);
    assert.ok(o.service === FOREIGN.service || o.inUrl, 'the old path carries the foreign service');
});

test('a named secret goes out as "secretName" and still requires the placeholder', async () => {
    const s = await getSkapi();
    await s.forwardRequest(null, {
        url: URL_DEST,
        method: 'POST',
        secretName: 'my_secret',
        headers: { 'x-api-key': '$CLIENT_SECRET' },
    });
    const b = lastSent();
    assert.strictEqual(b.secretName, 'my_secret');
    assert.ok(!('clientSecretName' in b), 'the new name is what travels');

    const err = await refused(() => s.forwardRequest(null, {
        url: URL_DEST,
        method: 'POST',
        secretName: 'my_secret',
        data: { nothing: 'to substitute' },
    }));
    assert.strictEqual(err.code, 'INVALID_PARAMETER');
    assert.match(err.message, /\$CLIENT_SECRET/);
});

test('the placeholder can come from the form itself', async () => {
    const s = await getSkapi();
    const fd = new FormData();
    fd.append('key', '$CLIENT_SECRET');
    await s.forwardRequest(fd, { url: URL_DEST, method: 'POST', secretName: 'my_secret' });
    assert.strictEqual(lastSent().data.key, '$CLIENT_SECRET');
});

/* ------------------------------------------------------------------ *
 * skapiHeaders and the reserved prefix
 * ------------------------------------------------------------------ */

test('skapiHeaders travels as given, and an object is normalised to both flags', async () => {
    const s = await getSkapi();

    await s.forwardRequest(null, { url: URL_DEST, method: 'POST', data: { a: 1 }, skapiHeaders: true });
    assert.strictEqual(lastSent().skapiHeaders, true);

    await s.forwardRequest(null, { url: URL_DEST, method: 'POST', data: { a: 1 }, skapiHeaders: { user: true } });
    assert.deepStrictEqual(lastSent().skapiHeaders, { user: true, service: false });

    await s.forwardRequest(null, { url: URL_DEST, method: 'POST', data: { a: 1 } });
    assert.ok(!('skapiHeaders' in lastSent()), 'off by default means absent, not false');
});

test('a caller header under "x-skapi-" is refused, case-insensitively and whatever skapiHeaders says', async () => {
    const s = await getSkapi();
    for (const name of ['x-skapi-user', 'X-Skapi-User', 'X-SKAPI-anything']) {
        const err = await refused(() => s.forwardRequest(null, {
            url: URL_DEST,
            method: 'POST',
            data: { a: 1 },
            headers: { [name]: 'someone-else' },
            skapiHeaders: true,
        }));
        assert.strictEqual(err.code, 'INVALID_PARAMETER', name);
        assert.match(err.message, /x-skapi-/);
    }
    // A header that merely contains the prefix later on is fine.
    await s.forwardRequest(null, {
        url: URL_DEST,
        method: 'POST',
        data: { a: 1 },
        headers: { 'my-x-skapi-note': 'ok' },
    });
    assert.strictEqual(lastSent().headers['my-x-skapi-note'], 'ok');
});

/* ------------------------------------------------------------------ *
 * What is gone
 * ------------------------------------------------------------------ */

test('apiKeyHeader and apiKeyScheme are refused, and the refusal names secretName', async () => {
    const s = await getSkapi();
    for (const opt of [{ apiKeyHeader: 'x-api-key' }, { apiKeyScheme: 'Bearer' }]) {
        const err = await refused(() => s.forwardRequest(null, Object.assign({ url: URL_DEST }, opt)));
        assert.strictEqual(err.code, 'INVALID_PARAMETER');
        assert.match(err.message, /secretName/);
        assert.match(err.message, /\$CLIENT_SECRET/);
    }
});

test('a signal that is already aborted sends nothing', async () => {
    const s = await getSkapi();
    const before = sent.length;
    const ac = new AbortController();
    ac.abort();
    const err = await refused(() => s.forwardRequest(null, {
        url: URL_DEST, method: 'POST', data: { a: 1 }, signal: ac.signal,
    }));
    assert.strictEqual(err.code, 'INVALID_REQUEST');
    assert.strictEqual(sent.length, before, 'nothing should have gone out');
});

/* ------------------------------------------------------------------ *
 * The old names
 * ------------------------------------------------------------------ */

test('clientSecretRequest is unchanged: clientSecretName on the wire, and still required', async () => {
    const s = await getSkapi();
    await s.clientSecretRequest({
        url: URL_DEST,
        method: 'POST',
        clientSecretName: 'my_secret',
        headers: { 'x-api-key': '$CLIENT_SECRET' },
    });
    const b = lastSent();
    assert.strictEqual(b.clientSecretName, 'my_secret');
    assert.ok(!('secretName' in b), 'the old name keeps sending the old field');

    const err = await refused(() => s.clientSecretRequest({
        url: URL_DEST,
        method: 'POST',
        headers: { 'x-api-key': '$CLIENT_SECRET' },
    }));
    assert.strictEqual(err.code, 'INVALID_PARAMETER');
});

test('every companion exists under both names', async () => {
    const s = await getSkapi();
    for (const n of [
        'forwardRequest', 'forwardRequestStream', 'forwardRequestFinalize', 'forwardRequestHistory',
        'cancelForwardRequest', 'stopForwardRequestPolling', 'forwardRequestQueueCount', 'isPollStopped',
        'clientSecretRequest', 'clientSecretRequestStream', 'clientSecretRequestFinalize',
        'clientSecretRequestHistory', 'cancelClientSecretRequest', 'stopClientSecretPolling',
        'clientSecretRequestQueueCount',
    ]) {
        assert.strictEqual(typeof s[n], 'function', n);
    }
    assert.strictEqual(s.stopForwardRequestPolling(), 0);
    assert.strictEqual(s.stopClientSecretPolling(), 0);
});

test('both history names address the same row id', async () => {
    const s = await getSkapi();
    answer = { list: [], endOfList: true };
    try {
        await s.forwardRequestHistory({ url: URL_DEST, method: 'POST' });
        const viaNew = lastSent().id;
        await s.clientSecretRequestHistory({ url: URL_DEST, method: 'POST' });
        assert.strictEqual(lastSent().id, viaNew);
        assert.ok(viaNew.startsWith('[POST]' + URL_DEST));
    }
    finally {
        answer = { ok: true };
    }
});

test('a PATCH row is addressable by the history and cancel calls', async () => {
    const s = await getSkapi();
    answer = { list: [], endOfList: true };
    try {
        await s.forwardRequestHistory({ url: URL_DEST, method: 'PATCH' });
        assert.ok(lastSent().id.startsWith('[PATCH]'));
    }
    finally {
        answer = { ok: true };
    }
    answer = { removed: true, message: 'ok' };
    try {
        await s.cancelForwardRequest({ url: URL_DEST, method: 'PATCH', id: '1:2' });
        assert.ok(lastSent().id.startsWith('[PATCH]'));
    }
    finally {
        answer = { ok: true };
    }
});

/* ------------------------------------------------------------------ *
 * responseType
 * ------------------------------------------------------------------ */

test('responseType shapes the destination answer, and refuses "response"', async () => {
    const s = await getSkapi();
    answer = { answered: 'yes' };
    try {
        const asText = await s.forwardRequest(null, {
            url: URL_DEST, method: 'POST', data: { a: 1 }, responseType: 'text',
        });
        assert.strictEqual(asText, JSON.stringify({ answered: 'yes' }));

        const asJson = await s.forwardRequest(null, {
            url: URL_DEST, method: 'POST', data: { a: 1 }, responseType: 'json',
        });
        assert.deepStrictEqual(asJson, { answered: 'yes' });
    }
    finally {
        answer = { ok: true };
    }

    const err = await refused(() => s.forwardRequest(null, {
        url: URL_DEST, method: 'POST', data: { a: 1 }, responseType: 'response',
    }));
    assert.strictEqual(err.code, 'INVALID_PARAMETER');
});

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */
(async () => {
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log('ok   ', name);
            pass++;
        }
        catch (err) {
            console.log('FAIL ', name);
            console.log('      ', err && err.message);
            fail++;
        }
    }
    console.log(`\n${pass}/${pass + fail} passed`);
    if (fail) process.exit(1);
})();

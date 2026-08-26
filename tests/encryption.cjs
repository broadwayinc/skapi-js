/**
 * Client-side encryption of private record data.
 *
 * The feature encrypts ONLY the value of a record's `data` attribute, and ONLY
 * when the write lands on access_group 'private'. Everything the database
 * queries on -- record_id, unique_id, index name and value, tags, reference --
 * stays plaintext, which is exactly why every existing query path keeps working.
 *
 * What these tests are really guarding:
 *
 *  - The OFF path is byte-identical to before. This feature is opt-in, and an
 *    instance without the flag must not gain a single byte of behaviour.
 *  - The server never sees plaintext. Several tests assert on what the mock
 *    STORED, not on what the caller read back, because a round trip that only
 *    checks the caller's view would pass even if nothing were encrypted at all.
 *  - Failure is always a flag, never an exception. One undecryptable record in
 *    a page of fifty must not reject the whole getRecords.
 *  - Declassifying a record (private -> anything else) writes plaintext, so a
 *    record that is no longer private is no longer unreadable.
 *
 * Run: node ./tests/encryption.cjs
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

/* ------------------------------------------------------------------ *
 * A browser, as far as the SDK is concerned.
 *
 * MUST run before the bundle is required: utils.isNodeRuntime() tests
 * `typeof window === 'undefined'`, and network.ts captures
 * `const isBrowser = isBrowserRuntime()` once at module load. Without this the
 * whole file-upload path is silently skipped in Node and every attachment test
 * passes vacuously.
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
// The SDK feature-tests these constructors with `instanceof`, so they only have
// to exist and never match.
for (const n of ['HTMLInputElement', 'HTMLFormElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLElement', 'SubmitEvent', 'Event', 'Node']) {
    if (typeof globalThis[n] === 'undefined') {
        globalThis[n] = class { };
    }
}
globalThis.sessionStorage = _store();
globalThis.localStorage = _store();
globalThis.document = {
    createElement: () => ({ href: '', click() { }, setAttribute() { }, style: {} }),
    body: { appendChild() { }, removeChild() { } }
};
globalThis.URL.createObjectURL = b => 'blob:mock/' + Math.random().toString(36).slice(2);
globalThis.URL.revokeObjectURL = () => { };

globalThis.File = class File extends Blob {
    constructor(parts, name, opts) { super(parts, opts); this.name = name; this.lastModified = Date.now(); }
};
globalThis.FormData = class FormData {
    constructor() { this._e = []; }
    append(k, v) { this._e.push([k, v]); }
    entries() { return this._e[Symbol.iterator](); }
};

const { Skapi } = require(process.env.SKAPI_BUNDLE || '../dist/skapi.cjs');

const FIXTURES = path.join(__dirname, 'fixtures');
const OWNER = '4d4a36a5-b318-4093-92ae-7cf11feae989';
const SERVICE = 'ap21AAAAAAAAAAAAAAAA';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

const jsonResponse = o => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

globalThis.FileReader = class FileReader {
    readAsDataURL(blob) {
        blob.arrayBuffer().then(ab => {
            this.result = 'data:application/json;base64,' + Buffer.from(ab).toString('base64');
            if (this.onloadend) this.onloadend();
        }).catch(err => { if (this.onerror) this.onerror(err); });
    }
};

/* ------------------------------------------------------------------ *
 * In-memory record store, standing in for DynamoDB.
 *
 * Holds exactly what the backend would hold, so a test can inspect the STORED
 * value and prove the plaintext never left the client.
 * ------------------------------------------------------------------ */

let STORE = new Map();   // record_id -> { rec, usr, tbl, data, unique_id, group, table }
let SEQ = 0;
let POST_BODIES = [];    // every post-record body, for the off-path byte check

const groupWire = g => (g === 'private' || g === '**') ? '**' : g === 'public' ? '00' : g === 'authorized' ? '01' : String(g).padStart(2, '0');

function rawOf(r) {
    let out = {
        rec: r.rec,
        usr: r.usr,
        ip: r.unique_id ? `1.1.1.1#${r.unique_id}` : '1.1.1.1',
        tbl: `${r.table}/svc/${groupWire(r.group)}`,
        data: r.data,
        upd: r.upd || 1
    };
    let bin = (r.binUrls || []).slice();
    if (r.offloaded) {
        bin.push(offloadUrl(r.rec, r.group));
    }
    if (bin.length) {
        out.bin = bin;
    }
    return out;
}

function handlePost(body) {
    POST_BODIES.push(body);
    let rid = body.record_id;
    let existing = rid ? STORE.get(rid) : null;

    if (!existing) {
        rid = rid || `VQ${String(++SEQ).padStart(14, '0')}`;
        existing = {
            rec: rid,
            usr: body.__test_user__,
            table: body.table?.name || 't',
            group: body.table?.access_group === undefined ? 0 : body.table.access_group,
            unique_id: body.unique_id || '',
            data: null,
            upd: 1
        };
        STORE.set(rid, existing);
    }
    else {
        // An update carries the group only when the caller restated it.
        if (body.table?.access_group !== undefined) {
            existing.group = body.table.access_group;
        }
        if (body.table?.name) {
            existing.table = body.table.name;
        }
        existing.upd++;
    }
    // The real backend only writes `data` when the key is present in the body;
    // a metadata-only update leaves the stored value alone. Mirroring that is
    // the whole point of the omitted-data regression test below.
    if (Object.prototype.hasOwnProperty.call(body, 'data')) {
        let value = body.data === undefined ? null : body.data;
        let serialized = JSON.stringify(value);
        if (OFFLOAD_OVER && serialized.length > OFFLOAD_OVER) {
            OFFLOAD_BODIES.set(existing.rec, serialized);
            existing.data = { __data__: offloadPath(existing.rec) };
            existing.offloaded = true;
        }
        else {
            existing.data = value;
            existing.offloaded = false;
        }
    }
    return rawOf(existing);
}

function handleGet(body) {
    if (body.record_id) {
        let r = STORE.get(body.record_id);
        return { list: r ? [rawOf(r)] : [], endOfList: true };
    }
    let out = [...STORE.values()];
    if (body.table?.name) {
        out = out.filter(r => r.table === body.table.name);
    }
    if (body.table?.access_group !== undefined) {
        out = out.filter(r => groupWire(r.group) === groupWire(body.table.access_group));
    }
    // The reserved $user_id index, which is how the keyring is addressed.
    if (body.index?.name === '$user_id') {
        out = out.filter(r => r.usr === body.index.value);
    }
    if (body.__test_scope_user__) {
        // A private-table listing is owner-scoped server-side.
        if (body.table?.access_group === 'private' || groupWire(body.table?.access_group) === '**') {
            out = out.filter(r => r.usr === body.__test_scope_user__);
        }
    }
    return { list: out.map(rawOf), endOfList: true };
}

// The record-data offload. The real backend catches DynamoDB's size error, PUTs
// the serialized `data` to S3 as a bin file, and stores only a marker. Whatever
// the client SENT is what gets written, which is the whole question this mocks:
// with encryption on, what the client sent is the envelope.
const BIN_HOST = 'https://cdn.example.com';
let OFFLOAD_OVER = 0;          // bytes; 0 disables offloading
let OFFLOAD_BODIES = new Map(); // record_id -> the exact body written to S3

function offloadPath(rid) {
    return `0/0/__data__/__json__.json`;
}
function offloadUrl(rid, group) {
    const prefix = groupWire(group) === '00' ? 'publ' : 'auth';
    return `${BIN_HOST}/${prefix}/svc/${OWNER}/${OWNER}/records/${rid}/${groupWire(group)}/bin/${offloadPath(rid)}`;
}

// Object store for record bin files, plus the get-signed-url + POST plumbing
// the SDK's uploadFiles path uses.
let S3 = new Map();      // s3 key -> Uint8Array
let SIGNED = [];         // every get-signed-url request, for asserting on the KEY

// XHR: intercept the multipart S3 upload, and serve everything else from the
// mocked fetch. The bundle's own XHR shim only exists on the Node branch of the
// polyfill, and presenting a `window` above takes the browser branch, so there
// is nothing to delegate to.
globalThis.XMLHttpRequest = class XMLHttpRequest {
    constructor() { this.upload = {}; this.status = 0; this._h = {}; this.readyState = 0; }
    open(m, u) { this._m = m; this._u = u; this.readyState = 1; }
    setRequestHeader(k, v) { this._h[k] = v; }
    getResponseHeader() { return null; }
    abort() { this._aborted = true; }
    send(body) {
        (async () => {
            try {
                if (body && typeof body.entries === 'function') {
                    let key = null, file = null;
                    for (const [k, v] of body.entries()) {
                        if (k === 'key') key = v;
                        if (k === 'file') file = v;
                    }
                    if (key && file) {
                        const clean = String(key).split('?')[0];
                        S3.set(clean, new Uint8Array(await file.arrayBuffer()));
                        // Register it in the record's bin, which is what the
                        // real S3 notification does.
                        const m = clean.match(/\/records\/([^/]+)\//);
                        const rec = m && STORE.get(m[1]);
                        if (rec) {
                            rec.binUrls = rec.binUrls || [];
                            if (!rec.binUrls.includes(clean)) rec.binUrls.push(clean);
                        }
                    }
                    this.status = 204;
                    this.responseText = '';
                }
                else {
                    const init = { method: this._m, headers: this._h };
                    if (body && this._m !== 'GET' && this._m !== 'HEAD') init.body = body;
                    const r = await fetch(this._u, init);
                    this.status = r.status;
                    this.statusText = r.statusText;
                    this.responseURL = r.url;
                    if (this.responseType === 'blob') this.response = await r.blob();
                    else if (this.responseType === 'arraybuffer') this.response = await r.arrayBuffer();
                    else if (this.responseType === 'json') { try { this.response = await r.json(); } catch { this.response = null; } }
                    else { this.responseText = await r.text(); this.response = this.responseText; }
                }
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

let CURRENT_USER = null;

globalThis.fetch = async (url, opt) => {
    const u = String(url);
    if (/\/admin-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'admin-v1.json')));
    if (/\/record-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'record-v1.json')));

    if (u.includes('post-record')) {
        const body = JSON.parse(opt.body);
        if (Array.isArray(body._is_bulk_)) {
            POST_BODIES.push(body);
            return jsonResponse(body._is_bulk_.map(c => {
                c.__test_user__ = CURRENT_USER;
                const out = handlePost(c);
                POST_BODIES.pop(); // handlePost pushes each element; keep only the batch
                return out;
            }));
        }
        body.__test_user__ = CURRENT_USER;
        return jsonResponse(handlePost(body));
    }
    if (u.includes('get-records')) {
        const body = JSON.parse(opt.body);
        body.__test_scope_user__ = CURRENT_USER;
        return jsonResponse(handleGet(body));
    }
    if (u.includes('del-records')) {
        const body = JSON.parse(opt.body || '{}');
        const r = STORE.get(body.record_id);
        if (!r) return jsonResponse({ list: [], endOfList: true });
        STORE.delete(body.record_id);
        // RAW shape, exactly as the delete lambda returns it: short keys and
        // every stored encoding untouched.
        return jsonResponse({
            list: [{
                rec: r.rec,
                usr_tbl: `${r.usr}/${r.table}/svc/${groupWire(r.group)}`,
                ip: r.unique_id ? `1.1.1.1#${r.unique_id}` : '1.1.1.1',
                data: typeof r.data === 'object' && r.data !== null && !r.data.__data__
                    ? '!J%' + JSON.stringify(r.data)
                    : r.data
            }],
            endOfList: true
        });
    }
    if (u.includes('grant-private-access')) {
        return jsonResponse('SUCCESS');
    }
    if (u.includes('get-signed-url')) {
        const body = JSON.parse(opt.body || '{}');
        SIGNED.push(body);
        // Mirror the real key layout, which is what the SDK parses the marker
        // and the record_id back out of:
        //   auth|publ/service/owner/uploader/records/<rid>/<group>/bin/<ts>/<size>/<formKey>/<name>
        const rec = STORE.get(body.id);
        const grp = rec ? groupWire(rec.group) : '**';
        const cdn = `${BIN_HOST}/auth/svc/${OWNER}/${CURRENT_USER}/records/${body.id}/${grp}/bin/0/${body.sizeKey}/${body.key}`;
        return jsonResponse({ url: cdn, cdn, fields: { key: cdn } });
    }
    if (u.startsWith(BIN_HOST)) {
        const clean = u.split('?')[0];
        if (S3.has(clean)) {
            return new Response(S3.get(clean), { status: 200 });
        }
        const m = clean.match(/\/records\/([^/]+)\//);
        const body = m ? OFFLOAD_BODIES.get(m[1]) : null;
        if (body === null || body === undefined) {
            return new Response('not found', { status: 404 });
        }
        return new Response(body, { status: 200 });
    }
    return jsonResponse({ ip: '1.1.1.1', locale: 'KR', service_name: 't', group: 99, opt: {} });
};

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Minimal IndexedDB, so the device-store path (and the deadlock it once
 * caused) is actually reachable from Node.
 * ------------------------------------------------------------------ */
const IDB = new Map();
globalThis.indexedDB = {
    open() {
        const req = {};
        setTimeout(() => {
            const db = {
                objectStoreNames: { contains: () => true },
                createObjectStore: () => { },
                close: () => { },
                transaction(name, mode) {
                    const tx = { oncomplete: null, onerror: null, error: null };
                    setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
                    return Object.assign(tx, {
                        objectStore: () => ({
                            put(v, k) { IDB.set(k, v); return {}; },
                            delete(k) { IDB.delete(k); return {}; },
                            get(k) {
                                const r = {};
                                setTimeout(() => { r.result = IDB.get(k) || null; r.onsuccess && r.onsuccess(); }, 0);
                                return r;
                            }
                        })
                    });
                }
            };
            req.result = db;
            req.onsuccess && req.onsuccess();
        }, 0);
        return req;
    }
};

const results = [];
async function test(name, fn) {
    try {
        await fn();
        results.push(true);
        console.log(`ok    ${name}`);
    } catch (err) {
        results.push(false);
        console.log(`FAIL  ${name}\n      ${err && err.message}`);
    }
}

const farFuture = Math.floor(Date.now() / 1000) + 86400;
function fakeSession() {
    return {
        getIdToken: () => ({ getExpiration: () => farFuture, getJwtToken: () => 'fake.jwt.token' }),
        getAccessToken: () => ({ getJwtToken: () => 'fake.jwt.token' }),
        idToken: { payload: { exp: farFuture }, jwtToken: 'fake.jwt.token' },
        accessToken: { payload: { exp: farFuture }, jwtToken: 'fake.jwt.token' },
        getRefreshToken: () => ({ getToken: () => 'fake.refresh' }),
        refreshToken: { token: 'fake.refresh' }
    };
}

/** A logged-in instance. Cognito is bypassed; the encryption layer is not. */
async function makeClient(user_id, opts = {}) {
    const skapi = new Skapi(SERVICE, OWNER, Object.assign({
        autoLogin: false,
        encryption: { iterations: 100000, persistDevice: false }
    }, opts));
    // Both promises, then a tick. __authConnection calls _out() WITHOUT
    // awaiting it (user.ts:318, the "wasn't logged in" path), so the clear
    // lands a microtask after __authConnection resolves and would wipe the
    // user we are about to fake in.
    await skapi.__connection;
    await skapi.__authConnection;
    await new Promise(r => setTimeout(r, 50));
    skapi.session = fakeSession();
    // `service` must match, or checkAdmin() (called from getQuery) treats the
    // session as stale and logs the user straight back out.
    skapi.__user = { user_id, service: SERVICE, owner: OWNER, access_group: 1 };
    skapi.user = { user_id, access_group: 1 };
    return skapi;
}

async function login(skapi, password) {
    CURRENT_USER = skapi.user.user_id;
    await skapi.unlockEncryption({ password });
}

/** Run a block with `who` as the acting user, so the mock scopes reads correctly. */
async function as(skapi, fn) {
    CURRENT_USER = skapi.user.user_id;
    return fn();
}

/** The value the server actually holds for a record. */
const stored = rid => STORE.get(rid).data;

(async () => {

    /* ---------------- the off path ---------------- */

    await test('OFF: an instance without the flag posts a byte-identical body', async () => {
        const plain = new Skapi(SERVICE, OWNER, { autoLogin: false });
        await plain.__connection;
        await plain.__authConnection;
        await new Promise(r => setTimeout(r, 50));
        plain.session = fakeSession();
        plain.__user = { user_id: ALICE, service: SERVICE, owner: OWNER, access_group: 1 };
        plain.user = { user_id: ALICE, access_group: 1 };
        CURRENT_USER = ALICE;

        POST_BODIES = [];
        const value = { secret: 'plaintext', n: 1 };
        const rec = await plain.postRecord(value, { table: { name: 't', access_group: 'private' } });

        assert.deepStrictEqual(POST_BODIES[0].data, value, 'the body must carry the raw value');
        assert.deepStrictEqual(stored(rec.record_id), value, 'the server must hold plaintext');
        assert.strictEqual(rec.encrypted, undefined, 'no encryption metadata when the feature is off');
    });

    /* ---------------- setup ---------------- */

    const alice = await makeClient(ALICE);
    await login(alice, 'correct horse battery staple');

    await test('login provisions a keyring and reports unlocked', async () => {
        const st = alice.getEncryptionStatus();
        assert.strictEqual(st.status, 'unlocked');
        assert.ok(st.fingerprint, 'a key fingerprint must be published');
        const keyrings = [...STORE.values()].filter(r => r.table === 'skapi__keyring');
        assert.strictEqual(keyrings.length, 2, 'one private keyring and one public key record');
        assert.ok(keyrings.some(r => groupWire(r.group) === '**'), 'secrets go in the private partition');
        assert.ok(keyrings.some(r => groupWire(r.group) === '01'), 'the public key goes in the authorized partition');
    });

    await test('the keyring never stores the password or the raw master key', async () => {
        const kr = [...STORE.values()].find(r => r.table === 'skapi__keyring' && groupWire(r.group) === '**');
        const blob = JSON.stringify(kr.data);
        assert.ok(!blob.includes('correct horse'), 'the password must never be stored');
        assert.ok(kr.data.wraps[0].ct, 'the master key is stored only as a wrap');
        assert.ok(kr.data.wraps[0].kdf.it >= 100000, 'the kdf cost must be recorded');
        assert.ok(kr.data.pub, 'the public key is stored in the clear, which is fine');
        assert.ok(!kr.data.priv, 'the private key must never be stored unencrypted');
    });

    /* ---------------- the core claim ---------------- */

    let RID = null;

    await test('THE PROOF: a private record reaches the server as ciphertext', async () => {
        const value = { ssn: '123-45-6789', note: 'the provider must never see this' };
        POST_BODIES = [];
        const rec = await as(alice, () => alice.postRecord(value, { table: { name: 't', access_group: 'private' } }));
        RID = rec.record_id;

        const onWire = POST_BODIES[POST_BODIES.length - 1].data;
        assert.ok(onWire.__skapi_enc__, 'the wire body must be an envelope');
        assert.ok(!JSON.stringify(onWire).includes('123-45-6789'), 'the secret must not appear on the wire');
        assert.ok(!JSON.stringify(stored(RID)).includes('123-45-6789'), 'the secret must not appear in the database');
        assert.ok(!JSON.stringify(stored(RID)).includes('provider must never'), 'no plaintext fragment survives');
    });

    await test('postRecord returns the caller their own plaintext', async () => {
        const value = { a: 1, deep: { b: [1, 2, 3] } };
        const rec = await as(alice, () => alice.postRecord(value, { table: { name: 't', access_group: 'private' } }));
        assert.deepStrictEqual(rec.data, value, 'the caller must not have to re-read to see their own data');
        assert.strictEqual(rec.encrypted.status, 'encrypted');
    });

    await test('the owner reads it back decrypted', async () => {
        const out = await as(alice, () => alice.getRecords({ record_id: RID }));
        assert.deepStrictEqual(out.list[0].data, { ssn: '123-45-6789', note: 'the provider must never see this' });
        assert.strictEqual(out.list[0].encrypted.status, 'encrypted');
    });

    await test('every JSON type round trips', async () => {
        for (const value of [
            { obj: true },
            [1, 'two', { three: 3 }],
            'a bare string',
            42,
            0,
            null,
            { '': 'empty key', 'unicode': '한국어 🐰', nested: { deep: { deeper: [null, false] } } }
        ]) {
            const rec = await as(alice, () => alice.postRecord(value, { table: { name: 't', access_group: 'private' } }));
            const out = await as(alice, () => alice.getRecords({ record_id: rec.record_id }));
            assert.deepStrictEqual(out.list[0].data, value, `round trip failed for ${JSON.stringify(value)}`);
        }
    });

    await test('the caller\'s object is never mutated', async () => {
        const value = { keep: 'me' };
        const snapshot = JSON.parse(JSON.stringify(value));
        await as(alice, () => alice.postRecord(value, { table: { name: 't', access_group: 'private' } }));
        assert.deepStrictEqual(value, snapshot, 'maybeEncrypt must not touch the input');
    });

    await test('the index value stays plaintext and queryable', async () => {
        const rec = await as(alice, () => alice.postRecord(
            { secret: 'hidden' },
            { table: { name: 't', access_group: 'private' }, index: { name: 'price', value: 500 } }
        ));
        const raw = STORE.get(rec.record_id);
        assert.ok(raw.data.__skapi_enc__, 'data is encrypted');
        const body = POST_BODIES[POST_BODIES.length - 1];
        assert.strictEqual(body.index.value, 500, 'the index value must reach the server in the clear');
    });

    /* ---------------- declassification ---------------- */

    await test('changing the access group away from private stores plaintext', async () => {
        const value = { was: 'secret' };
        const rec = await as(alice, () => alice.postRecord(value, { table: { name: 't', access_group: 'private' } }));
        assert.ok(stored(rec.record_id).__skapi_enc__, 'starts encrypted');

        await as(alice, () => alice.postRecord(value, { record_id: rec.record_id, table: { name: 't', access_group: 0 } }));
        assert.deepStrictEqual(stored(rec.record_id), value, 'declassified records must be stored decrypted');
        assert.ok(!stored(rec.record_id).__skapi_enc__);

        const out = await as(alice, () => alice.getRecords({ record_id: rec.record_id }));
        assert.deepStrictEqual(out.list[0].data, value);
        assert.strictEqual(out.list[0].encrypted, undefined, 'a public record carries no encryption flag');
    });

    await test('a public record is re-encrypted when it goes back to private', async () => {
        const value = { round: 'trip' };
        const rec = await as(alice, () => alice.postRecord(value, { table: { name: 't', access_group: 0 } }));
        assert.deepStrictEqual(stored(rec.record_id), value);

        await as(alice, () => alice.postRecord(value, { record_id: rec.record_id, table: { name: 't', access_group: 'private' } }));
        assert.ok(stored(rec.record_id).__skapi_enc__, 'must be sealed on the way into private');
    });

    await test('an update that omits the table keeps the record encrypted', async () => {
        const rec = await as(alice, () => alice.postRecord({ v: 1 }, { table: { name: 't', access_group: 'private' } }));
        await as(alice, () => alice.postRecord({ v: 2 }, { record_id: rec.record_id }));
        assert.ok(stored(rec.record_id).__skapi_enc__, 'an omitted table must not silently declassify');
        const out = await as(alice, () => alice.getRecords({ record_id: rec.record_id }));
        assert.deepStrictEqual(out.list[0].data, { v: 2 });
    });

    /* ---------------- backward compatibility ---------------- */

    await test('a legacy plaintext private record still reads verbatim', async () => {
        const rid = 'VQlegacy00000001';
        STORE.set(rid, { rec: rid, usr: ALICE, table: 't', group: 'private', unique_id: '', data: { legacy: true }, upd: 1 });
        const out = await as(alice, () => alice.getRecords({ record_id: rid }));
        assert.deepStrictEqual(out.list[0].data, { legacy: true });
        assert.strictEqual(out.list[0].encrypted, undefined, 'plaintext records get no flag');
    });

    await test('a PUBLIC record whose data merely looks like an envelope is untouched', async () => {
        const rid = 'VQlookalike00001';
        const decoy = { __skapi_enc__: 1, iv: 'x', ct: 'y', own: ALICE, anch: 'new', k: {} };
        STORE.set(rid, { rec: rid, usr: ALICE, table: 't', group: 0, unique_id: '', data: decoy, upd: 1 });
        const out = await as(alice, () => alice.getRecords({ record_id: rid }));
        assert.deepStrictEqual(out.list[0].data, decoy, 'only private records are ever inspected');
    });

    await test('__skapi_enc__ is a reserved key on write', async () => {
        await assert.rejects(
            () => as(alice, () => alice.postRecord({ __skapi_enc__: 'mine' }, { table: { name: 't', access_group: 'private' } })),
            e => /reserved key/.test(e.message)
        );
    });

    /* ---------------- failure is a flag, never a throw ---------------- */

    await test('a locked session returns data null and a reason, and does not throw', async () => {
        await alice.lockEncryption();
        const out = await as(alice, () => alice.getRecords({ record_id: RID }));
        assert.strictEqual(out.list[0].data, null);
        assert.strictEqual(out.list[0].encrypted.status, 'failed');
        assert.strictEqual(out.list[0].encrypted.reason, 'NO_SESSION_KEY');
        await login(alice, 'correct horse battery staple');
    });

    await test('a corrupt envelope surfaces CORRUPT rather than rejecting the page', async () => {
        const rid = 'VQcorrupt0000001';
        const good = JSON.parse(JSON.stringify(stored(RID)));
        good.ct = good.ct.slice(0, -4) + 'AAAA';
        STORE.set(rid, { rec: rid, usr: ALICE, table: 't', group: 'private', unique_id: '', data: good, upd: 1 });
        const out = await as(alice, () => alice.getRecords({ record_id: rid }));
        assert.strictEqual(out.list[0].data, null);
        assert.ok(['CORRUPT', 'BAD_KEY'].includes(out.list[0].encrypted.reason), 'got ' + out.list[0].encrypted.reason);
    });

    await test('an envelope transplanted onto another record is refused', async () => {
        const rid = 'VQtransplant0001';
        const lifted = JSON.parse(JSON.stringify(stored(RID)));
        STORE.set(rid, { rec: rid, usr: BOB, table: 't', group: 'private', unique_id: '', data: lifted, upd: 1 });
        const out = await as(alice, () => alice.getRecords({ record_id: rid }));
        assert.strictEqual(out.list[0].data, null);
        assert.strictEqual(out.list[0].encrypted.reason, 'BINDING_MISMATCH', 'the owner binding must be checked');
    });

    await test('one bad record does not fail a whole page', async () => {
        const out = await as(alice, () => alice.getRecords({ table: { name: 't', access_group: 'private' } }));
        assert.ok(out.list.length > 3, 'expected a multi record page');
        assert.ok(out.list.some(r => r.data !== null), 'good records still decrypt');
    });

    await test('bulkPostRecords encrypts private elements too', async () => {
        POST_BODIES = [];
        const out = await as(alice, () => alice.bulkPostRecords([
            { table: { name: 't', access_group: 'private' }, data: { bulk: 'secret-one' } },
            { table: { name: 't', access_group: 0 }, data: { bulk: 'public-one' } },
            { table: { name: 't', access_group: 'private' }, data: { bulk: 'secret-two' } }
        ]));

        const sent = POST_BODIES[POST_BODIES.length - 1]._is_bulk_;
        assert.ok(sent[0].data.__skapi_enc__, 'private element 0 must be sealed');
        assert.deepStrictEqual(sent[1].data, { bulk: 'public-one' }, 'public element stays plaintext');
        assert.ok(sent[2].data.__skapi_enc__, 'private element 2 must be sealed');
        assert.ok(!JSON.stringify(sent).includes('secret-one'), 'no private plaintext on the wire');
        assert.ok(!JSON.stringify(sent).includes('secret-two'), 'no private plaintext on the wire');

        assert.deepStrictEqual(out[0].data, { bulk: 'secret-one' }, 'caller gets their plaintext back');
        assert.deepStrictEqual(out[1].data, { bulk: 'public-one' });

        const back = await as(alice, () => alice.getRecords({ record_id: out[0].record_id }));
        assert.deepStrictEqual(back.list[0].data, { bulk: 'secret-one' }, 'and it reads back');
    });

    /* ---------------- sharing ---------------- */

    const bob = await makeClient(BOB);
    await login(bob, 'bob-password-9876');

    await test('bob gets his own keyring and public key', async () => {
        assert.strictEqual(bob.getEncryptionStatus().status, 'unlocked');
        const pub = [...STORE.values()].filter(r => r.table === 'skapi__keyring' && r.usr === BOB && groupWire(r.group) === '01');
        assert.strictEqual(pub.length, 1);
    });

    let SHARED = null;

    await test('bob cannot read alice\'s record before it is shared', async () => {
        SHARED = (await as(alice, () => alice.postRecord(
            { shared: 'contract terms' },
            { table: { name: 't', access_group: 'private' } }
        ))).record_id;

        const out = await as(bob, () => bob.getRecords({ record_id: SHARED }));
        assert.strictEqual(out.list[0].data, null);
        assert.strictEqual(out.list[0].encrypted.reason, 'NOT_A_RECIPIENT');
    });

    await test('THE SECOND PROOF: after a grant, bob decrypts it', async () => {
        await as(alice, () => alice.grantPrivateRecordAccess({ record_id: SHARED, user_id: BOB }));

        const env = stored(SHARED);
        assert.ok(env.k[BOB], 'a wrap for bob must have been added');
        assert.strictEqual(env.k[BOB].t, 'ecdh', 'grantee wraps use ECDH-ES');
        assert.ok(env.k[ALICE], 'the owner keeps their own wrap');
        assert.ok(!JSON.stringify(env).includes('contract terms'), 'still ciphertext on the server');

        const out = await as(bob, () => bob.getRecords({ record_id: SHARED }));
        assert.deepStrictEqual(out.list[0].data, { shared: 'contract terms' });
        assert.strictEqual(out.list[0].encrypted.status, 'encrypted');
    });

    await test('alice can still read a record she shared', async () => {
        const out = await as(alice, () => alice.getRecords({ record_id: SHARED }));
        assert.deepStrictEqual(out.list[0].data, { shared: 'contract terms' });
    });

    await test('granting to a user with no keyring fails loudly, before the ACL changes', async () => {
        const NOBODY = '33333333-3333-4333-8333-333333333333';
        await assert.rejects(
            () => as(alice, () => alice.grantPrivateRecordAccess({ record_id: SHARED, user_id: NOBODY })),
            e => /no encryption key/.test(e.message)
        );
        assert.ok(!stored(SHARED).k['33333333-3333-4333-8333-333333333333'], 'nothing was written');
    });

    await test('revoking removes the wrap AND rolls the key', async () => {
        const before = JSON.parse(JSON.stringify(stored(SHARED)));
        await as(alice, () => alice.removePrivateRecordAccess({ record_id: SHARED, user_id: BOB }));

        const after = stored(SHARED);
        assert.ok(!after.k[BOB], 'bob\'s wrap must be gone');
        assert.notStrictEqual(after.ct, before.ct, 'the ciphertext must be re-sealed under a fresh key');

        const out = await as(bob, () => bob.getRecords({ record_id: SHARED }));
        assert.strictEqual(out.list[0].data, null);
        assert.strictEqual(out.list[0].encrypted.reason, 'NOT_A_RECIPIENT');
    });

    await test('alice still reads it after the roll', async () => {
        const out = await as(alice, () => alice.getRecords({ record_id: SHARED }));
        assert.deepStrictEqual(out.list[0].data, { shared: 'contract terms' });
    });

    /* ---------------- password change ---------------- */

    await test('a wrong password does not unlock', async () => {
        const imposter = await makeClient(ALICE);
        CURRENT_USER = ALICE;
        await assert.rejects(
            () => imposter.unlockEncryption({ password: 'wrong-password' }),
            e => /ENCRYPTION_LOCKED|Incorrect password/.test(e.message + e.code)
        );
        assert.strictEqual(imposter.getEncryptionStatus().status, 'locked');
    });

    await test('a fresh session with the right password reads old records', async () => {
        const again = await makeClient(ALICE);
        CURRENT_USER = ALICE;
        await again.unlockEncryption({ password: 'correct horse battery staple' });
        assert.strictEqual(again.getEncryptionStatus().status, 'unlocked');

        const out = await as(again, () => again.getRecords({ record_id: RID }));
        assert.deepStrictEqual(out.list[0].data, { ssn: '123-45-6789', note: 'the provider must never see this' });
    });

    await test('the keyring holds only wraps, and two users have different keys', async () => {
        const krA = [...STORE.values()].find(r => r.table === 'skapi__keyring' && r.usr === ALICE && groupWire(r.group) === '**');
        const krB = [...STORE.values()].find(r => r.table === 'skapi__keyring' && r.usr === BOB && groupWire(r.group) === '**');
        assert.notStrictEqual(krA.data.pub, krB.data.pub, 'each user has their own identity key');
        assert.notStrictEqual(krA.data.wraps[0].kdf.s, krB.data.wraps[0].kdf.s, 'each user has their own salt');
    });

    /* ---------------- binary attachments ---------------- */

    const mkFile = (name, content, type) =>
        new File([typeof content === 'string' ? Buffer.from(content) : content], name, { type: type || 'application/pdf' });

    let FILE_RID = null;

    await test('THE FILE PROOF: an attachment on a private record is stored as ciphertext', async () => {
        S3.clear(); SIGNED = [];
        const secret = 'CONFIDENTIAL-CONTRACT-BODY-canary';
        const rec = await as(alice, () => alice.postRecord(
            { title: 'contract' },
            { table: { name: 't', access_group: 'private' } },
            [{ name: 'doc', file: mkFile('contract.pdf', secret) }]
        ));
        FILE_RID = rec.record_id;

        assert.strictEqual(S3.size, 1, 'exactly one object uploaded');
        const stored = [...S3.values()][0];
        const asText = Buffer.from(stored).toString('latin1');
        assert.ok(!asText.includes(secret), 'THE FILE CONTENT MUST NOT BE ON DISK IN THE CLEAR');
        assert.strictEqual(Buffer.from(stored.subarray(0, 6)).toString(), 'SKENCF', 'stored bytes are a container');

        const signed = SIGNED[SIGNED.length - 1];
        assert.ok(signed.key.includes('__skenc__'), 'the key must carry the marker: ' + signed.key);
        assert.ok(signed.contentType !== 'application/pdf', 'ciphertext must not be labelled as a pdf');
    });

    await test('the owner reads the file back, byte identical', async () => {
        const out = await as(alice, () => alice.getRecords({ record_id: FILE_RID }));
        const f = out.list[0].bin.doc[0];
        assert.strictEqual(f.encrypted, true, 'the bin entry must say it is encrypted');
        assert.strictEqual(f.filename, 'contract.pdf', 'the filename is preserved');

        const blob = await f.getFile('blob');
        assert.strictEqual(Buffer.from(await blob.arrayBuffer()).toString(), 'CONFIDENTIAL-CONTRACT-BODY-canary');
    });

    await test('bin size reports the PLAINTEXT length, not the container length', async () => {
        const out = await as(alice, () => alice.getRecords({ record_id: FILE_RID }));
        const f = out.list[0].bin.doc[0];
        assert.strictEqual(f.size, 'CONFIDENTIAL-CONTRACT-BODY-canary'.length,
            'size must be the plaintext length, readable without fetching');
        assert.ok(f.stored_size > f.size, 'and the real stored size is exposed separately');
    });

    await test("the form key is clean: the marker does not leak into record.bin", async () => {
        const out = await as(alice, () => alice.getRecords({ record_id: FILE_RID }));
        assert.deepStrictEqual(Object.keys(out.list[0].bin), ['doc'],
            'the caller named it "doc", not "doc__skenc__XX"');
    });

    await test("getFile('text') decodes correctly instead of mangling the ciphertext", async () => {
        const out = await as(alice, () => alice.getRecords({ record_id: FILE_RID }));
        const text = await out.list[0].bin.doc[0].getFile('text');
        assert.strictEqual(text, 'CONFIDENTIAL-CONTRACT-BODY-canary',
            "responseType 'text' would have destroyed the bytes before any key was consulted");
    });

    await test("getFile('base64') returns the decrypted content, not base64 of ciphertext", async () => {
        const out = await as(alice, () => alice.getRecords({ record_id: FILE_RID }));
        const b64 = await out.list[0].bin.doc[0].getFile('base64');
        const payload = String(b64).split(',')[1];
        assert.strictEqual(Buffer.from(payload, 'base64').toString(), 'CONFIDENTIAL-CONTRACT-BODY-canary');
    });

    await test('a file on a PUBLIC record is untouched', async () => {
        S3.clear(); SIGNED = [];
        const rec = await as(alice, () => alice.postRecord(
            { title: 'brochure' },
            { table: { name: 't', access_group: 0 } },
            [{ name: 'doc', file: mkFile('open.pdf', 'PUBLIC-BODY') }]
        ));
        const stored = [...S3.values()][0];
        assert.strictEqual(Buffer.from(stored).toString(), 'PUBLIC-BODY', 'stored verbatim');
        assert.ok(!SIGNED[SIGNED.length - 1].key.includes('__skenc__'), 'and unmarked');
        const out = await as(alice, () => alice.getRecords({ record_id: rec.record_id }));
        assert.strictEqual(out.list[0].bin.doc[0].encrypted, undefined, 'no flag');
    });

    await test('OFF: an instance without the flag uploads files verbatim', async () => {
        S3.clear(); SIGNED = [];
        const plain = new Skapi(SERVICE, OWNER, { autoLogin: false });
        await plain.__connection; await plain.__authConnection;
        await new Promise(r => setTimeout(r, 50));
        plain.session = fakeSession();
        plain.__user = { user_id: ALICE, service: SERVICE, owner: OWNER, access_group: 1 };
        plain.user = { user_id: ALICE, access_group: 1 };
        CURRENT_USER = ALICE;

        await plain.postRecord({ t: 1 }, { table: { name: 't', access_group: 'private' } },
            [{ name: 'doc', file: mkFile('x.pdf', 'OFF-PATH-BODY') }]);
        assert.strictEqual(Buffer.from([...S3.values()][0]).toString(), 'OFF-PATH-BODY');
        assert.ok(!SIGNED[SIGNED.length - 1].key.includes('__skenc__'));
    });

    await test('a GRANTEE can open the files, not just the data', async () => {
        S3.clear();
        const rid = (await as(alice, () => alice.postRecord(
            { title: 'shared doc' },
            { table: { name: 't', access_group: 'private' } },
            [{ name: 'doc', file: mkFile('shared.pdf', 'SHARED-FILE-BODY') }]
        ))).record_id;
        await as(alice, () => alice.grantPrivateRecordAccess({ record_id: rid, user_id: BOB }));

        const out = await as(bob, () => bob.getRecords({ record_id: rid }));
        assert.deepStrictEqual(out.list[0].data, { title: 'shared doc' }, 'bob reads the data');
        const blob = await out.list[0].bin.doc[0].getFile('blob');
        assert.strictEqual(Buffer.from(await blob.arrayBuffer()).toString(), 'SHARED-FILE-BODY',
            'AND the file: a grantee needs the data key cached for files too');
    });

    await test('a non-recipient cannot open the file', async () => {
        // A user id used by no other test: enrolling one user under two
        // different passwords is what "Incorrect password" looks like.
        const MALLORY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
        const carol = await makeClient(MALLORY);
        await login(carol, 'mallory-password-1234');

        const rid = (await as(alice, () => alice.postRecord(
            { t: 1 },
            { table: { name: 't', access_group: 'private' } },
            [{ name: 'doc', file: mkFile('nope.pdf', 'NOT-FOR-CAROL') }]
        ))).record_id;

        const out = await as(carol, () => carol.getRecords({ record_id: rid }));
        assert.strictEqual(out.list[0].data, null);
        await assert.rejects(() => out.list[0].bin.doc[0].getFile('blob'),
            e => /not available|ENCRYPTION_LOCKED/.test(e.message + (e.code || '')));
    });

    /* ---------------- the master / service owner ---------------- */

    /** A master session: the backend short-circuits its access checks. */
    async function makeMaster() {
        const m = await makeClient(OWNER);
        // Master reads other users' private records; it has no keyring of its own.
        return m;
    }

    await test('MASTER reading a private record gets no plaintext, and is told why', async () => {
        const secret = { patient: 'confidential-master-canary' };
        const rid = (await as(alice, () => alice.postRecord(
            secret, { table: { name: 't', access_group: 'private' } }
        ))).record_id;

        const master = await makeMaster();
        // The backend lets master through, so the SDK returns the record...
        CURRENT_USER = OWNER;
        const out = await master.getRecords({ record_id: rid });

        assert.strictEqual(out.list[0].data, null, 'MASTER MUST NOT GET THE PLAINTEXT');
        assert.strictEqual(out.list[0].encrypted.status, 'failed');
        assert.strictEqual(out.list[0].encrypted.reason, 'NOT_A_RECIPIENT',
            'and is told exactly why, rather than seeing an empty record');
        assert.ok(Array.isArray(out.list[0].encrypted.recipients),
            'the recipient list is visible: it is metadata, not content');
    });

    await test('MASTER deleting a private record gets no plaintext back either', async () => {
        const secret = { ssn: 'delete-canary-987654321' };
        const rid = (await as(alice, () => alice.postRecord(
            secret, { table: { name: 't', access_group: 'private' } }
        ))).record_id;

        const master = await makeMaster();
        CURRENT_USER = OWNER;
        const res = await master.deleteRecords({ record_id: rid });

        const rec = res.list[0];
        assert.strictEqual(rec.data, null, 'the deleted payload must not come back readable');
        assert.strictEqual(rec.encrypted.reason, 'NOT_A_RECIPIENT');
        assert.ok(!JSON.stringify(rec).includes('delete-canary'), 'no plaintext anywhere in the response');
        assert.ok(!JSON.stringify(rec).includes('__skapi_enc__'),
            'and NOT the raw envelope either: ciphertext must not be handed back dressed as data');
    });

    await test('the OWNER deleting their own record DOES get their data back', async () => {
        const secret = { note: 'mine to see', n: 3 };
        const rid = (await as(alice, () => alice.postRecord(
            secret, { table: { name: 't', access_group: 'private' } }
        ))).record_id;

        const res = await as(alice, () => alice.deleteRecords({ record_id: rid }));
        assert.deepStrictEqual(res.list[0].data, secret,
            'a delete that returns the deleted record should return it readable to its owner');
        assert.strictEqual(res.list[0].encrypted.status, 'encrypted');
    });

    await test('deleting a PLAINTEXT record is unchanged', async () => {
        const rid = (await as(alice, () => alice.postRecord(
            { open: true }, { table: { name: 't', access_group: 0 } }
        ))).record_id;
        const res = await as(alice, () => alice.deleteRecords({ record_id: rid }));
        assert.deepStrictEqual(res.list[0].data, { open: true });
        assert.strictEqual(res.list[0].encrypted, undefined, 'no flag on a plaintext record');
    });

    /* ---------------- the withheld-data sentinel ---------------- */

    await test('DEFAULT is null: existing `if (record.data)` guards keep working', async () => {
        const rid = (await as(alice, () => alice.postRecord(
            { s: 1 }, { table: { name: 't', access_group: 'private' } }
        ))).record_id;
        const master = await makeMaster();
        CURRENT_USER = OWNER;
        const out = await master.getRecords({ record_id: rid });
        assert.strictEqual(out.list[0].data, null, 'default must stay null');
        assert.strictEqual(master.isWithheld(out.list[0].data), false);
    });

    await test('SENTINEL: opt-in returns a frozen, self-describing marker', async () => {
        const secret = { s: 'sentinel-canary' };
        const rid = (await as(alice, () => alice.postRecord(
            secret, { table: { name: 't', access_group: 'private' } }
        ))).record_id;

        const master = await makeClient(OWNER, {
            encryption: { iterations: 100000, persistDevice: false, withheld: 'sentinel' }
        });
        CURRENT_USER = OWNER;
        const out = await master.getRecords({ record_id: rid });
        const d = out.list[0].data;

        assert.strictEqual(master.isWithheld(d), true, 'isWithheld must recognise it');
        assert.strictEqual(d.__skapi_no_access__, true);
        assert.strictEqual(d.reason, 'NOT_A_RECIPIENT', 'the reason is carried on the value itself');
        assert.ok(Array.isArray(d.recipients));
        assert.ok(Object.isFrozen(d), 'frozen: nothing can patch it into looking like data');
        assert.ok(!JSON.stringify(out.list[0]).includes('sentinel-canary'), 'still no plaintext');

        // The documented cost, asserted so nobody is surprised by it later.
        assert.ok(d, 'the sentinel is TRUTHY: `if (record.data)` is no longer a data test');
    });

    await test('the sentinel cannot be written back over the record', async () => {
        const secret = { keep: 'safe' };
        const rid = (await as(alice, () => alice.postRecord(
            secret, { table: { name: 't', access_group: 'private' } }
        ))).record_id;

        const master = await makeClient(OWNER, {
            encryption: { iterations: 100000, persistDevice: false, withheld: 'sentinel' }
        });
        CURRENT_USER = OWNER;
        const out = await master.getRecords({ record_id: rid });

        // A naive read-modify-write by a session that could not decrypt would
        // otherwise replace the record with the placeholder.
        await assert.rejects(
            () => master.postRecord(out.list[0].data, {
                record_id: rid, table: { name: 't', access_group: 'private' }
            }),
            e => /cannot be written back|ENCRYPTION_CANNOT_REWRITE_WITHHELD/.test(e.message + (e.code || ''))
        );

        CURRENT_USER = ALICE;
        const check = await as(alice, () => alice.getRecords({ record_id: rid }));
        assert.deepStrictEqual(check.list[0].data, secret, 'the record survived untouched');
    });

    await test('the sentinel reaches deleteRecords too', async () => {
        const rid = (await as(alice, () => alice.postRecord(
            { s: 2 }, { table: { name: 't', access_group: 'private' } }
        ))).record_id;
        const master = await makeClient(OWNER, {
            encryption: { iterations: 100000, persistDevice: false, withheld: 'sentinel' }
        });
        CURRENT_USER = OWNER;
        const res = await master.deleteRecords({ record_id: rid });
        assert.strictEqual(master.isWithheld(res.list[0].data), true);
    });

    /* ---------------- the S3 data spill ---------------- */

    await test('THE SPILL IS CIPHERTEXT: oversized private data offloaded to S3', async () => {
        // When `data` no longer fits the DynamoDB item the backend writes it to
        // S3 verbatim and stores only a marker. Because the client encrypts
        // BEFORE the request leaves, what lands in the bucket is the envelope:
        // the spill needs no separate encryption, but that has to be true rather
        // than assumed, so assert on the bytes the mock actually wrote.
        OFFLOAD_OVER = 200;
        try {
            const big = { secret: 'x'.repeat(500), marker: 'SPILLED-PLAINTEXT-CANARY' };
            const rec = await as(alice, () => alice.postRecord(big, {
                table: { name: 't', access_group: 'private' }
            }));

            assert.ok(stored(rec.record_id).__data__, 'the record must hold only the offload marker');
            const spilled = OFFLOAD_BODIES.get(rec.record_id);
            assert.ok(spilled, 'something must have been written to S3');
            assert.ok(!spilled.includes('SPILLED-PLAINTEXT-CANARY'), 'THE SPILLED FILE MUST NOT CONTAIN PLAINTEXT');
            assert.ok(JSON.parse(spilled).__skapi_enc__, 'the spilled file is the envelope');

            assert.deepStrictEqual(rec.data, big, 'the caller still gets their plaintext back');
        }
        finally {
            OFFLOAD_OVER = 0;
        }
    });

    await test('an offloaded private record reads back decrypted', async () => {
        OFFLOAD_OVER = 200;
        try {
            const big = { rows: Array.from({ length: 40 }, (_, i) => ({ i, v: 'value-' + i })) };
            const rec = await as(alice, () => alice.postRecord(big, {
                table: { name: 't', access_group: 'private' }
            }));
            assert.ok(OFFLOAD_BODIES.has(rec.record_id), 'must have offloaded');

            // Fetch it back: normalizeRecord downloads the S3 body, and the
            // decrypt hook has to run AFTER that fetch, not before.
            const out = await as(alice, () => alice.getRecords({ record_id: rec.record_id }));
            assert.deepStrictEqual(out.list[0].data, big);
            assert.strictEqual(out.list[0].encrypted.status, 'encrypted');
        }
        finally {
            OFFLOAD_OVER = 0;
        }
    });

    /* ---------------- regressions for the security review ---------------- */

    await test('UNDEFINED preserves: a metadata-only update leaves the payload alone', async () => {
        const rec = await as(alice, () => alice.postRecord(
            { keep: 'this value' },
            { table: { name: 't', access_group: 'private' } }
        ));
        const before = JSON.stringify(stored(rec.record_id));

        POST_BODIES = [];
        await as(alice, () => alice.postRecord(undefined, {
            record_id: rec.record_id,
            table: { name: 't', access_group: 'private' },
            tags: ['added']
        }));

        const body = POST_BODIES[POST_BODIES.length - 1];
        assert.ok(!Object.prototype.hasOwnProperty.call(body, 'data'),
            'undefined must send NO data key at all');
        assert.strictEqual(JSON.stringify(stored(rec.record_id)), before, 'the stored envelope must be untouched');
        const out = await as(alice, () => alice.getRecords({ record_id: rec.record_id }));
        assert.deepStrictEqual(out.list[0].data, { keep: 'this value' });
    });

    await test('NULL is a real value: it is stored, not treated as "no payload"', async () => {
        const rec = await as(alice, () => alice.postRecord(
            { was: 'here' },
            { table: { name: 't', access_group: 'private' } }
        ));

        POST_BODIES = [];
        await as(alice, () => alice.postRecord(null, {
            record_id: rec.record_id,
            table: { name: 't', access_group: 'private' }
        }));

        const body = POST_BODIES[POST_BODIES.length - 1];
        assert.ok(Object.prototype.hasOwnProperty.call(body, 'data'),
            'null must SEND a data key, unlike undefined');
        assert.ok(stored(rec.record_id).__skapi_enc__,
            'and it is encrypted like any other value, so "the data is null" is not visible to the provider');

        const out = await as(alice, () => alice.getRecords({ record_id: rec.record_id }));
        assert.strictEqual(out.list[0].data, null, 'and it reads back as null');
    });

    await test('null and undefined are not interchangeable', async () => {
        const rec = await as(alice, () => alice.postRecord(
            { v: 'original' },
            { table: { name: 't', access_group: 'private' } }
        ));
        // null overwrites
        await as(alice, () => alice.postRecord(null, { record_id: rec.record_id, table: { name: 't', access_group: 'private' } }));
        assert.strictEqual((await as(alice, () => alice.getRecords({ record_id: rec.record_id }))).list[0].data, null);
        // undefined then preserves that null
        await as(alice, () => alice.postRecord(undefined, { record_id: rec.record_id, table: { name: 't', access_group: 'private' }, tags: ['x'] }));
        assert.strictEqual((await as(alice, () => alice.getRecords({ record_id: rec.record_id }))).list[0].data, null);
    });

    await test('DECLASSIFY WITHOUT DATA now decrypts and re-saves, instead of refusing', async () => {
        const secret = { was: 'encrypted', n: 7 };
        const rec = await as(alice, () => alice.postRecord(
            secret,
            { table: { name: 't', access_group: 'private' } }
        ));
        assert.ok(stored(rec.record_id).__skapi_enc__, 'starts encrypted');

        // No payload restated. The SDK reads it while it is still private,
        // decrypts, and writes the plaintext with the group change.
        await as(alice, () => alice.postRecord(undefined, {
            record_id: rec.record_id,
            table: { name: 't', access_group: 0 }
        }));

        assert.deepStrictEqual(stored(rec.record_id), secret,
            'the record must now hold PLAINTEXT, not a stranded envelope');
        const out = await as(alice, () => alice.getRecords({ record_id: rec.record_id }));
        assert.deepStrictEqual(out.list[0].data, secret);
        assert.strictEqual(out.list[0].encrypted, undefined, 'and carries no encryption flag');
    });

    await test('declassify still refuses when the data cannot be decrypted', async () => {
        const rec = await as(alice, () => alice.postRecord(
            { locked: 'away' },
            { table: { name: 't', access_group: 'private' } }
        ));
        await alice.lockEncryption();
        try {
            await assert.rejects(
                () => as(alice, () => alice.postRecord(undefined, {
                    record_id: rec.record_id,
                    table: { name: 't', access_group: 0 }
                })),
                e => /could not be decrypted|ENCRYPTION_LOCKED/.test(e.message + (e.code || ''))
            );
            assert.ok(stored(rec.record_id).__skapi_enc__, 'the record is untouched');
        }
        finally {
            await login(alice, 'correct horse battery staple');
        }
    });

    await test('a record with NO data key at all is unaffected by the unreadable guard', async () => {
        // The guard fires only on an offload MARKER whose file cannot be
        // fetched. A record that simply has no `data` attribute never reaches
        // the data handler at all (normalizeRecord's dispatch loop is guarded by
        // record.hasOwnProperty), so it carries no flag and sharing works
        // normally. This is why the guard tests the FLAG and not `data == null`.
        const rid = 'VQnodatakey00001';
        STORE.set(rid, { rec: rid, usr: ALICE, table: 't', group: 'private', unique_id: '', upd: 1 });
        delete STORE.get(rid).data;

        const out = await as(alice, () => alice.getRecords({ record_id: rid }));
        assert.strictEqual(out.list[0].data, undefined, 'no data key reads as undefined');
        assert.strictEqual(out.list[0].encrypted, undefined, 'and carries NO flag');

        // Sharing must still work: it is a plaintext record as far as we know.
        await as(alice, () => alice.grantPrivateRecordAccess({ record_id: rid, user_id: BOB }));
        await as(alice, () => alice.removePrivateRecordAccess({ record_id: rid, user_id: BOB }));
    });

    await test('a record whose stored data IS null is also unaffected', async () => {
        const rid = 'VQstorednull0001';
        STORE.set(rid, { rec: rid, usr: ALICE, table: 't', group: 'private', unique_id: '', data: null, upd: 1 });

        const out = await as(alice, () => alice.getRecords({ record_id: rid }));
        assert.strictEqual(out.list[0].data, null);
        assert.strictEqual(out.list[0].encrypted, undefined, 'a stored null is a VALUE, not a read failure');
        await as(alice, () => alice.grantPrivateRecordAccess({ record_id: rid, user_id: BOB }));
    });

    await test('AN UNREADABLE SPILL blocks grant and revoke instead of silently misbehaving', async () => {
        OFFLOAD_OVER = 200;
        let rid;
        try {
            rid = (await as(alice, () => alice.postRecord(
                { big: 'x'.repeat(500) },
                { table: { name: 't', access_group: 'private' } }
            ))).record_id;
            await as(alice, () => alice.grantPrivateRecordAccess({ record_id: rid, user_id: BOB }));
        }
        finally {
            OFFLOAD_OVER = 0;
        }

        // Now make the spilled file unfetchable, exactly as a transient S3
        // failure or a deliberately 404'd object would.
        const saved = OFFLOAD_BODIES.get(rid);
        OFFLOAD_BODIES.delete(rid);
        alice.__cached_requests = {};

        const read = await as(alice, () => alice.getRecords({ record_id: rid }));
        assert.strictEqual(read.list[0].data, null);
        assert.strictEqual(read.list[0].encrypted.reason, 'DATA_UNAVAILABLE',
            'an unreadable payload must be REPORTED, not look like a plaintext record');

        // The bug: both of these used to succeed. Grant created an ACL row with
        // no key wrap; revoke skipped the key roll entirely and reported success.
        await assert.rejects(
            () => as(alice, () => alice.grantPrivateRecordAccess({ record_id: rid, user_id: BOB })),
            e => /could not be read|ENCRYPTION_DATA_UNAVAILABLE/.test(e.message + (e.code || '')),
            'grant must refuse'
        );
        const before = JSON.stringify(stored(rid));
        await assert.rejects(
            () => as(alice, () => alice.removePrivateRecordAccess({ record_id: rid, user_id: BOB })),
            e => /could not be read|ENCRYPTION_DATA_UNAVAILABLE/.test(e.message + (e.code || '')),
            'revoke must refuse rather than silently skip the key roll'
        );
        assert.strictEqual(JSON.stringify(stored(rid)), before, 'and must not have half-changed the record');

        OFFLOAD_BODIES.set(rid, saved);
    });

    await test('REGRESSION: data passed in the CONFIG cannot bypass encryption', async () => {
        POST_BODIES = [];
        const rec = await as(alice, () => alice.postRecord(null, {
            table: { name: 't', access_group: 'private' },
            data: { leaked: 'via-config' }
        }));
        const onWire = POST_BODIES[POST_BODIES.length - 1].data;
        assert.ok(!JSON.stringify(onWire || {}).includes('via-config'), 'config.data must not reach the server in the clear');
        assert.ok(!JSON.stringify(stored(rec.record_id) || {}).includes('via-config'), 'nor be stored in the clear');
    });

    await test('REGRESSION: a cold-cache update preserves every grantee', async () => {
        const rid = (await as(alice, () => alice.postRecord(
            { doc: 'v1' },
            { table: { name: 't', access_group: 'private' } }
        ))).record_id;
        await as(alice, () => alice.grantPrivateRecordAccess({ record_id: rid, user_id: BOB }));
        assert.ok(stored(rid).k[BOB], 'bob is a recipient');

        // A DIFFERENT session: a page reload, a second device. Its DEK cache is
        // empty, and it states the table so nothing forces a read. This used to
        // mint a fresh key with an owner-only recipient map, silently revoking
        // bob while the backend ACL still said the record was shared.
        const fresh = await makeClient(ALICE);
        CURRENT_USER = ALICE;
        await fresh.unlockEncryption({ password: 'correct horse battery staple' });
        await as(fresh, () => fresh.postRecord({ doc: 'v2' }, {
            record_id: rid,
            table: { name: 't', access_group: 'private' }
        }));

        assert.ok(stored(rid).k[BOB], 'BOB MUST STILL BE A RECIPIENT after a cold-cache update');
        const out = await as(bob, () => bob.getRecords({ record_id: rid }));
        assert.deepStrictEqual(out.list[0].data, { doc: 'v2' }, 'and he must read the new version');
    });

    await test('REGRESSION: revoking one user keeps the others', async () => {
        const CAROL = '44444444-4444-4444-8444-444444444444';
        const carol = await makeClient(CAROL);
        await login(carol, 'carol-password-1234');

        const rid = (await as(alice, () => alice.postRecord(
            { team: 'doc' },
            { table: { name: 't', access_group: 'private' } }
        ))).record_id;
        await as(alice, () => alice.grantPrivateRecordAccess({ record_id: rid, user_id: [BOB, CAROL] }));
        assert.ok(stored(rid).k[BOB] && stored(rid).k[CAROL]);

        await as(alice, () => alice.removePrivateRecordAccess({ record_id: rid, user_id: BOB }));

        assert.ok(!stored(rid).k[BOB], 'bob is out');
        assert.ok(stored(rid).k[CAROL], 'CAROL MUST KEEP ACCESS through the key roll');
        const out = await as(carol, () => carol.getRecords({ record_id: rid }));
        assert.deepStrictEqual(out.list[0].data, { team: 'doc' }, 'and can still read it');
    });

    await test('REGRESSION: a locked session cannot change the password silently', async () => {
        const locked = await makeClient(ALICE);
        CURRENT_USER = ALICE;
        // Locked: changing the Cognito password here would leave the keyring
        // wrapped under a password that no longer exists.
        await assert.rejects(
            () => locked.changePassword({
                current_password: 'correct horse battery staple',
                new_password: 'a-brand-new-password'
            }),
            e => /unlocked before changing the password|ENCRYPTION_LOCKED/.test(e.message + (e.code || ''))
        );
    });

    await test('REGRESSION: a plaintext record can still be shared while locked', async () => {
        const rid = 'VQplaintextshare1';
        STORE.set(rid, { rec: rid, usr: ALICE, table: 't', group: 'private', unique_id: '', data: { legacy: true }, upd: 1 });

        const locked = await makeClient(ALICE);
        CURRENT_USER = ALICE;
        assert.strictEqual(locked.getEncryptionStatus().status, 'locked');
        // Records written before the feature was enabled must keep working.
        await as(locked, () => locked.grantPrivateRecordAccess({ record_id: rid, user_id: BOB }));
        assert.deepStrictEqual(stored(rid), { legacy: true }, 'still plaintext, still shareable');
    });

    await test('REGRESSION: with encryption OFF an envelope is not handed to the app as data', async () => {
        const off = new Skapi(SERVICE, OWNER, { autoLogin: false });
        await off.__connection;
        await off.__authConnection;
        await new Promise(r => setTimeout(r, 50));
        off.session = fakeSession();
        off.__user = { user_id: ALICE, service: SERVICE, owner: OWNER, access_group: 1 };
        off.user = { user_id: ALICE, access_group: 1 };
        CURRENT_USER = ALICE;

        const out = await off.getRecords({ record_id: RID });
        assert.strictEqual(out.list[0].data, null, 'must not leak the raw envelope as data');
        assert.strictEqual(out.list[0].encrypted.reason, 'ENCRYPTION_DISABLED');
    });

    await test('REGRESSION: a unique_id used as record_id resolves to the real record', async () => {
        // postRecord documents that a unique_id may be passed in the record_id
        // slot. Reading it verbatim anchored the envelope to the unique_id
        // string (making the record permanently undecryptable) and, because the
        // key cache is keyed by the REAL record_id, minted a fresh key that
        // dropped every grantee.
        const UID = 'src::folder/report.pdf';
        const rec = await as(alice, () => alice.postRecord(
            { v: 1 },
            { table: { name: 't', access_group: 'private' }, unique_id: UID }
        ));
        assert.ok(stored(rec.record_id).__skapi_enc__);

        await as(alice, () => alice.postRecord({ v: 2 }, {
            record_id: UID,
            table: { name: 't', access_group: 'private' }
        }));

        const env = stored(rec.record_id);
        assert.strictEqual(env.anch, 'uid', 'anchored to the unique_id, not a bogus rid');
        assert.strictEqual(env.uid, UID);

        const out = await as(alice, () => alice.getRecords({ record_id: rec.record_id }));
        assert.deepStrictEqual(out.list[0].data, { v: 2 }, 'and it still decrypts');
    });

    await test('REGRESSION: persistDevice does not deadlock the connection', async () => {
        // unlockFromDevice reads the keyring with getRecords; getRecords awaits
        // __connection; __connection awaits __authConnection. Awaiting the
        // unlock inside __authConnection closed that cycle and hung every call
        // on the instance, on every reload after a password login.
        IDB.clear();
        const first = await makeClient(ALICE, { encryption: { iterations: 100000, persistDevice: true } });
        CURRENT_USER = ALICE;
        await first.unlockEncryption({ password: 'correct horse battery staple' });
        assert.ok(IDB.size > 0, 'the device entry must have been written');

        const reloaded = new Skapi(SERVICE, OWNER, {
            autoLogin: true,
            encryption: { iterations: 100000, persistDevice: true }
        });
        const settled = await Promise.race([
            reloaded.__connection.then(() => 'connected').catch(() => 'connected'),
            new Promise(r => setTimeout(() => r('DEADLOCK'), 4000))
        ]);
        assert.strictEqual(settled, 'connected', 'the connection promise must settle');
    });

    /* ---------------- recovery codes ---------------- */

    await test('enrollment issues a recovery code, exactly once', async () => {
        const DAVE = '55555555-5555-4555-8555-555555555555';
        const dave = await makeClient(DAVE);
        await login(dave, 'dave-password-2468');

        const code = dave.takeRecoveryCode();
        assert.ok(code, 'a code must be issued at enrollment');
        assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/, 'got ' + code);
        assert.strictEqual(dave.takeRecoveryCode(), null, 'and must be collectable only ONCE');
    });

    await test('THE CODE NEVER REACHES THE SERVER', async () => {
        const ERIN = '66666666-6666-4666-8666-666666666666';
        POST_BODIES = [];
        const erin = await makeClient(ERIN);
        await login(erin, 'erin-password-1357');
        const code = erin.takeRecoveryCode();

        // The whole guarantee rests on this: only the WRAP is stored, never the
        // code. A server that ever saw the code could decrypt everything.
        const bodies = JSON.stringify(POST_BODIES);
        const bare = code.replace(/-/g, '');
        assert.ok(!bodies.includes(code), 'the code must not appear in any request body');
        assert.ok(!bodies.includes(bare), 'nor without its formatting');

        const kr = [...STORE.values()].find(r => r.table === 'skapi__keyring' && r.usr === ERIN && groupWire(r.group) === '**');
        assert.ok(!JSON.stringify(kr.data).includes(bare), 'nor anywhere in the stored keyring');
        const rw = kr.data.wraps.find(w => w.p === 'recovery');
        assert.ok(rw, 'but the recovery WRAP must be stored');
        assert.strictEqual(rw.kdf.a, 'HKDF-SHA256', 'and derived with HKDF, not PBKDF2');
    });

    await test('THE FULL JOURNEY: forgotten password, recovered with the code', async () => {
        const FRANK = '77777777-7777-4777-8777-777777777777';
        const frank = await makeClient(FRANK);
        await login(frank, 'frank-old-password');
        const code = frank.takeRecoveryCode();

        const rid = (await as(frank, () => frank.postRecord(
            { diary: 'written under the old password' },
            { table: { name: 't', access_group: 'private' } }
        ))).record_id;

        // Password reset: Cognito's password changes, the keyring does not. This
        // is the state that used to mean permanent data loss.
        const after = await makeClient(FRANK);
        CURRENT_USER = FRANK;
        await assert.rejects(
            () => after.unlockEncryption({ password: 'frank-NEW-password' }),
            'the new password cannot open a keyring wrapped under the old one'
        );
        assert.strictEqual(after.getEncryptionStatus().status, 'locked');

        let out = await as(after, () => after.getRecords({ record_id: rid }));
        assert.strictEqual(out.list[0].data, null);
        assert.strictEqual(out.list[0].encrypted.reason, 'NO_SESSION_KEY');

        // Recovery, with the new password so the keyring is repaired too.
        const res = await after.unlockWithRecoveryCode({ code, password: 'frank-NEW-password' });
        assert.strictEqual(res.status, 'unlocked');
        assert.strictEqual(res.repaired, true);
        assert.ok(res.recoveryCode, 'a replacement code must be issued');
        assert.notStrictEqual(res.recoveryCode, code, 'and it must be a NEW code');

        out = await as(after, () => after.getRecords({ record_id: rid }));
        assert.deepStrictEqual(out.list[0].data, { diary: 'written under the old password' }, 'THE DATA IS BACK');

        // And the repair holds: a completely fresh session opens with the new
        // password alone, no code needed.
        const later = await makeClient(FRANK);
        CURRENT_USER = FRANK;
        await later.unlockEncryption({ password: 'frank-NEW-password' });
        const back = await as(later, () => later.getRecords({ record_id: rid }));
        assert.deepStrictEqual(back.list[0].data, { diary: 'written under the old password' });
    });

    await test('a used recovery code is retired', async () => {
        const GINA = '88888888-8888-4888-8888-888888888888';
        const gina = await makeClient(GINA);
        await login(gina, 'gina-password-0000');
        const first = gina.takeRecoveryCode();

        const s1 = await makeClient(GINA);
        CURRENT_USER = GINA;
        const res = await s1.unlockWithRecoveryCode({ code: first, password: 'gina-password-0000' });

        // The old code must no longer work; the replacement must.
        const s2 = await makeClient(GINA);
        CURRENT_USER = GINA;
        await assert.rejects(
            () => s2.unlockWithRecoveryCode({ code: first }),
            e => /did not open the keyring/.test(e.message)
        );

        const s3 = await makeClient(GINA);
        CURRENT_USER = GINA;
        const again = await s3.unlockWithRecoveryCode({ code: res.recoveryCode });
        assert.strictEqual(again.status, 'unlocked', 'the replacement code works');
    });

    await test('a wrong recovery code fails, and a typo fails differently', async () => {
        const HANK = '99999999-9999-4999-8999-999999999999';
        const hank = await makeClient(HANK);
        await login(hank, 'hank-password-9999');
        hank.takeRecoveryCode();

        const s1 = await makeClient(HANK);
        CURRENT_USER = HANK;
        // Well-formed but wrong: reaches the crypto and fails there.
        await assert.rejects(
            () => s1.unlockWithRecoveryCode({ code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ' }),
            e => /did not open the keyring|typo/.test(e.message)
        );
        // Malformed: rejected on shape, before any crypto runs.
        await assert.rejects(
            () => s1.unlockWithRecoveryCode({ code: 'nope' }),
            e => /does not look like a recovery code/.test(e.message)
        );
        assert.strictEqual(s1.getEncryptionStatus().status, 'locked');
    });

    await test('regenerateRecoveryCode requires an unlocked session', async () => {
        const IVAN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const ivan = await makeClient(IVAN);
        await login(ivan, 'ivan-password-1122');
        ivan.takeRecoveryCode();

        const fresh = await ivan.regenerateRecoveryCode();
        assert.ok(fresh.recoveryCode, 'an unlocked user can rotate');

        // A locked session must not be able to mint one: that would be a path to
        // a recovery code without proving any access.
        const locked = await makeClient(IVAN);
        CURRENT_USER = IVAN;
        await assert.rejects(
            () => locked.regenerateRecoveryCode(),
            e => /unlocked/.test(e.message)
        );

        // And the rotated code opens the account.
        const s2 = await makeClient(IVAN);
        CURRENT_USER = IVAN;
        const r = await s2.unlockWithRecoveryCode({ code: fresh.recoveryCode });
        assert.strictEqual(r.status, 'unlocked');
    });

    await test('recovery: none issues no code and stores no recovery wrap', async () => {
        const JUDY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
        const judy = await makeClient(JUDY, { encryption: { iterations: 100000, persistDevice: false, recovery: 'none' } });
        await login(judy, 'judy-password-3344');
        assert.strictEqual(judy.takeRecoveryCode(), null);

        const kr = [...STORE.values()].find(r => r.table === 'skapi__keyring' && r.usr === JUDY && groupWire(r.group) === '**');
        assert.ok(!kr.data.wraps.some(w => w.p === 'recovery'), 'no recovery wrap when opted out');
    });

    await test('rewrapping the password wrap does not clobber the recovery wrap', async () => {
        // The real changePassword path cannot be driven from here: `cognitoUser`
        // is module-private in user.ts, so there is no way to stub the Cognito
        // call. What IS reachable is the same wrap-array surgery that
        // pruneKeyringWraps and rewrapForPasswordChange perform, which is where
        // the actual risk lives: two filters over one array, each capable of
        // dropping the other's entry.
        const KARL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
        const karl = await makeClient(KARL);
        await login(karl, 'karl-password-old1');
        const code = karl.takeRecoveryCode();

        const s2 = await makeClient(KARL);
        CURRENT_USER = KARL;
        const res = await s2.unlockWithRecoveryCode({ code, password: 'karl-password-new1' });

        const kr = [...STORE.values()].find(r => r.table === 'skapi__keyring' && r.usr === KARL && groupWire(r.group) === '**');
        const pw = kr.data.wraps.filter(w => w.p === 'password');
        const rw = kr.data.wraps.filter(w => w.p === 'recovery');
        assert.strictEqual(pw.length, 1, 'exactly one password wrap, under the new password');
        assert.strictEqual(rw.length, 1, 'exactly one recovery wrap, the replacement');
        assert.ok(kr.data.self && kr.data.self.ct, 'the self wrap must survive too, or rotation breaks');

        // Both new credentials must work independently.
        const s3 = await makeClient(KARL);
        CURRENT_USER = KARL;
        await s3.unlockEncryption({ password: 'karl-password-new1' });
        assert.strictEqual(s3.getEncryptionStatus().status, 'unlocked', 'the new password opens it');

        const s4 = await makeClient(KARL);
        CURRENT_USER = KARL;
        const r = await s4.unlockWithRecoveryCode({ code: res.recoveryCode });
        assert.strictEqual(r.status, 'unlocked', 'and so does the replacement code');
    });

    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})();

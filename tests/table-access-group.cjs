/**
 * `table.access_group`: what the SDK writes onto a table, and what it must not.
 *
 * There is no project-wide default any more. `default_access_group`, both as an
 * init option and as a project setting, is gone: a project that wants its data
 * behind a sign-in states `access_group` on the call, or keeps that decision in
 * its own database. What is left is one small, exact rule, and this file is the
 * only thing pinning it:
 *
 *   getRecords / deleteRecords
 *     table: 'name'   -> { name: 'name', access_group: 0 }
 *     table: { name } -> { name }, with NO access_group key
 *   postRecord CREATE (no record_id)
 *     table: 'name'   -> { name: 'name', access_group: 0 }
 *     table: { name } -> { name }, with NO access_group key
 *   postRecord UPDATE (record_id present)
 *     NEITHER form gains an access_group.
 *
 * The two forms are deliberately DIFFERENT requests, not two spellings of one.
 * The shorthand has always MEANT group 0; the object form has always sent no
 * group and let the backend decide, which for an authenticated read means
 * "every group I can read". Collapsing them either way silently changes what an
 * existing app fetches.
 *
 * The UPDATE line is the one that is new, and it is not a revert: the published
 * 1.8.3 did put access_group 0 on the shorthand when updating. It no longer
 * does, because post_record backfills the group from the STORED record whenever
 * a table arrives without one (infra/record/record/post_record/index.py:738), so
 * "no group" reads as "keep the record where it is". Writing a 0 there is a MOVE
 * to public that the caller never asked for, and for a record that was private
 * it is a declassification.
 *
 * Which is why the last section exists. Under the update rule the encryption
 * layer and the wire can disagree, and only on one shape: an UPDATE with a
 * string table. `resolveWriteGroup` maps a RAW string table to group 0, so read
 * from the caller's raw config that write looks like a move to public,
 * `maybeEncrypt` takes the declassification branch, sends `data` in the clear
 * and zeroizes the DEK, while the wire carries no group and the server keeps the
 * record private. Plaintext sitting in a record the caller believes is sealed.
 * `encryptionView()` (database.ts) is what stops it, by showing encryption the
 * VALIDATED table, and the last section is what keeps encryptionView() alive.
 *
 * A CREATE cannot catch that: the raw string and the validated
 * `{ name, access_group: 0 }` both resolve to 0, so the two views agree and
 * plaintext is the CORRECT outcome. Only an UPDATE against a stored private
 * record makes them diverge.
 *
 * These tests drive the REAL built bundle with the network stubbed, and assert
 * on the bytes that would go on the wire.
 *
 * Run: node ./tests/table-access-group.cjs
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

/* ------------------------------------------------------------------ *
 * A browser, as far as the SDK is concerned.
 *
 * MUST run before the bundle is required: the SDK decides ONCE, at module load,
 * whether it is in a browser (`utils.isNodeRuntime()` tests `typeof window`),
 * and the whole encryption path is skipped in Node. Without this the last
 * section of this file would pass vacuously, which is the exact opposite of
 * what it is for.
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
globalThis.FileReader = class FileReader {
    readAsDataURL(blob) {
        blob.arrayBuffer().then(ab => {
            this.result = 'data:application/json;base64,' + Buffer.from(ab).toString('base64');
            if (this.onloadend) this.onloadend();
        }).catch(err => { if (this.onerror) this.onerror(err); });
    }
};

const { Skapi } = require(process.env.SKAPI_BUNDLE || '../dist/skapi.cjs');

const FIXTURES = path.join(__dirname, 'fixtures');
const OWNER = '4d4a36a5-b318-4093-92ae-7cf11feae989';
const SERVICE = 'ap21AAAAAAAAAAAAAAAA';
const ALICE = '11111111-1111-4111-8111-111111111111';

/* ------------------------------------------------------------------ *
 * In-memory record store, standing in for DynamoDB, plus a capture of every
 * request body.
 *
 * The store is not decoration for the wire assertions: the encryption section
 * needs a record that really is stored private, so that reading its group back
 * is a real answer and not a fixture. It also mirrors the one backend rule this
 * whole change rests on: an update that carries no access_group leaves the
 * record's group ALONE.
 * ------------------------------------------------------------------ */

let STORE = new Map();     // record_id -> { rec, usr, table, group, unique_id, data, upd }
let SEQ = 0;
let captured = [];         // { kind: 'post' | 'get' | 'del', url, body }
let CURRENT_USER = null;   // who the mock believes is calling, for owner scoping

const groupWire = g => (g === 'private' || g === '**') ? '**' : g === 'public' ? '00' : g === 'authorized' ? '01' : String(g).padStart(2, '0');
const jsonResponse = o => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

function rawOf(r) {
    return {
        rec: r.rec,
        usr: r.usr,
        ip: r.unique_id ? `1.1.1.1#${r.unique_id}` : '1.1.1.1',
        tbl: `${r.table}/svc/${groupWire(r.group)}`,
        data: r.data,
        upd: r.upd || 1
    };
}

function handlePost(body) {
    let rid = body.record_id;
    let existing = rid ? STORE.get(rid) : null;

    if (!existing) {
        rid = rid || `VQ${String(++SEQ).padStart(14, '0')}`;
        existing = {
            rec: rid,
            usr: body.__test_user__ || OWNER,
            table: body.table?.name || 't',
            group: body.table?.access_group === undefined ? 0 : body.table.access_group,
            unique_id: body.unique_id || '',
            data: null,
            upd: 1
        };
        STORE.set(rid, existing);
    }
    else {
        // THE backend rule this change depends on. post_record backfills the
        // group from the stored record when the table arrives without one, so
        // an update states the group only when the caller restated it, and an
        // update that omits it moves nothing.
        if (body.table?.access_group !== undefined) {
            existing.group = body.table.access_group;
        }
        if (body.table?.name) {
            existing.table = body.table.name;
        }
        existing.upd++;
    }
    // The real backend writes `data` only when the key is present in the body;
    // a metadata-only update leaves the stored value alone.
    if (Object.prototype.hasOwnProperty.call(body, 'data')) {
        existing.data = body.data === undefined ? null : body.data;
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
    // A private-table listing is owner-scoped server-side.
    if (CURRENT_USER && (body.table?.access_group === 'private' || groupWire(body.table?.access_group) === '**')) {
        out = out.filter(r => r.usr === CURRENT_USER);
    }
    return { list: out.map(rawOf), endOfList: true };
}

globalThis.fetch = async (url, opt) => {
    const u = String(url);
    if (/\/admin-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'admin-v1.json')));
    if (/\/record-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'record-v1.json')));

    let body = null;
    try { body = JSON.parse(opt && opt.body); } catch (e) { body = opt && opt.body; }

    if (u.includes('post-record')) {
        captured.push({ kind: 'post', url: u, body });
        body.__test_user__ = CURRENT_USER;
        return jsonResponse(handlePost(body));
    }
    if (u.includes('get-records')) {
        captured.push({ kind: 'get', url: u, body });
        return jsonResponse(handleGet(body));
    }
    if (u.includes('del-records')) {
        captured.push({ kind: 'del', url: u, body });
        const r = body && STORE.get(body.record_id);
        if (r) STORE.delete(body.record_id);
        return jsonResponse({
            list: r ? [{
                rec: r.rec,
                usr_tbl: `${r.usr}/${r.table}/svc/${groupWire(r.group)}`,
                ip: r.unique_id ? `1.1.1.1#${r.unique_id}` : '1.1.1.1',
                data: r.data
            }] : [],
            endOfList: true
        });
    }
    return jsonResponse({ ip: '127.0.0.1', locale: 'KR', service_name: 'test', group: 99, opt: {} });
};

// Presenting a `window` above takes the browser branch of the network layer,
// which reaches for XHR, so there is nothing left to delegate to. Everything
// here funnels back into the mocked fetch.
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
                if (this.responseType === 'blob') this.response = await r.blob();
                else if (this.responseType === 'arraybuffer') this.response = await r.arrayBuffer();
                else if (this.responseType === 'json') { try { this.response = await r.json(); } catch (e) { this.response = null; } }
                else { this.responseText = await r.text(); this.response = this.responseText; }
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

/* ------------------------------------------------------------------ *
 * A minimal IndexedDB, so the encryption layer's device-store probe has
 * something to talk to instead of throwing on an absent global.
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
                transaction() {
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

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

const farFuture = Math.floor(Date.now() / 1000) + 86400;
function fakeSession() {
    // A DAY out, not an hour: getJwtToken refreshes when the expiry is inside
    // TOKEN_REFRESH_SKEW_SECONDS, which is itself 3600, so an expiry of
    // now + 3600 sits exactly on the boundary and trips the refresh path the
    // moment a second ticks over mid-run.
    return {
        getIdToken: () => ({ getExpiration: () => farFuture, getJwtToken: () => 'stub.id.token' }),
        getAccessToken: () => ({ getJwtToken: () => 'stub.access.token' }),
        idToken: { payload: { exp: farFuture }, jwtToken: 'stub.id.token' },
        accessToken: { payload: { exp: farFuture }, jwtToken: 'stub.access.token' },
        getRefreshToken: () => ({ getToken: () => 'stub.refresh.token' }),
        refreshToken: { token: 'stub.refresh.token' }
    };
}

async function signIn(skapi, user_id) {
    // Both promises, then a tick. __authConnection calls _out() WITHOUT
    // awaiting it (user.ts, the "wasn't logged in" path), so the clear lands a
    // microtask after __authConnection resolves and would wipe the user we are
    // about to fake in.
    await skapi.__connection;
    await skapi.__authConnection;
    await new Promise(r => setTimeout(r, 50));
    skapi.session = fakeSession();
    // `service` is not decoration: getQuery calls checkAdmin, which LOGS THE
    // USER OUT when the profile's service does not match the instance's.
    // Without it the stub is torn down mid-call and every table query silently
    // reverts to the unsigned path, which is the opposite of what is tested.
    skapi.__user = { user_id, service: SERVICE, owner: OWNER, access_group: 99 };
    skapi.user = { user_id, access_group: 99 };
    CURRENT_USER = user_id;
    return skapi;
}

/**
 * A signed-in instance with encryption OFF, for the wire-shape assertions.
 *
 * Every one of those is about a SIGNED-IN caller: `accessGroup` refuses a
 * non-zero group for an unsigned one, and an unsigned postRecord is refused
 * outright, either of which would mask what is being checked.
 *
 * This also RESETS the record store, so no test inherits another's records.
 * That is why every wire test runs before the encryption section: clearing the
 * store after it would take alice's keyring with it.
 */
async function makeSkapi(options) {
    captured = [];
    STORE = new Map();
    const s = new Skapi(SERVICE, OWNER, Object.assign({ autoLogin: false }, options || {}));
    return signIn(s, OWNER);
}

/** A signed-in instance with encryption ON. Cognito is bypassed, the encryption layer is not. */
async function makeClient(user_id, opts) {
    const s = new Skapi(SERVICE, OWNER, Object.assign({
        autoLogin: false,
        encryption: { iterations: 100000, persistDevice: false }
    }, opts || {}));
    return signIn(s, user_id);
}

function lastBody(kind) {
    const c = [...captured].reverse().find(x => x.kind === kind);
    assert.ok(c, `expected a ${kind} request`);
    return c.body;
}

function lastTable(kind) {
    const b = lastBody(kind);
    return b && b.table;
}

/**
 * The key must be ABSENT, not merely undefined.
 *
 * The capture is a JSON round trip, so an `access_group: undefined` would have
 * been dropped on the way out anyway. Asserting on the key itself keeps that
 * honest if the capture ever stops going through JSON, and says what is
 * actually being claimed: no access_group reaches the server at all.
 */
function assertNoGroup(table, msg) {
    assert.ok(table && typeof table === 'object', 'expected a table object, got ' + JSON.stringify(table));
    assert.ok(!Object.prototype.hasOwnProperty.call(table, 'access_group'),
        msg + ' (the table went out as ' + JSON.stringify(table) + ')');
}

/** The value the server actually holds for a record. */
const stored = rid => STORE.get(rid).data;

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

(async () => {

/* ---- getRecords --------------------------------------------------------- */

await test('getRecords: a string table is expanded to group 0', async () => {
    const s = await makeSkapi();
    await s.getRecords({ table: 'notes' });
    assert.strictEqual(lastTable('get').name, 'notes');
    assert.strictEqual(lastTable('get').access_group, 0);
});

await test('getRecords: the OBJECT form sends NO access_group', async () => {
    // `{name}` has always gone out with no access_group, which server side means
    // "every group I can read". Filling it with a 0 would silently narrow what
    // an existing app fetches.
    const s = await makeSkapi();
    await s.getRecords({ table: { name: 'notes' } });
    assertNoGroup(lastTable('get'), 'the object form must not gain a group');
});

/* ---- deleteRecords ------------------------------------------------------ */

await test('deleteRecords: a string table is expanded to group 0', async () => {
    const s = await makeSkapi();
    await s.deleteRecords({ table: 'notes' });
    assert.strictEqual(lastTable('del').name, 'notes');
    assert.strictEqual(lastTable('del').access_group, 0);
});

await test('deleteRecords: the OBJECT form sends NO access_group', async () => {
    const s = await makeSkapi();
    await s.deleteRecords({ table: { name: 'notes' } });
    assertNoGroup(lastTable('del'), 'the object form must not gain a group');
});

/* ---- postRecord CREATE -------------------------------------------------- */

await test('postRecord CREATE: a string table is expanded to group 0', async () => {
    const s = await makeSkapi();
    await s.postRecord({ a: 1 }, { table: 'notes' });
    assert.strictEqual(lastTable('post').name, 'notes');
    assert.strictEqual(lastTable('post').access_group, 0);
});

await test('postRecord CREATE: the OBJECT form sends NO access_group', async () => {
    const s = await makeSkapi();
    await s.postRecord({ a: 1 }, { table: { name: 'notes' } });
    assertNoGroup(lastTable('post'), 'a create with an object table must not gain a group');
    assert.strictEqual(lastTable('post').name, 'notes');
});

/* ---- postRecord UPDATE: neither form gains a group ---------------------- */

await test('postRecord UPDATE: a string table sends NO access_group', async () => {
    // The record's group is already decided. An absent group means "keep the
    // record where it is"; a 0 would MOVE it to public, and for a private
    // record that is a declassification nobody asked for.
    const s = await makeSkapi();
    await s.postRecord({ a: 2 }, { record_id: 'VQs5vPsSKrIUxckv', table: 'notes' });
    assert.strictEqual(lastTable('post').name, 'notes');
    assertNoGroup(lastTable('post'), 'an update must not restate the group');
});

await test('postRecord UPDATE: the OBJECT form sends NO access_group', async () => {
    const s = await makeSkapi();
    await s.postRecord({ a: 2 }, { record_id: 'VQs5vPsSKrIUxckv', table: { name: 'notes' } });
    assert.strictEqual(lastTable('post').name, 'notes');
    assertNoGroup(lastTable('post'), 'an update must not gain a group');
});

/* ---- an explicit group is never touched --------------------------------- */

await test('an EXPLICIT access group survives on getRecords', async () => {
    const s = await makeSkapi();
    await s.getRecords({ table: { name: 'notes', access_group: 'authorized' } });
    assert.strictEqual(lastTable('get').access_group, 1);
});

await test('an EXPLICIT 0 is honoured, not treated as absent', async () => {
    const s = await makeSkapi();
    await s.getRecords({ table: { name: 'notes', access_group: 0 } });
    assert.strictEqual(lastTable('get').access_group, 0);
    assert.ok(Object.prototype.hasOwnProperty.call(lastTable('get'), 'access_group'),
        'an explicitly stated 0 must reach the wire, not be dropped as a default');
});

await test('an EXPLICIT access group survives a CREATE', async () => {
    const s = await makeSkapi();
    await s.postRecord({ a: 1 }, { table: { name: 'notes', access_group: 'authorized' } });
    assert.strictEqual(lastTable('post').access_group, 1);
});

await test('an EXPLICIT access group survives an UPDATE', async () => {
    // Restating the group on an update is how a record is deliberately MOVED,
    // so the rule is "nothing is added", not "nothing is sent".
    const s = await makeSkapi();
    await s.postRecord({ a: 2 }, { record_id: 'VQs5vPsSKrIUxckv', table: { name: 'notes', access_group: 'public' } });
    assert.strictEqual(lastTable('post').access_group, 0);
});

await test('an EXPLICIT access group survives on deleteRecords', async () => {
    const s = await makeSkapi();
    await s.deleteRecords({ table: { name: 'notes', access_group: 'private' } });
    assert.strictEqual(lastTable('del').access_group, 'private');
});

/* ---- '*' is shorthand for 'private' ------------------------------------ */

await test("'*' goes out as 'private' on getRecords", async () => {
    const s = await makeSkapi();
    await s.getRecords({ table: { name: 'notes', access_group: '*' } });
    assert.strictEqual(lastTable('get').access_group, 'private');
});

await test("'*' goes out as 'private' on deleteRecords", async () => {
    const s = await makeSkapi();
    await s.deleteRecords({ table: { name: 'notes', access_group: '*' } });
    assert.strictEqual(lastTable('del').access_group, 'private');
});

await test("'*' goes out as 'private' on a CREATE, and the record is stored private", async () => {
    const s = await makeSkapi();
    const rec = await s.postRecord({ a: 1 }, { table: { name: 'notes', access_group: '*' } });
    assert.strictEqual(lastTable('post').access_group, 'private');
    assert.strictEqual(STORE.get(rec.record_id).group, 'private');
});

await test("'*' goes out as 'private' on an UPDATE that moves the record", async () => {
    const s = await makeSkapi();
    const rec = await s.postRecord({ a: 1 }, { table: { name: 'notes', access_group: 'public' } });
    await s.postRecord({ a: 2 }, { record_id: rec.record_id, table: { name: 'notes', access_group: '*' } });
    assert.strictEqual(lastTable('post').access_group, 'private');
    assert.strictEqual(STORE.get(rec.record_id).group, 'private');
});

/* ---- id-addressed calls carry no table at all --------------------------- */

await test('getRecords by record_id sends no table', async () => {
    const s = await makeSkapi();
    await s.getRecords({ record_id: 'VQs5vPsSKrIUxckv' });
    assert.strictEqual(lastTable('get'), undefined, 'an id lookup must not grow a table it never had');
});

await test('getRecords by unique_id sends no table', async () => {
    const s = await makeSkapi();
    await s.getRecords({ unique_id: 'src::a/b.xlsx' });
    assert.strictEqual(lastTable('get'), undefined);
});

await test('deleteRecords by record_id sends no table', async () => {
    const s = await makeSkapi();
    await s.deleteRecords({ record_id: 'VQs5vPsSKrIUxckv' });
    assert.strictEqual(lastTable('del'), undefined);
});

await test('postRecord UPDATE with no table at all stays tableless', async () => {
    const s = await makeSkapi();
    await s.postRecord({ a: 2 }, { record_id: 'VQs5vPsSKrIUxckv' });
    assert.strictEqual(lastTable('post'), undefined,
        'there is nowhere to put a group on this call, and nothing to decide');
});

/* ---- the removed init option is inert, not an error --------------------- */

await test('default_access_group at construction no longer throws', async () => {
    // The option is gone. An app that still passes it must keep working, so it
    // is ignored like any other unknown key rather than refused.
    assert.doesNotThrow(() => new Skapi(SERVICE, OWNER, { autoLogin: false, default_access_group: 'authorized' }));
    assert.doesNotThrow(() => new Skapi(SERVICE, OWNER, { autoLogin: false, default_access_group: 'nonsense' }));
    assert.doesNotThrow(() => new Skapi(SERVICE, OWNER, { autoLogin: false, default_access_group: 999 }));
});

await test('default_access_group changes not one byte on the wire', async () => {
    const s = await makeSkapi({ default_access_group: 'authorized' });
    await s.getRecords({ table: { name: 'notes' } });
    assertNoGroup(lastTable('get'), 'a dead option must not fill anything in');

    await s.getRecords({ table: 'notes' });
    assert.strictEqual(lastTable('get').access_group, 0, 'the shorthand still means 0, not the dead option');

    await s.postRecord({ a: 1 }, { table: { name: 'notes' } });
    assertNoGroup(lastTable('post'), 'a dead option must not fill anything in');
});

await test("the removed 'ask' value is inert too, and refuses nothing", async () => {
    // It used to turn an omitted group into an error. Nothing may fail now.
    const s = await makeSkapi({ default_access_group: 'ask' });
    await s.getRecords({ table: { name: 'notes' } });
    assertNoGroup(lastTable('get'), 'nothing to ask for any more');
    await s.postRecord({ a: 1 }, { table: 'notes' });
    assert.strictEqual(lastTable('post').access_group, 0);
});

await test('the project setting of the same name is ignored as well', async () => {
    // It is abandoned server side, but an old service record still carries the
    // value, and it arrives on the connection response of every existing
    // project that ever set it.
    const s = await makeSkapi();
    s.connection = Object.assign({}, s.connection, { opt: { default_access_group: 'authorized' } });
    await s.getRecords({ table: { name: 'notes' } });
    assertNoGroup(lastTable('get'), 'a stale project setting must not reach the wire');
    await s.getRecords({ table: 'notes' });
    assert.strictEqual(lastTable('get').access_group, 0);
});

/* ================================================================== *
 * ENCRYPTION: the UPDATE with a string table
 *
 * From here on the record store is SHARED and must not be reset: alice's
 * keyring lives in it. Every wire test above runs first for that reason.
 * ================================================================== */

const alice = await makeClient(ALICE);
await alice.unlockEncryption({ password: 'correct horse battery staple' });

await test('encryption unlocked, with a keyring in the store', async () => {
    const st = alice.getEncryptionStatus();
    assert.strictEqual(st.status, 'unlocked');
    assert.ok([...STORE.values()].some(r => r.table === '__skapi__keyring'), 'no keyring was provisioned');
});

await test('THE HAZARD: an UPDATE with a STRING table must not write PLAINTEXT into a private record', async () => {
    // This is the shape, and the only shape, where the caller's raw config and
    // the wire disagree. resolveWriteGroup reads a RAW string table as group 0
    // and takes the declassification branch: plaintext out, DEK zeroized. The
    // wire meanwhile carries no group, so the server leaves the record private.
    // The result is cleartext in a record the caller believes is sealed, with no
    // error raised. encryptionView() is what prevents it.
    const rec = await alice.postRecord({ secret: 'one' }, { table: { name: 't', access_group: 'private' } });
    assert.ok(stored(rec.record_id).__skapi_enc__, 'the seed record must start sealed');

    captured = [];
    await alice.postRecord({ secret: 'two' }, { record_id: rec.record_id, table: 't' });

    const sent = lastBody('post');
    assertNoGroup(sent.table, 'the update must not restate the group');
    assert.strictEqual(sent.table.name, 't');
    assert.notStrictEqual(sent.data && sent.data.secret, 'two',
        'PLAINTEXT went on the wire for a record the server keeps private: ' + JSON.stringify(sent.data));
    assert.ok(sent.data && sent.data.__skapi_enc__, 'the update must go out as an envelope');
    assert.ok(stored(rec.record_id).__skapi_enc__, 'the stored record must still be sealed');
    assert.strictEqual(STORE.get(rec.record_id).group, 'private', 'and must still be private');

    const back = await alice.getRecords({ record_id: rec.record_id });
    assert.deepStrictEqual(back.list[0].data, { secret: 'two' }, 'and must still read back');
});

await test('the hazard is closed even when the DEK cache is cold', async () => {
    // The test above can be satisfied from the in-memory DEK cache, which this
    // instance filled when it created the record. A fresh instance has no cache
    // and has to resolve the group by READING the record, which is the path a
    // second tab or a reload actually takes.
    const rec = await alice.postRecord({ secret: 'cold' }, { table: { name: 't', access_group: 'private' } });

    const fresh = await makeClient(ALICE);
    await fresh.unlockEncryption({ password: 'correct horse battery staple' });

    captured = [];
    await fresh.postRecord({ secret: 'colder' }, { record_id: rec.record_id, table: 't' });

    const sent = lastBody('post');
    assertNoGroup(sent.table, 'the update must not restate the group');
    assert.notStrictEqual(sent.data && sent.data.secret, 'colder',
        'PLAINTEXT went out from a cold instance: ' + JSON.stringify(sent.data));
    assert.ok(sent.data && sent.data.__skapi_enc__, 'the update must go out as an envelope');
    assert.strictEqual(STORE.get(rec.record_id).group, 'private');
});

await test('an UPDATE with an OBJECT table keeps the record sealed too', async () => {
    const rec = await alice.postRecord({ secret: 'obj' }, { table: { name: 't', access_group: 'private' } });

    captured = [];
    await alice.postRecord({ secret: 'obj2' }, { record_id: rec.record_id, table: { name: 't' } });

    const sent = lastBody('post');
    assertNoGroup(sent.table, 'an update must not gain a group');
    assert.ok(sent.data && sent.data.__skapi_enc__, 'the update must go out as an envelope');
    assert.ok(stored(rec.record_id).__skapi_enc__);
});

await test('a CREATE with a string table cannot expose the hazard: both views say 0', async () => {
    // Documented, not incidental. On a create the raw string table and the
    // validated { name, access_group: 0 } resolve to the SAME group, so the two
    // views agree and plaintext is the correct outcome. That is exactly why the
    // old create-only encryption tests could never have caught this.
    captured = [];
    const rec = await alice.postRecord({ open: 'value' }, { table: 't2' });

    const sent = lastBody('post');
    assert.strictEqual(sent.table.access_group, 0);
    assert.deepStrictEqual(sent.data, { open: 'value' }, 'a group 0 write is stored as given');
    assert.deepStrictEqual(stored(rec.record_id), { open: 'value' });
});

await test('declassifying still works when the caller STATES group 0', async () => {
    // The contrast that makes the rule readable: a stated 0 on an update is a
    // deliberate move to public and writes plaintext; the shorthand is not a
    // stated 0 and must never be read as one.
    const rec = await alice.postRecord({ was: 'secret' }, { table: { name: 't', access_group: 'private' } });
    assert.ok(stored(rec.record_id).__skapi_enc__, 'starts sealed');

    await alice.postRecord({ was: 'secret' }, { record_id: rec.record_id, table: { name: 't', access_group: 0 } });
    assert.deepStrictEqual(stored(rec.record_id), { was: 'secret' }, 'a declassified record is stored in the clear');
    assert.strictEqual(STORE.get(rec.record_id).group, 0);
});

await test("'*' on a CREATE seals the record exactly like 'private'", async () => {
    const rec = await alice.postRecord({ secret: 'star' }, { table: { name: 't', access_group: '*' } });
    assert.strictEqual(lastTable('post').access_group, 'private');
    assert.ok(stored(rec.record_id).__skapi_enc__, 'must be sealed on the way in');
    assert.strictEqual(STORE.get(rec.record_id).group, 'private');
    const back = await alice.getRecords({ record_id: rec.record_id });
    assert.deepStrictEqual(back.list[0].data, { secret: 'star' }, 'and must read back');
});

await test("'*' on an UPDATE moves a public record into private and seals it", async () => {
    const rec = await alice.postRecord({ was: 'open' }, { table: { name: 't', access_group: 0 } });
    assert.ok(!stored(rec.record_id).__skapi_enc__, 'starts in the clear');
    await alice.postRecord({ was: 'open' }, { record_id: rec.record_id, table: { name: 't', access_group: '*' } });
    assert.ok(stored(rec.record_id).__skapi_enc__, 'must be sealed on the way into private');
    assert.strictEqual(STORE.get(rec.record_id).group, 'private');
});

/* ---- report ------------------------------------------------------------- */

let failed = 0;
for (const [ok, name, detail] of results) {
    console.log((ok ? 'ok   ' : 'FAIL ') + ' ' + name + (detail ? '  -> ' + detail : ''));
    if (!ok) failed++;
}
console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);

})();

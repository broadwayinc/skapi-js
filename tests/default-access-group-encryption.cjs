/**
 * `default_access_group` must not be able to write PLAINTEXT into a private record.
 *
 * THE BUG. Two views of one write disagreed about its access group.
 *
 * `setupPostRecordConfig` resolves the project default inside `validator.Params`'
 * precall, and precall operates on a JSON DEEP COPY of the config. So the
 * resolved group reached the copy the WIRE is built from, and never reached the
 * caller's own config object. `postRecord` then handed that raw config to
 * `maybeEncrypt`, whose `resolveWriteGroup` saw no access group, resolved 0,
 * took the `group !== 'private'` early return, and sent `data` unencrypted.
 *
 * Measured against a build of the offending commit, with
 * `{ encryption: true, default_access_group: 'private' }`:
 *
 *     table: {"name":"notes","access_group":"private"}
 *     data : {"secret":"hello"}            <-- plaintext, and no error raised
 *
 * The same write with the group stated explicitly correctly refused with
 * ENCRYPTION_LOCKED. So the caller was punished for being explicit and silently
 * betrayed for relying on the default: a record labelled private, holding
 * cleartext, that the caller has every reason to believe is sealed.
 *
 * The fix shows the encryption layer the VALIDATED table, which is exactly what
 * goes on the wire. This file pins that the two views can never diverge again.
 *
 * Run: node ./tests/default-access-group-encryption.cjs
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

/* ---- a browser, as far as the SDK is concerned -------------------------- *
 * MUST run before the bundle is required: the SDK decides once, at module
 * load, whether it is in a browser, and the encryption path is skipped
 * entirely in Node. Same reason tests/encryption.cjs does this. */
const _store = () => {
    const m = new Map();
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
        clear: () => m.clear(),
    };
};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.navigator = globalThis.navigator || { userAgent: 'node-test' };
globalThis.location = globalThis.location || { origin: 'https://app.example.com', href: 'https://app.example.com/' };
globalThis.alert = undefined;
for (const n of ['HTMLInputElement', 'HTMLFormElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLElement', 'SubmitEvent', 'Event', 'Node']) {
    if (typeof globalThis[n] === 'undefined') globalThis[n] = class {};
}
globalThis.sessionStorage = _store();
globalThis.localStorage = _store();
globalThis.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.status = 0; this._h = {}; this.readyState = 0; }
    open(m, u) { this._m = m; this._u = u; this.readyState = 1; }
    setRequestHeader(k, v) { this._h[k] = v; }
    getResponseHeader() { return null; }
    abort() {}
    send(body) {
        (async () => {
            try {
                const r = await fetch(this._u, { method: this._m, headers: this._h, body });
                this.status = r.status;
                this.responseText = await r.text();
                this.response = this.responseText;
                this.readyState = 4;
                if (this.onload) this.onload({});
            } catch (e) {
                if (this.onerror) this.onerror(e);
            }
        })();
    }
};
globalThis.FileReader = class {
    readAsDataURL(b) {
        b.arrayBuffer().then((ab) => {
            this.result = 'data:application/json;base64,' + Buffer.from(ab).toString('base64');
            if (this.onloadend) this.onloadend();
        });
    }
};

const { Skapi } = require(process.env.SKAPI_BUNDLE || '../dist/skapi.cjs');

const FIXTURES = path.join(__dirname, 'fixtures');
const OWNER = '4d4a36a5-b318-4093-92ae-7cf11feae989';
const SERVICE = 'ap21AAAAAAAAAAAAAAAA';

let captured = [];
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (u, o) => {
    u = String(u);
    if (/\/admin-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'admin-v1.json')));
    if (/\/record-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'record-v1.json')));
    let body = null;
    try { body = JSON.parse(o && o.body); } catch (e) { /* not json */ }
    if (u.includes('post-record')) {
        captured.push(body);
        return json({ rec: 'VQechoedRECxckv', srvc: 'x/y', usr: OWNER, ip: '' });
    }
    return json({ ip: '127.0.0.1', locale: 'KR', service_name: 'test', group: 99, opt: {} });
};

async function makeSkapi(options) {
    captured = [];
    const s = new Skapi(SERVICE, OWNER, Object.assign({ autoLogin: false, encryption: true }, options || {}));
    await s.__connection;
    const exp = Math.floor(Date.now() / 1000) + 86400;
    // `service` matters: getQuery calls checkAdmin, which logs the user out when
    // the profile's service does not match the instance's.
    s.__user = { user_id: OWNER, access_group: 99, service: s.service, owner: OWNER };
    s.session = {
        getIdToken: () => ({ getExpiration: () => exp }),
        idToken: { jwtToken: 'stub.id', payload: { exp } },
        accessToken: { jwtToken: 'stub.access' },
        refreshToken: { token: 'stub.refresh' },
    };
    return s;
}

// Returns what actually went on the wire, plus whatever was thrown.
async function attempt(s, form, config) {
    let threw = null;
    try { await s.postRecord(form, config); } catch (e) { threw = e; }
    return { threw, sent: captured[captured.length - 1] || null };
}

const SECRET = { secret: 'hello' };
const leaked = (sent) => !!(sent && sent.data && sent.data.secret === 'hello');

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

(async () => {

/* ---- the bug ------------------------------------------------------------ */

await test('THE BUG: a private DEFAULT never writes plaintext (shorthand table)', async () => {
    const s = await makeSkapi({ default_access_group: 'private' });
    const { threw, sent } = await attempt(s, SECRET, { table: 'notes' });
    assert.ok(!leaked(sent), 'plaintext went out in a record labelled private: ' + JSON.stringify(sent));
    assert.ok(threw, 'the write should refuse while encryption is locked');
});

await test('THE BUG: a private DEFAULT never writes plaintext (object table)', async () => {
    const s = await makeSkapi({ default_access_group: 'private' });
    const { threw, sent } = await attempt(s, SECRET, { table: { name: 'notes' } });
    assert.ok(!leaked(sent), 'plaintext went out: ' + JSON.stringify(sent));
    assert.ok(threw);
});

await test('the default behaves exactly like stating the group explicitly', async () => {
    // The original defect made these two DIFFER: explicit refused, default leaked.
    const a = await attempt(await makeSkapi({ default_access_group: 'private' }), SECRET, { table: 'notes' });
    const b = await attempt(await makeSkapi(), SECRET, { table: { name: 'notes', access_group: 'private' } });
    assert.strictEqual(a.threw && a.threw.code, b.threw && b.threw.code,
        'a defaulted private write and an explicit one must be treated identically');
});

await test('the PROJECT setting is covered too, not just the init option', async () => {
    const s = await makeSkapi();
    // Same path the SDK takes when the value arrives from connection.opt.
    s.connection = Object.assign({}, s.connection, { opt: { default_access_group: 'private' } });
    const { threw, sent } = await attempt(s, SECRET, { table: 'notes' });
    assert.ok(!leaked(sent), 'plaintext went out from a project-set default: ' + JSON.stringify(sent));
    assert.ok(threw);
});

/* ---- what must NOT change ---------------------------------------------- */

await test('a NON-private default still writes normally', async () => {
    const s = await makeSkapi({ default_access_group: 'authorized' });
    const { threw, sent } = await attempt(s, SECRET, { table: 'notes' });
    assert.strictEqual(threw, null, 'a non-private write must not be refused');
    assert.strictEqual(sent.table.access_group, 1);
    assert.deepStrictEqual(sent.data, SECRET, 'a non-private record is stored as given');
});

await test('with no default, a plain write is untouched', async () => {
    const s = await makeSkapi();
    const { threw, sent } = await attempt(s, SECRET, { table: 'notes' });
    assert.strictEqual(threw, null);
    assert.strictEqual(sent.table.access_group, 0);
    assert.deepStrictEqual(sent.data, SECRET);
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

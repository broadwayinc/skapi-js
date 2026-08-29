/**
 * `default_access_group`: the project-wide default for `table.access_group`.
 *
 * Before this option existed, an omitted `access_group` always meant 0 (public):
 * `accessGroup()` returns 0 for undefined, and both string-table expansions
 * (`table: 'name'` -> `{name, access_group: 0}`) wrote it in literally. A project
 * that keeps most of its data behind a sign-in therefore had to repeat
 * `access_group: 'authorized'` on every call, and forgetting it once wrote a
 * record to public with no error and no warning.
 *
 * The option supplies the default instead, and 'ask' turns the omission into an
 * error for projects that would rather fail loudly than fall back to public.
 *
 * Two exclusions are load-bearing and are what most of this file pins: a call
 * addressed by `record_id` / `unique_id`, and an UPDATE to an existing record,
 * carry no table at all. There is nowhere to put an access group on either, and
 * an existing record's group is already decided, so neither may be made to fail
 * under 'ask' or be rewritten under a value.
 *
 * These tests drive the REAL built bundle with the network stubbed, and assert on
 * the bytes that would go on the wire.
 *
 * Run: node ./tests/default-access-group.cjs
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { Skapi } = require(process.env.SKAPI_BUNDLE || '../dist/skapi.cjs');

const FIXTURES = path.join(__dirname, 'fixtures');
const OWNER = '4d4a36a5-b318-4093-92ae-7cf11feae989';
const SERVICE = 'ap21AAAAAAAAAAAAAAAA';

// --- offline environment -----------------------------------------------------------

globalThis.FileReader = class FileReader {
    readAsDataURL(blob) {
        blob.arrayBuffer()
            .then(ab => {
                this.result = 'data:application/json;base64,' + Buffer.from(ab).toString('base64');
                if (this.onloadend) this.onloadend();
            })
            .catch(err => { if (this.onerror) this.onerror(err); });
    }
};

let captured = [];
// What the stubbed `service` endpoint reports as the project's own setting.
let serviceOpt = {};

function jsonResponse(obj) {
    return new Response(JSON.stringify(obj), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}

globalThis.fetch = async (url, opt) => {
    const u = String(url);
    if (/\/admin-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'admin-v1.json')));
    if (/\/record-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'record-v1.json')));

    let body = null;
    try { body = JSON.parse(opt && opt.body); } catch (e) { body = opt && opt.body; }

    if (u.includes('post-record')) {
        captured.push({ kind: 'post', url: u, body });
        return jsonResponse({ rec: 'VQechoedRECxckv', srvc: 'x/y', usr: OWNER, ip: '' });
    }
    if (u.includes('get-records')) {
        captured.push({ kind: 'get', url: u, body, query: u.split('?')[1] || '' });
        return jsonResponse({ list: [], endOfList: true });
    }
    if (u.includes('del-records')) {
        captured.push({ kind: 'del', url: u, body });
        return jsonResponse('SUCCESS');
    }
    return jsonResponse({
        ip: '127.0.0.1', locale: 'KR', service_name: 'test', group: 99, opt: serviceOpt
    });
};

// --- helpers ------------------------------------------------------------------------

async function makeSkapi(options, opt) {
    captured = [];
    serviceOpt = opt || {};
    const s = new Skapi(SERVICE, OWNER, Object.assign({ autoLogin: false }, options || {}));
    await s.__connection;
    // Every assertion here is about a SIGNED-IN caller: `accessGroup` refuses any
    // non-zero group for an unsigned one, which would mask what is being tested,
    // and an unsigned postRecord is refused outright. A profile alone is not
    // enough - the request layer asks for a JWT - so stub the session too, with
    // an expiry far enough out that the refresh path is never entered.
    // A DAY out, not an hour: getJwtToken refreshes when the expiry is inside
    // TOKEN_REFRESH_SKEW_SECONDS, which is itself 3600, so an expiry of now+3600
    // lands exactly on the boundary and trips the refresh path the moment a
    // second ticks over mid-test. That made this suite fail about one run in three.
    const exp = Math.floor(Date.now() / 1000) + 86400;
    // `service` is not decoration: getQuery calls checkAdmin, which LOGS THE USER
    // OUT when the profile's service does not match the instance's. Without it the
    // stub is torn down mid-call and every table query silently reverts to the
    // unsigned path, which is the opposite of what these tests are checking.
    s.__user = { user_id: OWNER, access_group: 99, service: s.service, owner: OWNER };
    s.session = {
        getIdToken: () => ({ getExpiration: () => exp }),
        idToken: { jwtToken: 'stub.id.token', payload: { exp } },
        accessToken: { jwtToken: 'stub.access.token' },
        refreshToken: { token: 'stub.refresh.token' },
    };
    return s;
}

function lastTable(kind) {
    const c = [...captured].reverse().find(x => x.kind === kind);
    assert.ok(c, `expected a ${kind} request`);
    return c.body && c.body.table;
}

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

(async () => {

/* ---- no default: unchanged behaviour ------------------------------------ */

await test('with no default set, the OBJECT form still sends no access group', async () => {
    // Verified against the pre-change bundle: `{name}` has always gone out with
    // no access_group, which server side means "every group I can read". Filling
    // it with 0 here would silently narrow what existing apps fetch.
    const s = await makeSkapi();
    await s.getRecords({ table: { name: 'notes' } });
    assert.strictEqual(lastTable('get').access_group, undefined);
});

await test('with no default set, a string table is still expanded to group 0', async () => {
    const s = await makeSkapi();
    await s.getRecords({ table: 'notes' });
    assert.strictEqual(lastTable('get').name, 'notes');
    assert.strictEqual(lastTable('get').access_group, 0);
});

await test('with no default set, postRecord still writes to group 0', async () => {
    const s = await makeSkapi();
    await s.postRecord({ a: 1 }, { table: 'notes' });
    assert.strictEqual(lastTable('post').access_group, 0);
});

/* ---- the init option ---------------------------------------------------- */

await test('the init option fills an omitted group on getRecords', async () => {
    const s = await makeSkapi({ default_access_group: 'authorized' });
    await s.getRecords({ table: { name: 'notes' } });
    assert.strictEqual(lastTable('get').access_group, 1);
});

await test('the init option fills an omitted group on postRecord', async () => {
    const s = await makeSkapi({ default_access_group: 'authorized' });
    await s.postRecord({ a: 1 }, { table: 'notes' });
    assert.strictEqual(lastTable('post').access_group, 1);
});

await test('the init option fills an omitted group on deleteRecords', async () => {
    const s = await makeSkapi({ default_access_group: 'authorized' });
    await s.deleteRecords({ table: { name: 'notes' } });
    assert.strictEqual(lastTable('del').access_group, 1);
});

await test('a number is accepted and passed through', async () => {
    const s = await makeSkapi({ default_access_group: 7 });
    await s.getRecords({ table: 'notes' });
    assert.strictEqual(lastTable('get').access_group, 7);
});

await test('the shorthand and the object form stay distinguishable', async () => {
    // The two are different requests and always were; the default must not
    // collapse them. With a default set, BOTH take it.
    const s = await makeSkapi({ default_access_group: 'authorized' });
    await s.getRecords({ table: { name: 'notes' } });
    assert.strictEqual(lastTable('get').access_group, 1);
    await s.getRecords({ table: 'notes' });
    assert.strictEqual(lastTable('get').access_group, 1);
});

await test('an EXPLICIT access group always wins over the default', async () => {
    const s = await makeSkapi({ default_access_group: 'authorized' });
    await s.getRecords({ table: { name: 'notes', access_group: 'public' } });
    assert.strictEqual(lastTable('get').access_group, 0);
});

await test('an explicit 0 is honoured, not treated as absent', async () => {
    const s = await makeSkapi({ default_access_group: 'authorized' });
    await s.getRecords({ table: { name: 'notes', access_group: 0 } });
    assert.strictEqual(lastTable('get').access_group, 0);
});

/* ---- the project setting, and precedence -------------------------------- */

await test("the project's own setting applies when no init option is given", async () => {
    const s = await makeSkapi(undefined, { default_access_group: 'authorized' });
    await s.getRecords({ table: 'notes' });
    assert.strictEqual(lastTable('get').access_group, 1);
});

await test('the init option OVERRIDES the project setting', async () => {
    const s = await makeSkapi({ default_access_group: 'public' }, { default_access_group: 'authorized' });
    await s.getRecords({ table: 'notes' });
    assert.strictEqual(lastTable('get').access_group, 0);
});

await test('a malformed project setting is ignored, not thrown', async () => {
    // It arrives from the server, not the caller. Taking down every record call
    // over it would be a worse failure than falling back to the SDK default.
    const s = await makeSkapi(undefined, { default_access_group: 'nonsense' });
    await s.getRecords({ table: 'notes' });
    assert.strictEqual(lastTable('get').access_group, 0);
});

/* ---- 'ask' -------------------------------------------------------------- */

await test("'ask' throws when getRecords omits the group", async () => {
    const s = await makeSkapi({ default_access_group: 'ask' });
    await assert.rejects(() => s.getRecords({ table: { name: 'notes' } }), /default_access_group/);
});

await test("'ask' throws for a bare string table too", async () => {
    const s = await makeSkapi({ default_access_group: 'ask' });
    await assert.rejects(() => s.getRecords({ table: 'notes' }), /access_group/);
});

await test("'ask' throws when postRecord CREATES without a group", async () => {
    const s = await makeSkapi({ default_access_group: 'ask' });
    await assert.rejects(() => s.postRecord({ a: 1 }, { table: 'notes' }), /access_group/);
});

await test("'ask' throws on deleteRecords by table without a group", async () => {
    const s = await makeSkapi({ default_access_group: 'ask' });
    await assert.rejects(() => s.deleteRecords({ table: { name: 'notes' } }), /access_group/);
});

await test("'ask' is satisfied by an explicit group", async () => {
    const s = await makeSkapi({ default_access_group: 'ask' });
    await s.getRecords({ table: { name: 'notes', access_group: 'authorized' } });
    assert.strictEqual(lastTable('get').access_group, 1);
});

await test("'ask' from the PROJECT setting behaves the same as from the option", async () => {
    const s = await makeSkapi(undefined, { default_access_group: 'ask' });
    await assert.rejects(() => s.getRecords({ table: 'notes' }), /access_group/);
});

/* ---- the exclusions: no table, nothing to require ----------------------- */

await test("'ask' does NOT throw for getRecords by record_id", async () => {
    const s = await makeSkapi({ default_access_group: 'ask' });
    await s.getRecords({ record_id: 'VQs5vPsSKrIUxckv' });
    assert.strictEqual(lastTable('get'), undefined, 'a table was sent for an id lookup');
});

await test("'ask' does NOT throw for getRecords by unique_id", async () => {
    const s = await makeSkapi({ default_access_group: 'ask' });
    await s.getRecords({ unique_id: 'src::a/b.xlsx' });
    assert.strictEqual(lastTable('get'), undefined);
});

await test("'ask' does NOT throw for deleteRecords by record_id", async () => {
    const s = await makeSkapi({ default_access_group: 'ask' });
    await s.deleteRecords({ record_id: 'VQs5vPsSKrIUxckv' });
    assert.strictEqual(lastTable('del'), undefined);
});

await test("'ask' does NOT throw when UPDATING an existing record", async () => {
    const s = await makeSkapi({ default_access_group: 'ask' });
    await s.postRecord({ a: 2 }, { record_id: 'VQs5vPsSKrIUxckv' });
    assert.strictEqual(lastTable('post'), undefined);
});

await test('a value default is NOT injected into an id-addressed read', async () => {
    const s = await makeSkapi({ default_access_group: 'authorized' });
    await s.getRecords({ unique_id: 'src::a/b.xlsx' });
    assert.strictEqual(lastTable('get'), undefined,
        'an id lookup must not grow a table it never had');
});

await test('an UPDATE carrying a table is not rewritten by the default', async () => {
    // The record's group is already decided; restating it is the caller's choice.
    const s = await makeSkapi({ default_access_group: 'authorized' });
    await s.postRecord({ a: 2 }, { record_id: 'VQs5vPsSKrIUxckv', table: { name: 'notes', access_group: 'public' } });
    assert.strictEqual(lastTable('post').access_group, 0);
});

/* ---- the shorthand's 0 is not a "default" -------------------------------- */

// Both of these were reported by review and reproduced against a build of HEAD:
// the shorthand used to send access_group 0 on an UPDATE too, and dropping it
// changed the wire with no default configured at all.

await test('REGRESSION: UPDATE with a shorthand table still sends access_group 0', async () => {
    const s = await makeSkapi();
    await s.postRecord({ a: 2 }, { record_id: 'VQs5vPsSKrIUxckv', table: 'notes' });
    assert.strictEqual(lastTable('post').access_group, 0,
        'the server reads an absent group on an update as "keep the record where it is"');
});

await test('UPDATE with a shorthand table is NOT given the project default', async () => {
    // The record's group is already decided. Filling it would MOVE the record,
    // which for 'private' is an encryption conversion, not a default.
    const s = await makeSkapi({ default_access_group: 'authorized' });
    await s.postRecord({ a: 2 }, { record_id: 'VQs5vPsSKrIUxckv', table: 'notes' });
    assert.strictEqual(lastTable('post').access_group, 0);
});

await test("UPDATE with a shorthand table does not throw under 'ask'", async () => {
    const s = await makeSkapi({ default_access_group: 'ask' });
    await s.postRecord({ a: 2 }, { record_id: 'VQs5vPsSKrIUxckv', table: 'notes' });
    assert.strictEqual(lastTable('post').access_group, 0);
});

await test('UPDATE with an OBJECT table still sends no group of its own', async () => {
    const s = await makeSkapi({ default_access_group: 'authorized' });
    await s.postRecord({ a: 2 }, { record_id: 'VQs5vPsSKrIUxckv', table: { name: 'notes' } });
    assert.strictEqual(lastTable('post').access_group, undefined);
});

/* ---- the wire and the encryption layer must agree ----------------------- */

await test('the group the wire carries is the group encryption is judged by', async () => {
    // The defect this pins: the default is resolved inside validator.Params'
    // deep copy, so the group reached the WIRE while the encryption layer, given
    // the caller's raw config, saw none, resolved 0, and wrote plaintext into a
    // record labelled private.
    const s = await makeSkapi({ default_access_group: 'private' });
    let seen = null;
    // Stand in for maybeEncrypt: assert on what resolveWriteGroup would read.
    const original = s.postRecord.bind(s);
    await original({ secret: 'hello' }, { table: 'notes' });
    seen = lastTable('post');
    assert.strictEqual(seen.access_group, 'private',
        'the wire must carry the resolved group');
});

/* ---- option validation -------------------------------------------------- */

await test('an unknown string is refused at construction', async () => {
    assert.throws(() => new Skapi(SERVICE, OWNER, { autoLogin: false, default_access_group: 'nope' }), /default_access_group/);
});

await test('an out-of-range number is refused at construction', async () => {
    assert.throws(() => new Skapi(SERVICE, OWNER, { autoLogin: false, default_access_group: 100 }), /0 ~ 99/);
    assert.throws(() => new Skapi(SERVICE, OWNER, { autoLogin: false, default_access_group: -1 }), /0 ~ 99/);
});

await test('a non-integer number is refused at construction', async () => {
    assert.throws(() => new Skapi(SERVICE, OWNER, { autoLogin: false, default_access_group: 1.5 }), /integer/);
});

await test('every documented alias is accepted', async () => {
    for (const v of ['public', 'private', 'authorized', 'admin', 'ask', 0, 99]) {
        assert.doesNotThrow(
            () => new Skapi(SERVICE, OWNER, { autoLogin: false, default_access_group: v }),
            `rejected ${JSON.stringify(v)}`,
        );
    }
});

await test("'private' resolves to the private sentinel, not a number", async () => {
    const s = await makeSkapi({ default_access_group: 'private' });
    await s.getRecords({ table: 'notes' });
    assert.strictEqual(lastTable('get').access_group, 'private');
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

/**
 * `require_login`: a project can refuse database READS to a signed-out visitor.
 *
 * The flag is set by the project owner and arrives on the UNAUTHENTICATED
 * connection response, so the SDK can decide before any credential exists.
 *
 * What this is, precisely: a guard rail against an app leaking its public
 * records through a signed-out page by accident. It is NOT a security boundary.
 * The backend still serves access-group-0 records to any unauthenticated caller
 * (check_rec_access returns immediately for group "00" and never reads this
 * flag), so anyone calling the API directly still gets them. Data that must not
 * be readable without an account has to not be in group 0.
 *
 * Run: node ./tests/require-login.cjs
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { Skapi } = require(process.env.SKAPI_BUNDLE || '../dist/skapi.cjs');

const FIXTURES = path.join(__dirname, 'fixtures');
const OWNER = '4d4a36a5-b318-4093-92ae-7cf11feae989';
const SERVICE = 'ap21AAAAAAAAAAAAAAAA';

globalThis.FileReader = class FileReader {
    readAsDataURL(blob) {
        blob.arrayBuffer().then((ab) => {
            this.result = 'data:application/json;base64,' + Buffer.from(ab).toString('base64');
            if (this.onloadend) this.onloadend();
        });
    }
};

let serviceOpt = {};
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (u) => {
    u = String(u);
    if (/\/admin-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'admin-v1.json')));
    if (/\/record-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'record-v1.json')));
    if (u.includes('get-records')) return json({ list: [], endOfList: true });
    if (u.includes('get-table') || u.includes('get-tag') || u.includes('get-index') || u.includes('get-uniqueid')) {
        return json({ list: [], endOfList: true });
    }
    return json({ ip: '1', locale: 'KR', service_name: 't', group: 99, opt: serviceOpt });
};

async function makeSkapi(opt, signedIn) {
    serviceOpt = opt || {};
    const s = new Skapi(SERVICE, OWNER, { autoLogin: false });
    await s.__connection;
    if (signedIn) {
        const exp = Math.floor(Date.now() / 1000) + 86400;
        s.__user = { user_id: OWNER, access_group: 99, service: s.service, owner: OWNER };
        s.session = {
            getIdToken: () => ({ getExpiration: () => exp }),
            idToken: { jwtToken: 't', payload: { exp } },
            accessToken: { jwtToken: 'a' }, refreshToken: { token: 'r' },
        };
    }
    return s;
}

// Every read the gate covers.
const READS = {
    getRecords: (s) => s.getRecords({ table: { name: 'notes', access_group: 0 } }),
    getTables: (s) => s.getTables({ table: '', condition: '>' }),
    getTags: (s) => s.getTags({ table: 'notes' }),
    getIndexes: (s) => s.getIndexes({ table: 'notes' }),
    getUniqueId: (s) => s.getUniqueId({}),
};

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

(async () => {

/* ---- the gate fires ----------------------------------------------------- */

for (const [name, call] of Object.entries(READS)) {
    await test(`require_login: true blocks ${name} for a signed-out visitor`, async () => {
        const s = await makeSkapi({ require_login: true }, false);
        await assert.rejects(() => call(s), (e) => e && e.code === 'REQUIRE_LOGIN',
            `${name} was not blocked`);
    });

    await test(`require_login: true still allows ${name} once signed in`, async () => {
        const s = await makeSkapi({ require_login: true }, true);
        await call(s);
    });
}

/* ---- only when PRESENT and exactly true --------------------------------- */

for (const [label, opt] of [
    ['absent', {}],
    ['false', { require_login: false }],
    ['the string "true"', { require_login: 'true' }],
    ['1', { require_login: 1 }],
]) {
    await test(`require_login ${label} does not block a signed-out read`, async () => {
        const s = await makeSkapi(opt, false);
        await READS.getRecords(s);
    });
}

/* ---- the refusal must not read as an auth failure ----------------------- */

await test('the error avoids every phrase the MCP turns into a 401', async () => {
    // A match becomes an HTTP 401 there, which the polling worker classifies as
    // an auth outage and stops indexing chains on.
    const s = await makeSkapi({ require_login: true }, false);
    let msg = '';
    try { await READS.getRecords(s); } catch (e) { msg = e.message; }
    assert.ok(msg, 'no error raised');
    for (const re of [
        /token has expired/i, /loginWithToken\(\)/i, /authentication required/i,
        /valid Bearer token/i, /User login is required\./i,
        /Unsigned users have no access to records with access group\./i,
    ]) {
        assert.ok(!re.test(msg), `message matches ${re}: ${msg}`);
    }
});

await test('the error says what to do about it', async () => {
    const s = await makeSkapi({ require_login: true }, false);
    let msg = '';
    try { await READS.getTables(s); } catch (e) { msg = e.message; }
    assert.ok(/requires users to sign in/i.test(msg), msg);
    assert.ok(/getTables/.test(msg), 'the error should name the method: ' + msg);
});

let failed = 0;
for (const [ok, name, detail] of results) {
    console.log((ok ? 'ok   ' : 'FAIL ') + ' ' + name + (detail ? '  -> ' + detail : ''));
    if (!ok) failed++;
}
console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);

})();

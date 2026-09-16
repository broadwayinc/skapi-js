/**
 * Login aliases and self-edits through the admin route.
 *
 * THE BUG. updateProfile() and updateUserAttributes() computed preferred_username, the
 * pool's e-mail login alias ({service}-md5(e-mail)), and sent it in the same write as a new
 * e-mail, before that e-mail was verified. The alias logs in at once, so any signed-in user
 * could point it at an address they did not own. An e-mail logs in only once it is verified
 * now, and only the backend writes the alias, so the SDK must never send it.
 *
 * updateUserAttributes() also reached admin-edit-profile with the caller's own user_id,
 * where the rank rule never limits a master. Nobody edits their own account through that
 * route: the SDK refuses before any request, with the text the backend uses.
 *
 * These tests drive the REAL built bundle (dist/skapi.cjs) with the network stubbed, and
 * assert on the bytes that would go on the wire. updateProfile() on one's own account goes
 * through the Cognito client, which cannot be stubbed from outside the bundle, so that path
 * is pinned by the bundle itself carrying no preferred_username at all.
 *
 * SKAPI_BUNDLE=<path to a 2.0.5 dist/skapi.cjs> is the mutation check: these tests MUST fail
 * there.
 *
 * Run: node ./tests/login-alias-writes.cjs
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// The SDK reads its endpoint config as a Blob through FileReader, which Node does not
// provide. Minimal shim: enough for readAsDataURL on a real Blob.
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

const BUNDLE = require.resolve(process.env.SKAPI_BUNDLE || '../dist/skapi.cjs');
const { Skapi } = require(BUNDLE);

const FIXTURES = path.join(__dirname, 'fixtures');
const OWNER = '4d4a36a5-b318-4093-92ae-7cf11feae989';
const SERVICE = 'ap21AAAAAAAAAAAAAAAA';
const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SELF_ERROR = 'Cannot modify attributes of the current user.';

// --- offline environment -----------------------------------------------------------

let captured = [];

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

    const route = u.split('?')[0].split('/').pop();

    if (route === 'admin-edit-profile') {
        captured.push({ route, url: u, body });
        return jsonResponse('SUCCESS: User attributes updated.');
    }

    return jsonResponse({ ip: '127.0.0.1', locale: 'KR', service_name: 'test', group: 99, opt: {} });
};

// --- helpers ------------------------------------------------------------------------

async function makeSkapi() {
    const s = new Skapi(SERVICE, OWNER, { autoLogin: false });
    await s.__connection;
    return s;
}

/**
 * A session shaped the way getJwtToken reads it. checkAdmin compares __user.service with the
 * instance service and logs out when they differ, so the user carries the service. owner
 * 'skapi' is the project owner's Skapi account, which checkAdmin treats as admin whatever its
 * access group. The expiry is a day out so getJwtToken never tries to refresh through Cognito.
 */
function signIn(skapi, { access_group = 99, owner = OWNER } = {}) {
    const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24;
    skapi.__user = {
        user_id: ME,
        service: SERVICE,
        owner,
        access_group,
        email: 'admin@email.com',
        email_verified: true
    };
    skapi.session = {
        getIdToken: () => ({ getExpiration: () => exp }),
        idToken: { jwtToken: 'test.id.token', payload: { exp, access_group } },
        accessToken: { jwtToken: 'test.access.token' },
        refreshToken: { token: 'test.refresh.token' }
    };
}

function lastRequest(route) {
    const hit = [...captured].reverse().find(c => c.route === route);
    assert.ok(hit, `expected a request to ${route}, got ${JSON.stringify(captured.map(c => c.route))}`);
    return hit;
}

async function rejects(fn, message) {
    let err = null;
    try { await fn(); }
    catch (e) { err = e; }
    assert.ok(err, `${message}: expected a rejection, the call resolved`);
    return err;
}

const results = [];
async function test(name, fn) {
    captured = [];
    try {
        await fn();
        results.push(['ok', name]);
        console.log(`ok    ${name}`);
    } catch (err) {
        results.push(['FAIL', name, err && err.message]);
        console.log(`FAIL  ${name}\n      ${err && err.message}`);
    }
}

// --- tests --------------------------------------------------------------------------

(async () => {
    const skapi = await makeSkapi();

    await test('the built bundle carries no preferred_username at all', async () => {
        // Every remaining mention in the source is a comment, which the minified bundle drops.
        // A hit here is a writer of the alias, the updateProfile() own-account path included.
        const source = fs.readFileSync(BUNDLE, 'utf8');
        assert.ok(!source.includes('preferred_username'), 'the bundle must not reference preferred_username');
    });

    await test('updateUserAttributes() sends a new e-mail without preferred_username', async () => {
        signIn(skapi, { access_group: 99 });
        await skapi.updateUserAttributes({ user_id: OTHER, email: 'New@Email.com', name: 'Kim' });
        const { body } = lastRequest('admin-edit-profile');
        assert.strictEqual(body.attributes.user_id, OTHER);
        assert.strictEqual(body.attributes.email, 'new@email.com');
        assert.strictEqual(body.attributes.name, 'Kim');
        assert.ok(!('preferred_username' in body.attributes), `no alias may be sent, got ${JSON.stringify(body.attributes)}`);
    });

    await test('updateUserAttributes() with a target service sends no preferred_username either', async () => {
        signIn(skapi, { access_group: 99 });
        await skapi.updateUserAttributes({ user_id: OTHER, email: 'x@email.com', service: 'ap21BBBBBBBBBBBBBBBB', owner: OWNER });
        const { body } = lastRequest('admin-edit-profile');
        assert.strictEqual(body.attributes.email, 'x@email.com');
        assert.ok(!('preferred_username' in body.attributes), `no alias may be sent, got ${JSON.stringify(body.attributes)}`);
    });

    await test('updateProfile() on another user sends a new e-mail without preferred_username', async () => {
        signIn(skapi, { access_group: 99 });
        await skapi.updateProfile({ user_id: OTHER, email: 'target@email.com' });
        const { body } = lastRequest('admin-edit-profile');
        assert.strictEqual(body.attributes.user_id, OTHER);
        assert.strictEqual(body.attributes.email, 'target@email.com');
        assert.ok(!('preferred_username' in body.attributes), `no alias may be sent, got ${JSON.stringify(body.attributes)}`);
    });

    await test('updateUserAttributes() refuses the caller\'s own user_id before any request, at every admin level', async () => {
        const callers = [
            { label: 'access group 90 admin', access_group: 90 },
            { label: 'access group 99 admin', access_group: 99 },
            { label: 'project owner account', access_group: 1, owner: 'skapi' }
        ];
        for (const caller of callers) {
            signIn(skapi, caller);
            const err = await rejects(() => skapi.updateUserAttributes({ user_id: ME, name: 'Me' }), caller.label);
            assert.strictEqual(err.code, 'INVALID_REQUEST', `${caller.label}: code`);
            assert.strictEqual(err.message, SELF_ERROR, `${caller.label}: message`);

            const withEmail = await rejects(() => skapi.updateUserAttributes({ user_id: ME, email: 'me2@email.com' }), `${caller.label} with e-mail`);
            assert.strictEqual(withEmail.message, SELF_ERROR, `${caller.label} with e-mail: message`);
        }
        assert.ok(!captured.some(c => c.route === 'admin-edit-profile'), 'a refused call must not reach the wire');
    });

    await test('updateUserAttributes() still reaches the route for another user after a refusal', async () => {
        signIn(skapi, { access_group: 90 });
        await rejects(() => skapi.updateUserAttributes({ user_id: ME, name: 'Me' }), 'own id');
        await skapi.updateUserAttributes({ user_id: OTHER, name: 'Them' });
        const { body } = lastRequest('admin-edit-profile');
        assert.strictEqual(body.attributes.user_id, OTHER);
        assert.strictEqual(body.attributes.name, 'Them');
    });

    const failed = results.filter(r => r[0] === 'FAIL');
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
})();

/**
 * Named newsletter groups: ONE group validator, used by every group taking method.
 *
 * THE BUG. Each of the four group taking methods grew its own inline check, and they
 * disagreed. `subscribeNewsletter` accepted any 1-20 character alphanumeric string,
 * while `unsubscribeNewsletter` and `getNewsletterSubscription` accepted only a number,
 * "public" or "authorized". So a named subscription could be CREATED and then never
 * removed and never read back: the SDK threw on the very token the server had just
 * stored. `getNewsletterSubscription` compounded it by running the returned token
 * through parseInt, which turns every named group into NaN.
 *
 * What this file pins is the shared validator (`validator.newsletterGroup`), the grammar
 * of NAMED_NEWSLETTERS.md section 1, and the fact that all four methods now speak it:
 *
 *   ^[a-z0-9]{2,20}$, at least one [a-z], and not one of
 *   tp, admin, public, authorized, newsletter, forward, all
 *
 * "public" and "authorized" are reserved as NAMES and still accepted as the numeric
 * aliases they have always been, which is the one place the two rules meet.
 *
 * These tests drive the REAL built bundle (dist/skapi.cjs) with the network stubbed, and
 * assert on the bytes that would go on the wire.
 *
 * Run: node ./tests/newsletter-group.cjs
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

// SKAPI_BUNDLE lets this run against another build. Pointing it at a pre-fix published
// bundle is the mutation check: the named-group tests MUST fail there.
const { Skapi } = require(process.env.SKAPI_BUNDLE || '../dist/skapi.cjs');

const FIXTURES = path.join(__dirname, 'fixtures');
const OWNER = '4d4a36a5-b318-4093-92ae-7cf11feae989';
const SERVICE = 'ap21AAAAAAAAAAAAAAAA';
const USER = '11111111-1111-4111-8111-111111111111';
const NAME = 'bunnyquery';

// Section 1. "public" and "authorized" are on this list, and are still accepted by the
// four group taking methods because they resolve to 0 and 1 BEFORE the name check.
const RESERVED = ['tp', 'admin', 'public', 'authorized', 'newsletter', 'forward', 'all'];
const RESERVED_NOT_ALIASED = RESERVED.filter(r => r !== 'public' && r !== 'authorized');
const NAME_ERROR = 'Newsletter group name must be 2-20 lowercase alphanumeric characters, contain a letter, and not be a reserved name.';

// --- offline environment -----------------------------------------------------------

let captured = [];
let subscriptionRows = [];
let groupRows = [];
let newsletterRows = [];

function jsonResponse(obj) {
    return new Response(JSON.stringify(obj), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}

globalThis.fetch = async (url, opt) => {
    const u = String(url);

    // Matched by prefix, not by version: the SDK's __endpoint_version moves while the
    // fixtures keep their filename.
    if (/\/admin-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'admin-v1.json')));
    if (/\/record-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'record-v1.json')));

    let body = null;
    try { body = JSON.parse(opt && opt.body); } catch (e) { body = opt && opt.body; }

    const route = u.split('?')[0].split('/').pop();

    if ([
        'subscribe-newsletter',
        'subscribe-public-newsletter',
        'get-newsletter-subscription',
        'get-newsletters',
        'get-public-newsletters',
        'register-newsletter-group',
        'delete-newsletter-group',
        'newsletter-group-endpoint'
    ].includes(route)) {
        captured.push({ route, url: u, body, method: (opt && opt.method) || 'GET' });

        if (route === 'get-newsletter-subscription') {
            return jsonResponse({ list: subscriptionRows, endOfList: true });
        }
        if (route === 'get-newsletters' || route === 'get-public-newsletters') {
            return jsonResponse({ list: newsletterRows, endOfList: true });
        }
        if (route === 'newsletter-group-endpoint') {
            return jsonResponse({ groups: groupRows });
        }
        if (route === 'register-newsletter-group') {
            return jsonResponse('SUCCESS: Group registered successfully.');
        }
        if (route === 'delete-newsletter-group') {
            return jsonResponse('SUCCESS: Group has been deleted along with 0 subscription(s).');
        }
        return jsonResponse('SUCCESS: Subscribed.');
    }

    // connection / service info and anything else
    return jsonResponse({ ip: '127.0.0.1', locale: 'KR', service_name: 'test', group: 99, opt: {} });
};

// --- helpers ------------------------------------------------------------------------

async function makeSkapi() {
    const s = new Skapi(SERVICE, OWNER, { autoLogin: false });
    await s.__connection;
    return s;
}

/**
 * A session shaped the way getJwtToken reads it. checkAdmin compares __user.service with
 * the instance service and LOGS OUT when they differ, so the user has to carry the
 * service or the two admin-checking methods tear the fake session down before they ever
 * validate anything.
 *
 * The expiry is a DAY out, not an hour: getJwtToken refreshes anything inside its one
 * hour skew, and a token minted exactly an hour ahead crosses that line as soon as the
 * clock ticks a second, which sends the call to Cognito and fails it.
 */
function signIn(skapi, access_group = 99) {
    const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24;
    skapi.__user = {
        user_id: USER,
        service: SERVICE,
        owner: OWNER,
        access_group,
        email: 'visitor@email.com',
        email_verified: true
    };
    skapi.session = {
        getIdToken: () => ({ getExpiration: () => exp }),
        idToken: { jwtToken: 'test.id.token', payload: { exp, access_group } },
        accessToken: { jwtToken: 'test.access.token' },
        refreshToken: { token: 'test.refresh.token' }
    };
}

function signOut(skapi) {
    skapi.__user = null;
    skapi.session = null;
}

function lastRequest(route) {
    const hit = [...captured].reverse().find(c => !route || c.route === route);
    assert.ok(hit, `expected a request${route ? ' to ' + route : ''}, got ${JSON.stringify(captured.map(c => c.route))}`);
    return hit;
}

/** A GET carries its params in the query string, a POST in the body. Read either. */
function wireOf(hit) {
    if (hit.body && typeof hit.body === 'object') {
        return hit.body;
    }
    const query = hit.url.split('?')[1] || '';
    const out = {};
    for (const [k, v] of new URLSearchParams(query)) {
        try { out[k] = JSON.parse(v); }
        catch (e) { out[k] = v; }
    }
    return out;
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

    /**
     * The four group taking methods, each reduced to "hand this group to the SDK".
     * Every rejection test below runs the SAME group through ALL FOUR, which is the
     * only way to catch the four validators drifting apart again.
     */
    const callers = {
        subscribeNewsletter: group => {
            signOut(skapi);
            return skapi.subscribeNewsletter({ email: 'visitor@email.com', group });
        },
        unsubscribeNewsletter: group => {
            signIn(skapi);
            return skapi.unsubscribeNewsletter({ group });
        },
        getNewsletterSubscription: group => {
            signIn(skapi);
            return skapi.getNewsletterSubscription({ group });
        },
        getNewsletters: group => {
            signIn(skapi);
            return skapi.getNewsletters({ searchFor: 'timestamp', value: 1, condition: '<', group });
        }
    };
    const callerNames = Object.keys(callers);

    await test('every reserved word is refused as a group NAME by registerNewsletterGroup', async () => {
        for (const word of RESERVED) {
            const err = await rejects(() => skapi.registerNewsletterGroup({ group: word }), word);
            assert.strictEqual(err.message, NAME_ERROR, `"${word}" must be refused with the contract wording`);
        }
    });

    await test('every reserved word is refused as a group NAME by deleteNewsletterGroup', async () => {
        for (const word of RESERVED) {
            const err = await rejects(() => skapi.deleteNewsletterGroup({ group: word }), word);
            assert.strictEqual(err.message, NAME_ERROR, `"${word}" must be refused with the contract wording`);
        }
    });

    await test('the reserved words that are not numeric aliases are refused by all four methods', async () => {
        for (const word of RESERVED_NOT_ALIASED) {
            for (const name of callerNames) {
                const err = await rejects(() => callers[name](word), `${name}(${word})`);
                assert.strictEqual(err.message, NAME_ERROR,
                    `${name} must refuse the reserved word "${word}" with the contract wording, got "${err.message}"`);
            }
        }
    });

    await test('a name with a dash is refused by all four methods', async () => {
        // The sending address is "-" delimited and filter_mail splits on it, so a name
        // holding a "-" would be read back as a different group entirely.
        for (const name of callerNames) {
            const err = await rejects(() => callers[name]('bunny-query'), name);
            assert.strictEqual(err.message, NAME_ERROR, `${name} must refuse "bunny-query"`);
        }
    });

    await test('a name with a "#" is refused by all four methods', async () => {
        // "#" delimits every composite key in this system, including the subscription
        // row's own "<subscriber>#<group token>".
        for (const name of callerNames) {
            const err = await rejects(() => callers[name]('bunny#query'), name);
            assert.strictEqual(err.message, NAME_ERROR, `${name} must refuse "bunny#query"`);
        }
    });

    await test('an all digit name is refused by all four methods', async () => {
        // A purely numeric name would collide with the "00".."99" vocabulary.
        for (const digits of ['00', '07', '1234']) {
            for (const name of callerNames) {
                const err = await rejects(() => callers[name](digits), `${name}(${digits})`);
                assert.strictEqual(err.message, NAME_ERROR, `${name} must refuse "${digits}"`);
            }
        }
    });

    await test('an upper case name, a one character name and a 21 character name are refused', async () => {
        for (const bad of ['BunnyQuery', 'a', 'a'.repeat(21), 'bunny query']) {
            for (const name of callerNames) {
                const err = await rejects(() => callers[name](bad), `${name}(${bad})`);
                assert.strictEqual(err.message, NAME_ERROR, `${name} must refuse "${bad}"`);
            }
        }
    });

    await test('"public" and "authorized" still resolve to 0 and 1 on the wire', async () => {
        signOut(skapi);
        await skapi.subscribeNewsletter({ email: 'visitor@email.com', group: 'public' });
        assert.strictEqual(wireOf(lastRequest('subscribe-public-newsletter')).group, 0,
            '"public" has always meant group 0 and must keep meaning it');

        signIn(skapi);
        await skapi.subscribeNewsletter({ group: 'authorized' });
        assert.strictEqual(wireOf(lastRequest('subscribe-newsletter')).group, 1,
            '"authorized" has always meant group 1 and must keep meaning it');

        await skapi.unsubscribeNewsletter({ group: 'public' });
        assert.strictEqual(wireOf(lastRequest('subscribe-newsletter')).group, 0);

        await skapi.getNewsletterSubscription({ group: 'authorized' });
        assert.strictEqual(wireOf(lastRequest('get-newsletter-subscription')).group, 1);

        await skapi.getNewsletters({ searchFor: 'timestamp', value: 1, condition: '<', group: 'public' });
        assert.strictEqual(wireOf(lastRequest('get-public-newsletters')).group, 0);
    });

    await test('the numeric groups 0, 1 and 99 are still accepted by all four methods', async () => {
        for (const group of [0, 1, 99]) {
            signOut(skapi);
            await skapi.subscribeNewsletter({ email: 'visitor@email.com', group });
            assert.strictEqual(wireOf(lastRequest()).group, group, `subscribeNewsletter(${group})`);

            signIn(skapi);
            await skapi.unsubscribeNewsletter({ group });
            assert.strictEqual(wireOf(lastRequest('subscribe-newsletter')).group, group, `unsubscribeNewsletter(${group})`);

            await skapi.getNewsletterSubscription({ group });
            assert.strictEqual(wireOf(lastRequest('get-newsletter-subscription')).group, group, `getNewsletterSubscription(${group})`);

            await skapi.getNewsletters({ searchFor: 'timestamp', value: 1, condition: '<', group });
            assert.strictEqual(wireOf(lastRequest()).group, group, `getNewsletters(${group})`);
        }
    });

    await test('a number outside 0-99 is refused', async () => {
        for (const group of [-1, 100, 1.5]) {
            for (const name of callerNames) {
                await rejects(() => callers[name](group), `${name}(${group})`);
            }
        }
    });

    await test('THE BUG: a valid name is accepted by all four methods', async () => {
        signOut(skapi);
        await skapi.subscribeNewsletter({ email: 'visitor@email.com', group: NAME });
        assert.strictEqual(wireOf(lastRequest('subscribe-public-newsletter')).group, NAME,
            'the name must reach the wire verbatim, it is the subscription row key');

        signIn(skapi);
        await skapi.unsubscribeNewsletter({ group: NAME });
        let unsub = wireOf(lastRequest('subscribe-newsletter'));
        assert.strictEqual(unsub.group, NAME,
            'a named subscription that cannot be unsubscribed can never be removed');
        assert.strictEqual(unsub.action, 'unsubscribe');

        await skapi.getNewsletterSubscription({ group: NAME });
        assert.strictEqual(wireOf(lastRequest('get-newsletter-subscription')).group, NAME);

        await skapi.getNewsletters({ searchFor: 'timestamp', value: 1, condition: '<', group: NAME });
        assert.strictEqual(wireOf(lastRequest()).group, NAME);
    });

    await test('null still means "every group" on unsubscribe and on the subscription listing', async () => {
        signIn(skapi);
        await skapi.unsubscribeNewsletter({ group: null });
        assert.strictEqual(wireOf(lastRequest('subscribe-newsletter')).group, null);

        await skapi.getNewsletterSubscription({ group: null });
        assert.strictEqual(wireOf(lastRequest('get-newsletter-subscription')).group, null);
    });

    await test('unsubscribeNewsletter still requires the "group" key to be stated', async () => {
        signIn(skapi);
        const err = await rejects(() => skapi.unsubscribeNewsletter({}), 'missing group');
        assert.match(err.message, /required/, 'an omitted group is a different thing from an explicit null');
    });

    await test('THE BUG: a named subscription token is NOT run through parseInt', async () => {
        signIn(skapi);
        subscriptionRows = [{ subt: `${NAME}#visitor@email.com`, stmp: 1700000000000 }];
        try {
            const res = await skapi.getNewsletterSubscription({ group: NAME });
            const row = (res.list || res)[0];
            assert.strictEqual(row.group, NAME,
                `a named group must come back as its name, parseInt made it ${row.group}`);
            assert.strictEqual(row.subscribed_email, 'visitor@email.com');
            assert.strictEqual(row.active, true);
        } finally { subscriptionRows = []; }
    });

    await test('a numeric subscription token still comes back as a number', async () => {
        signIn(skapi);
        subscriptionRows = [{ subt: '00#visitor@email.com', stmp: 1 }, { subt: '@07#gone@email.com', stmp: 2 }];
        try {
            const res = await skapi.getNewsletterSubscription({ group: 0 });
            const rows = res.list || res;
            assert.strictEqual(rows[0].group, 0, 'callers have always compared this as a number');
            assert.strictEqual(rows[1].group, 7, 'a "@" prefix marks an inactive subscription and is stripped');
            assert.strictEqual(rows[1].active, false);
        } finally { subscriptionRows = []; }
    });

    await test('getNewsletters route split: 0 public, named signed out public, named signed in private', async () => {
        signOut(skapi);
        await skapi.getNewsletters({ searchFor: 'timestamp', value: 1, condition: '<', group: 0 });
        assert.strictEqual(lastRequest().route, 'get-public-newsletters', 'group 0 keeps the public route');

        await skapi.getNewsletters({ searchFor: 'timestamp', value: 1, condition: '<', group: NAME });
        assert.strictEqual(lastRequest().route, 'get-public-newsletters',
            'a signed out reader has no session to authorize with, so a named group goes public');

        signIn(skapi);
        await skapi.getNewsletters({ searchFor: 'timestamp', value: 1, condition: '<', group: NAME });
        assert.strictEqual(lastRequest().route, 'get-newsletters',
            'a signed in reader is authorized, and the restriction ladder is applied server side');

        await skapi.getNewsletters({ searchFor: 'timestamp', value: 1, condition: '<', group: 2 });
        assert.strictEqual(lastRequest().route, 'get-newsletters', 'a numeric group above 0 keeps the private route');
    });

    await test('a numeric group above 0 is still refused to a signed out reader', async () => {
        signOut(skapi);
        await rejects(() => skapi.getNewsletters({ searchFor: 'timestamp', value: 1, condition: '<', group: 1 }),
            'signed out numeric group');
    });

    await test('getNewsletters still refuses a group above the user access group', async () => {
        signIn(skapi, 2);
        await rejects(() => skapi.getNewsletters({ searchFor: 'timestamp', value: 1, condition: '<', group: 5 }),
            'group above access group');
    });

    await test('the Newsletter list carries its group instead of dropping it', async () => {
        // The remap loop copies only the keys present in BOTH tables, so a field listed
        // in one and missing from the other is silently dropped.
        signIn(skapi);
        newsletterRows = [{ mid: 'm1', stmp: 1700000000000, subj: 'hello', bnce: 2, delv: 3 }];
        try {
            const res = await skapi.getNewsletters({ searchFor: 'timestamp', value: 1, condition: '<', group: NAME });
            assert.strictEqual(res.list[0].group, NAME, 'the named group must survive the remap');
            assert.strictEqual(res.list[0].message_id, 'm1', 'the existing fields are untouched');
            assert.strictEqual(res.list[0].subject, 'hello');
            assert.strictEqual(res.list[0].bounced, '2', 'bounced is still stringified');
            assert.strictEqual(res.list[0].delivered, 3, 'the existing fields are untouched');

            const numeric = await skapi.getNewsletters({ searchFor: 'timestamp', value: 1, condition: '<', group: 0 });
            assert.strictEqual(numeric.list[0].group, 0, 'a numeric group survives the remap as a number');
        } finally { newsletterRows = []; }
    });

    await test('registerNewsletterGroup sends the name, the restriction and the label', async () => {
        signIn(skapi);
        const res = await skapi.registerNewsletterGroup({ group: NAME, restriction: 0, name: 'BunnyQuery news' });
        assert.strictEqual(res, 'SUCCESS: Group registered successfully.');
        const wire = wireOf(lastRequest('register-newsletter-group'));
        assert.strictEqual(wire.group, NAME);
        assert.strictEqual(wire.restriction, 0);
        assert.strictEqual(wire.name, 'BunnyQuery news');
    });

    await test('registerNewsletterGroup refuses a numeric group, an out of range restriction and a long label', async () => {
        signIn(skapi);
        // 0-99 already exist and are not registrable, so the numeric vocabulary is not
        // accepted here even though the four subscriber facing methods take it.
        for (const group of [0, 1, 99, 'public', 'authorized']) {
            const err = await rejects(() => skapi.registerNewsletterGroup({ group }), `group ${group}`);
            assert.strictEqual(err.message, NAME_ERROR);
        }
        await rejects(() => skapi.registerNewsletterGroup({ group: NAME, restriction: 100 }), 'restriction 100');
        await rejects(() => skapi.registerNewsletterGroup({ group: NAME, restriction: -1 }), 'restriction -1');
        await rejects(() => skapi.registerNewsletterGroup({ group: NAME, name: 'x'.repeat(61) }), 'label 61 chars');
        await rejects(() => skapi.registerNewsletterGroup({}), 'missing group');
    });

    await test('deleteNewsletterGroup reaches the admin gateway with the group name', async () => {
        signIn(skapi);
        const res = await skapi.deleteNewsletterGroup({ group: NAME });
        assert.strictEqual(res, 'SUCCESS: Group has been deleted along with 0 subscription(s).');
        const hit = lastRequest('delete-newsletter-group');
        // An unrouted destination falls through to validator.Url and would have thrown
        // "is an invalid url" instead of ever reaching a gateway.
        assert.match(hit.url, /^https:\/\/[^/]+\/api\/delete-newsletter-group$/,
            `delete-newsletter-group must resolve through the admin gateway, got ${hit.url}`);
        assert.strictEqual(wireOf(hit).group, NAME);
    });

    await test('newsletterGroupEndpoint returns the registered groups', async () => {
        signIn(skapi);
        groupRows = [{
            group: NAME,
            restriction: 0,
            name: 'BunnyQuery news',
            subscribers: 1204,
            endpoint: `${SERVICE}-${NAME}-abc@mail.skapi.com`
        }];
        try {
            const res = await skapi.newsletterGroupEndpoint();
            assert.deepStrictEqual(res.groups, groupRows);
            assert.match(lastRequest('newsletter-group-endpoint').url, /\/newsletter-group-endpoint$/);
        } finally { groupRows = []; }
    });

    const failed = results.filter(r => r[0] === 'FAIL');
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
})();

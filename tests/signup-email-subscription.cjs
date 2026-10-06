/**
 * signup() option email_subscription: the newsletter a new account joins once its e-mail is
 * confirmed. It takes false, true (Service Email, as always), 0 / 'public' (the public
 * newsletter), 1 / 'authorized' (Service Email) or the NAME of a named newsletter group, in
 * the grammar every other group taking method uses (validator.newsletterGroup). The access
 * groups 2 ~ 99 are refused, and any subscription needs signup_confirmation: the e-mail is
 * confirmed before anyone is subscribed to anything.
 *
 * These tests drive the REAL built bundle (dist/skapi.cjs) with the network stubbed, and
 * assert on what signup() sends to the signupkey route. The route answers an error, which
 * stops signup() before it reaches the user pool.
 *
 * Run: node ./tests/signup-email-subscription.cjs
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

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

const { Skapi } = require(process.env.SKAPI_BUNDLE || '../dist/skapi.cjs');

const FIXTURES = path.join(__dirname, 'fixtures');
const OWNER = '4d4a36a5-b318-4093-92ae-7cf11feae989';
const SERVICE = 'ap21AAAAAAAAAAAAAAAA';
const STOP = 'stopped by the test before the user pool';
const VALUES_ERROR = '"option.email_subscription" takes 0 (public), 1 (authorized), true, false or the name of a newsletter group.';
const NAME_ERROR = 'Newsletter group name must be 2-20 lowercase alphanumeric characters, contain a letter, and not be a reserved name.';
const CONFIRMATION_ERROR = '"option.signup_confirmation" is required for email subscription.';

let captured = [];

function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

globalThis.fetch = async (url, opt) => {
    const u = String(url);
    if (/\/admin-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'admin-v1.json')));
    if (/\/record-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'record-v1.json')));

    let body = null;
    try { body = JSON.parse(opt && opt.body); } catch (e) { body = opt && opt.body; }
    const route = u.split('?')[0].split('/').pop();

    if (route === 'signupkey') {
        captured.push({ route, body });
        return jsonResponse({ code: 'INVALID_REQUEST', message: STOP }, 400);
    }
    return jsonResponse({ ip: '127.0.0.1', locale: 'KR', service_name: 'test', group: 99, opt: {} });
};

async function makeSkapi() {
    const s = new Skapi(SERVICE, OWNER, { autoLogin: false });
    await s.__connection;
    return s;
}

// What signup() sent to signupkey for this option, or the message it refused it with.
async function sent(skapi, option) {
    captured = [];
    try {
        await skapi.signup({ email: 'new@example.com', password: 'password123' }, option);
    } catch (err) {
        if (err.message !== STOP) return { refused: err.message, code: err.code };
    }
    assert.strictEqual(captured.length, 1, 'signupkey was asked once');
    return { wire: captured[0].body.email_subscription, confirmation: captured[0].body.signup_confirmation };
}

(async () => {
    const skapi = await makeSkapi();
    let passed = 0;
    const ok = (cond, name) => { assert.ok(cond, name); passed++; console.log('PASS ' + name); };

    // --- what goes on the wire ----------------------------------------------------------
    for (const [value, wire] of [[true, true], [0, 0], ['public', 'public'], [1, 1], ['authorized', 'authorized'], ['launch', 'launch']]) {
        const out = await sent(skapi, { signup_confirmation: true, email_subscription: value });
        ok(out.wire === wire && out.confirmation === 'true', 'email_subscription ' + JSON.stringify(value) + ' goes out as ' + JSON.stringify(wire) + ' with the confirmation');
    }
    let out = await sent(skapi, { signup_confirmation: 'https://example.com/welcome', email_subscription: 'launch' });
    ok(out.wire === 'launch' && out.confirmation === 'https://example.com/welcome', 'a confirmation URL counts as signup_confirmation');
    out = await sent(skapi, { signup_confirmation: true, email_subscription: false });
    ok(out.wire === false, 'false goes out as false');
    out = await sent(skapi, { signup_confirmation: true });
    ok(out.wire === false, 'left out, it goes out as false');
    out = await sent(skapi, {});
    ok(out.wire === false, 'no options at all: false, and no confirmation is demanded');
    out = await sent(skapi, { email_subscription: false });
    ok(out.wire === false, 'false needs no signup_confirmation: there is nothing to confirm into');

    // --- what is refused, before anything is sent ---------------------------------------
    for (const [value, message] of [[2, VALUES_ERROR], [99, VALUES_ERROR], [-1, '"group" should be an integer between 0 and 99.'], [0.5, '"group" should be an integer between 0 and 99.'], ['tp', NAME_ERROR], ['00', NAME_ERROR], ['01', NAME_ERROR], ['1e5', NAME_ERROR], ['Launch', NAME_ERROR], ['a', NAME_ERROR], [{}, VALUES_ERROR], [[0], VALUES_ERROR]]) {
        out = await sent(skapi, { signup_confirmation: true, email_subscription: value });
        ok(out.refused === message && out.code === 'INVALID_PARAMETER' && captured.length === 0, 'refused without a request: ' + JSON.stringify(value) + ' (' + message + ')');
    }
    for (const value of [true, 0, 'public', 1, 'authorized', 'launch']) {
        out = await sent(skapi, { email_subscription: value });
        ok(out.refused === CONFIRMATION_ERROR && captured.length === 0, 'without signup_confirmation ' + JSON.stringify(value) + ' is refused: nobody is subscribed to anything before the e-mail is confirmed');
    }

    console.log('\nALL ' + passed + ' PASSED');
})().catch(err => { console.error('FAIL', err); process.exit(1); });

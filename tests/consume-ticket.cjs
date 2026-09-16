/**
 * consumeTicket(): routing and the "stage" rule.
 *
 * A ticket registered with `return200` answers a FAILED consumption with HTTP 200,
 * so the status code says nothing. The SDK discriminates on the body instead: an
 * error body always carries "stage", a success body never does. Offline, with the
 * network stubbed, this proves that
 *   - a 200 body with "stage" rejects with a SkapiError carrying the code and the body as cause,
 *   - a 400 body with "stage" rejects the same way (the cause survives _fetch),
 *   - a 400 body with "stage" and a code but no message still rejects with that code,
 *   - a success body resolves with the mapped consumption; a non-object body (the check
 *     route answers a JSON string) resolves as is,
 *   - auth + GET, a missing or malformed ticket_id are refused before any request goes out,
 *   - anonymous POST -> /tp/, anonymous GET -> /tg/ with data as the query string,
 *     signed-in POST -> /tpa/ with the id token; the body never carries service/owner.
 *
 * Run: node ./tests/consume-ticket.cjs
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { Skapi, SkapiError } = require(process.env.SKAPI_BUNDLE || '../dist/skapi.cjs');

const FIXTURES = path.join(__dirname, 'fixtures');
const OWNER = '4d4a36a5-b318-4093-92ae-7cf11feae989';
const SERVICE = 'ap21AAAAAAAAAAAAAAAA';
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function toBase62(n) {
    let s = '';
    do { s = BASE62[n % 62] + s; n = Math.floor(n / 62); } while (n > 0);
    return s;
}

globalThis.FileReader = class FileReader {
    readAsDataURL(blob) {
        blob.arrayBuffer().then((ab) => {
            this.result = 'data:application/json;base64,' + Buffer.from(ab).toString('base64');
            if (this.onloadend) this.onloadend();
        });
    }
};

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

// What the next consume call answers with, and what it received.
let consumeAnswer = null;
let received = null;

globalThis.fetch = async (u, init) => {
    u = String(u);
    if (/\/admin-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'admin-v1.json')));
    if (/\/record-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'record-v1.json')));
    if (/\.skapi\.dev\/(tp|tg|tpa)\//.test(u)) {
        received = { url: u, method: init && init.method, headers: (init && init.headers) || {}, body: init && init.body };
        const { body, status } = consumeAnswer;
        return json(body, status);
    }
    return json({ ip: '1', locale: 'KR', service_name: 't', group: 99, opt: {} });
};

async function makeSkapi(signedIn) {
    const s = new Skapi(SERVICE, OWNER, { autoLogin: false });
    await s.__connection;
    if (signedIn) {
        const exp = Math.floor(Date.now() / 1000) + 86400;
        s.__user = { user_id: OWNER, access_group: 1, service: s.service, owner: OWNER };
        s.session = {
            getIdToken: () => ({ getExpiration: () => exp }),
            idToken: { jwtToken: 'id-token', payload: { exp } },
            accessToken: { jwtToken: 'a' }, refreshToken: { token: 'r' },
        };
    }
    return s;
}

function answer(body, status = 200) {
    consumeAnswer = { body, status };
    received = null;
}

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && (err.stack || err.message)]); }
}

const STAMP = 1757740800000;
const CONSUME_ID = toBase62(STAMP) + 'Ab9z';
const ERROR_BODY = {
    code: 'CONDITION_FAILED',
    message: 'The request did not match the ticket condition.',
    stage: 'condition',
    detail: { field: 'data', keys: ['type'] },
    ticket_id: 'order-paid',
};

(async () => {

/* ---- the stage rule ------------------------------------------------------ */

await test('a 200 body with "stage" rejects (return200 ticket)', async () => {
    const s = await makeSkapi(false);
    answer(ERROR_BODY, 200);
    await assert.rejects(
        () => s.consumeTicket({ ticket_id: 'order-paid', method: 'POST', data: { type: 'x' } }),
        (e) => {
            assert.ok(e instanceof SkapiError, 'not a SkapiError: ' + e);
            assert.strictEqual(e.code, 'CONDITION_FAILED');
            assert.strictEqual(e.message, ERROR_BODY.message);
            assert.ok(e.cause, 'cause missing');
            assert.strictEqual(e.cause.stage, 'condition');
            assert.deepStrictEqual(e.cause.detail, { field: 'data', keys: ['type'] });
            assert.strictEqual(e.cause.ticket_id, 'order-paid');
            return true;
        });
    assert.ok(received, 'the request never went out');
});

await test('a 400 body with "stage" rejects with the same shape', async () => {
    const s = await makeSkapi(false);
    const body = Object.assign({}, ERROR_BODY, {
        code: 'ACTION_FAILED', stage: 'action',
        action: { act: 'pstr', path: 'actions[1].err[0]' },
        detail: { code: 'INVALID_PARAMETER', message: 'Table name is required.' },
    });
    answer(body, 400);
    await assert.rejects(
        () => s.consumeTicket({ ticket_id: 'order-paid', method: 'POST', data: {} }),
        (e) => {
            assert.ok(e instanceof SkapiError, 'not a SkapiError: ' + e);
            assert.strictEqual(e.code, 'ACTION_FAILED');
            assert.ok(e.cause, 'cause missing on a 4xx');
            assert.strictEqual(e.cause.stage, 'action');
            assert.deepStrictEqual(e.cause.action, { act: 'pstr', path: 'actions[1].err[0]' });
            assert.strictEqual(e.cause.detail.code, 'INVALID_PARAMETER');
            return true;
        });
});

await test('a 400 body with "stage" and a code but no message rejects with the code', async () => {
    const s = await makeSkapi(false);
    answer({ code: 'TICKET_NOT_FOUND', stage: 'ticket', ticket_id: 'order-paid' }, 400);
    await assert.rejects(
        () => s.consumeTicket({ ticket_id: 'order-paid', method: 'POST' }),
        (e) => {
            assert.ok(e instanceof SkapiError, 'not a SkapiError: ' + JSON.stringify(e));
            assert.strictEqual(e.code, 'TICKET_NOT_FOUND');
            assert.strictEqual(e.message, 'TICKET_NOT_FOUND');
            assert.strictEqual(e.cause.stage, 'ticket');
            return true;
        });
});

await test('a non-object body (the check route answers a JSON string) resolves as is', async () => {
    const s = await makeSkapi(false);
    answer('SUCCESS: Ticket check passed. No action taken.', 200);
    const r = await s.consumeTicket({ ticket_id: 'order-paid', method: 'POST' });
    assert.strictEqual(r, 'SUCCESS: Ticket check passed. No action taken.');
});

await test('a success body resolves with the mapped consumption', async () => {
    const s = await makeSkapi(false);
    answer({ tkid: `#order-paid#${CONSUME_ID}#1.2.3.4(Mozilla/5.0 (X11) Gecko)`, hash: 'abc' }, 200);
    const r = await s.consumeTicket({ ticket_id: 'order-paid', method: 'POST', data: { type: 'checkout.session.completed' } });
    assert.deepStrictEqual(r, {
        ticket_id: 'order-paid',
        consume_id: CONSUME_ID,
        user_id: '1.2.3.4(Mozilla/5.0 (X11) Gecko)',
        is_test: false,
        timestamp: STAMP,
        hash: 'abc',
    });
    assert.ok(!('stage' in r));
});

await test('a dry-run consume id marks is_test', async () => {
    const s = await makeSkapi(false);
    answer({ tkid: `#order-paid#${toBase62(STAMP)}:CHK#u1`, hash: 'h' }, 200);
    const r = await s.consumeTicket({ ticket_id: 'order-paid', method: 'POST' });
    assert.strictEqual(r.is_test, true);
    assert.strictEqual(r.timestamp, STAMP);
    assert.strictEqual(r.user_id, 'u1');
});

/* ---- parameter checks, before any request -------------------------------- */

await test('auth with GET is INVALID_PARAMETER and sends nothing', async () => {
    const s = await makeSkapi(true);
    answer({ tkid: '#x#y#z', hash: 'h' }, 200);
    await assert.rejects(
        () => s.consumeTicket({ ticket_id: 'order-paid', method: 'GET', auth: true }),
        (e) => e.code === 'INVALID_PARAMETER' && e.message === 'Signed-in consumption is POST only.');
    assert.strictEqual(received, null, 'a request went out');
});

await test('a missing ticket_id and an unknown method are INVALID_PARAMETER', async () => {
    const s = await makeSkapi(false);
    answer({ tkid: '#x#y#z', hash: 'h' }, 200);
    await assert.rejects(() => s.consumeTicket({ method: 'POST' }), (e) => e.code === 'INVALID_PARAMETER');
    await assert.rejects(() => s.consumeTicket({ ticket_id: 'a', method: 'PUT' }), (e) => e.code === 'INVALID_PARAMETER');
    assert.strictEqual(received, null, 'a request went out');
});

await test('a ticket_id outside ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ is INVALID_PARAMETER and sends nothing', async () => {
    const s = await makeSkapi(false);
    answer({ tkid: '#x#y#z', hash: 'h' }, 200);
    for (const bad of ['a b/c?x=1', '#order-paid', '!t', '-t', 'a'.repeat(65), 'order/paid']) {
        await assert.rejects(() => s.consumeTicket({ ticket_id: bad, method: 'POST' }), (e) => e.code === 'INVALID_PARAMETER', 'accepted ' + JSON.stringify(bad));
    }
    assert.strictEqual(received, null, 'a request went out');
    // the pattern's edges are accepted
    for (const good of ['a', '0', 'a'.repeat(64), 'order-paid_2']) {
        await s.consumeTicket({ ticket_id: good, method: 'POST' });
        assert.strictEqual(received.url, `https://ap21.skapi.dev/tp/${SERVICE}/${good}`);
    }
});

/* ---- routing -------------------------------------------------------------- */

await test('anonymous POST goes to /tp/ with the data as the JSON body', async () => {
    const s = await makeSkapi(false);
    answer({ tkid: '#order-paid#' + CONSUME_ID + '#u', hash: 'h' }, 200);
    await s.consumeTicket({ ticket_id: 'order-paid', method: 'POST', data: { type: 'x', n: 1 } });
    assert.strictEqual(received.url, `https://ap21.skapi.dev/tp/${SERVICE}/order-paid`);
    assert.strictEqual(received.method, 'POST');
    assert.deepStrictEqual(JSON.parse(received.body), { type: 'x', n: 1 });
    assert.ok(!received.headers.Authorization, 'anonymous route carried a token');
});

await test('anonymous GET goes to /tg/ with the data as the query string', async () => {
    const s = await makeSkapi(false);
    answer({ tkid: '#launch-coupon#' + CONSUME_ID + '#u', hash: 'h' }, 200);
    await s.consumeTicket({ ticket_id: 'launch-coupon', method: 'get', data: { code: 'LAUNCH24', n: 1, ok: true } });
    const url = new URL(received.url);
    assert.strictEqual(url.origin + url.pathname, `https://ap21.skapi.dev/tg/${SERVICE}/launch-coupon`);
    assert.strictEqual(received.method, 'GET');
    assert.strictEqual(url.searchParams.get('code'), 'LAUNCH24');
    assert.strictEqual(url.searchParams.get('n'), '1');
    assert.strictEqual(url.searchParams.get('ok'), 'true');
    assert.ok(!url.searchParams.has('service') && !url.searchParams.has('owner'), 'service/owner leaked into the query string');
    assert.ok(!received.body, 'a GET carried a body');
});

await test('a GET without data has no query string', async () => {
    const s = await makeSkapi(false);
    answer({ tkid: '#launch-coupon#' + CONSUME_ID + '#u', hash: 'h' }, 200);
    await s.consumeTicket({ ticket_id: 'launch-coupon', method: 'GET' });
    assert.strictEqual(received.url, `https://ap21.skapi.dev/tg/${SERVICE}/launch-coupon`);
});

await test('signed-in POST goes to /tpa/ with the id token', async () => {
    const s = await makeSkapi(true);
    answer({ tkid: '#order-paid#' + CONSUME_ID + '#' + OWNER, hash: 'h' }, 200);
    const r = await s.consumeTicket({ ticket_id: 'order-paid', method: 'POST', auth: true, data: { seat: 'A1' } });
    assert.strictEqual(received.url, `https://ap21.skapi.dev/tpa/${SERVICE}/order-paid`);
    assert.strictEqual(received.method, 'POST');
    assert.strictEqual(received.headers.Authorization, 'id-token');
    assert.deepStrictEqual(JSON.parse(received.body), { seat: 'A1' });
    assert.strictEqual(r.user_id, OWNER);
});

let failed = 0;
for (const [ok, name, detail] of results) {
    console.log((ok ? 'ok   ' : 'FAIL ') + ' ' + name + (detail ? '  -> ' + detail : ''));
    if (!ok) failed++;
}
console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);

})();

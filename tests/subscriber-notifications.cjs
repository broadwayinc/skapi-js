/**
 * Subscriber notifications: what the SDK sends for them.
 *
 * - postRecord's `notification: { title, body }` goes to post-record as is, and needs
 *   both a title and a body. bulkPostRecords checks each item the same way.
 * - subscribe() sends only the options it is given. The server keeps the stored value
 *   of an option left out, so turning get_notified on or off leaves get_feed alone;
 *   these used to default to false in the SDK, which reset every option left out.
 * - subscribe({ get_email: false }) is not refused for a user without a verified email.
 * - The Subscription subscribe() returns carries the options the server stored.
 *
 * Run: node ./tests/subscriber-notifications.cjs
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { Skapi } = require(process.env.SKAPI_BUNDLE || '../dist/skapi.cjs');

const FIXTURES = path.join(__dirname, 'fixtures');
const OWNER = '4d4a36a5-b318-4093-92ae-7cf11feae989';
const SERVICE = 'ap21AAAAAAAAAAAAAAAA';
const ME = 'c5ec703d-1517-492e-9118-be47d4d3d596';
const THEM = 'b0000000-0000-4000-8000-000000000001';

globalThis.FileReader = class FileReader {
    readAsDataURL(blob) {
        blob.arrayBuffer().then((ab) => {
            this.result = 'data:application/json;base64,' + Buffer.from(ab).toString('base64');
            if (this.onloadend) this.onloadend();
        });
    }
};

let sent = [];
let storedOpt = {};
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (u, opt) => {
    u = String(u);
    if (/\/admin-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'admin-v1.json')));
    if (/\/record-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'record-v1.json')));
    const route = u.split('?')[0].split('/').pop();
    if (route === 'post-record' || route === 'subscription') {
        const body = JSON.parse(opt.body);
        sent.push({ route, body });
        if (route === 'subscription') {
            return json({ sub: `${THEM}#01#${ME}`, grp: 'Y#01', stmp: 1, opt: storedOpt });
        }
        const items = body._is_bulk_ || [body];
        const out = items.map((_, i) => ({
            rec: 'Rec' + i, tbl: `posts/${SERVICE}/01`, usr_tbl: `${ME}/posts/${SERVICE}/01`, usr: ME,
            srvc: `${SERVICE}/${OWNER}`, upd: 1, rfd: 0, ip: '1-1-1-1',
        }));
        return json(body._is_bulk_ ? out : out[0]);
    }
    return json({ ip: '1', locale: 'KR', service_name: 't', group: 99, opt: {} });
};

async function signedIn(user = {}) {
    const s = new Skapi(SERVICE, OWNER, { autoLogin: false });
    await s.__connection;
    const exp = Math.floor(Date.now() / 1000) + 86400;
    s.__user = Object.assign({ user_id: ME, access_group: 1, service: s.service, owner: OWNER }, user);
    s.session = {
        getIdToken: () => ({ getExpiration: () => exp }),
        idToken: { jwtToken: 't', payload: { exp } },
        accessToken: { jwtToken: 'a' }, refreshToken: { token: 'r' },
    };
    return s;
}

const results = [];
async function test(name, fn) {
    sent = [];
    storedOpt = {};
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

const NOTIFY = { name: 'posts', access_group: 1, subscription: { notify_subscribers: true } };

(async () => {

await test('postRecord sends notification with the record', async () => {
    const s = await signedIn();
    await s.postRecord({ a: 1 }, { table: NOTIFY, notification: { title: '새 글', body: 'Read it' } });
    assert.deepStrictEqual(sent[0].body.notification, { title: '새 글', body: 'Read it' });
    assert.deepStrictEqual(sent[0].body.table.subscription, { notify_subscribers: true });
});

await test('postRecord without notification sends none', async () => {
    const s = await signedIn();
    await s.postRecord({ a: 1 }, { table: NOTIFY });
    assert.ok(!('notification' in sent[0].body));
});

await test('notification needs a title and a body', async () => {
    const s = await signedIn();
    for (const [n, missing] of [[{ title: 'T' }, 'body'], [{ body: 'B' }, 'title'], [{ title: ' ', body: 'B' }, 'title']]) {
        await assert.rejects(
            () => s.postRecord({ a: 1 }, { table: NOTIFY, notification: n }),
            (e) => e.code === 'INVALID_PARAMETER' && e.message === `"notification.${missing}" is required.`,
        );
    }
    await assert.rejects(
        () => s.postRecord({ a: 1 }, { table: NOTIFY, notification: 'hello' }),
        (e) => e.code === 'INVALID_PARAMETER',
    );
    assert.strictEqual(sent.length, 0);
});

await test('bulkPostRecords checks and sends each item\'s notification', async () => {
    const s = await signedIn();
    await s.bulkPostRecords([
        { data: { n: 1 }, table: NOTIFY, notification: { title: 'A', body: 'a' } },
        { data: { n: 2 }, table: NOTIFY },
    ]);
    const items = sent[0].body._is_bulk_;
    assert.deepStrictEqual(items.map((i) => i.notification), [{ title: 'A', body: 'a' }, undefined]);
    await assert.rejects(() => s.bulkPostRecords([{ data: {}, table: NOTIFY, notification: { title: 'A' } }]));
});

await test('subscribe sends only the options it is given', async () => {
    const s = await signedIn();
    await s.subscribe({ user_id: THEM, get_notified: true });
    assert.deepStrictEqual(sent[0].body.option, { get_notified: true });
    await s.subscribe({ user_id: THEM, get_notified: false });
    assert.deepStrictEqual(sent[1].body.option, { get_notified: false });
    await s.subscribe({ user_id: THEM });
    assert.deepStrictEqual(sent[2].body.option, {});
});

await test('subscribe with get_email: false is fine without a verified email', async () => {
    const s = await signedIn({ email: undefined, email_verified: false });
    await s.subscribe({ user_id: THEM, get_feed: true, get_email: false });
    assert.deepStrictEqual(sent[0].body.option, { get_feed: true, get_email: false });
    await assert.rejects(
        () => s.subscribe({ user_id: THEM, get_email: true }),
        (e) => /User has no verified email address\./.test(e.message),
    );
});

await test('the Subscription returned carries the stored options', async () => {
    const s = await signedIn();
    storedOpt = { get_feed: true, get_notified: true, get_email: false };
    const sub = await s.subscribe({ user_id: THEM, get_notified: true });
    assert.strictEqual(sub.subscription, THEM);
    assert.strictEqual(sub.subscriber, ME);
    assert.strictEqual(sub.get_feed, true);
    assert.strictEqual(sub.get_notified, true);
});

let failed = 0;
for (const [ok, name, detail] of results) {
    console.log((ok ? 'ok   ' : 'FAIL ') + ' ' + name + (detail ? '  -> ' + detail : ''));
    if (!ok) failed++;
}
console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);

})();

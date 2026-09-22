/**
 * `new Skapi('<Project ID>')`: the docs' placeholder asks for the Project ID.
 *
 * In a browser the SDK asks with window.prompt(); in Node it asks on the
 * terminal. Everything the constructor would start (endpoint fetches, auth
 * restore, service connection) waits for the answer, and so does every call made
 * on the instance in the meantime. The answer is kept in sessionStorage (in Node:
 * in memory for the life of the process) and reused for the next placeholder.
 * Where nobody can be asked (no terminal), the constructor throws as it always did.
 *
 * Each scenario runs in its own child process, because the saved id and the open
 * question belong to the process. The child's stdin is a pipe driven by this
 * file; `tty.isatty` is patched in the child so the SDK treats it as a terminal.
 *
 * Run: node ./tests/project-id-placeholder.cjs
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const BUNDLE = process.env.SKAPI_BUNDLE || path.join(__dirname, '../dist/skapi.cjs');
const FIXTURES = path.join(__dirname, 'fixtures');
const OWNER = '4d4a36a5-b318-4093-92ae-7cf11feae989';
const SERVICE = 'ap21AAAAAAAAAAAAAAAA';

/* ---- child side ---------------------------------------------------------- */

if (process.env.PROJECT_ID_CHILD) {
    const scenario = process.env.PROJECT_ID_CHILD;
    if (process.env.FAKE_TTY) {
        require('tty').isatty = () => true;
    }

    const out = { fetches: [], unhandled: [] };
    process.on('unhandledRejection', (e) => out.unhandled.push(String(e && e.message || e)));

    globalThis.FileReader = class FileReader {
        readAsDataURL(blob) {
            blob.arrayBuffer().then((ab) => {
                this.result = 'data:application/json;base64,' + Buffer.from(ab).toString('base64');
                if (this.onloadend) this.onloadend();
            });
        }
    };
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    globalThis.fetch = async (u, opt) => {
        u = String(u);
        out.fetches.push({ url: u, meta: (opt && opt.headers && opt.headers['Content-Meta']) || '', at: Date.now() });
        if (/\/admin-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'admin-v1.json')));
        if (/\/record-v[\d.]+\.json/.test(u)) return new Response(fs.readFileSync(path.join(FIXTURES, 'record-v1.json')));
        if (u.includes('get-records')) return json({ list: [], endOfList: true });
        if (process.env.SERVICE_FAILS) return json({ message: 'Service does not exist.', code: 'NOT_EXISTS' }, 400);
        return json({ ip: '1', locale: 'KR', service_name: 't', group: 99, opt: {} });
    };

    // The time the accepted answer reached stdin, to prove nothing went out before it.
    process.stdin.on('data', (chunk) => {
        if (!out.answeredAt && String(chunk).includes(process.env.VALID_ID)) out.answeredAt = Date.now();
    });

    const { Skapi } = require(BUNDLE);
    const done = (extra) => {
        Object.assign(out, extra);
        out.saved = window.sessionStorage.getItem('skapi:project_id');
        process.stdout.write(JSON.stringify(out));
        process.stdin.destroy();
    };
    const errOf = (p) => p.then(() => null, (e) => ({ message: e.message, code: e.code }));

    (async () => {
        if (scenario === 'ask') {
            const s = new Skapi('<Project ID>', { autoLogin: false });
            // Made straight away, while the question is still open.
            const info = s.getConnectionInfo();
            const records = s.getRecords({ table: { name: 'notes', access_group: 0 } });
            const twin = new Skapi('<Project ID>', { autoLogin: false });
            const [i, r, t] = await Promise.all([info, records, twin.getConnectionInfo()]);
            const after = new Skapi('<Project ID>', { autoLogin: false });
            await after.getConnectionInfo();
            done({
                service: s.service, owner: s.owner, project_id: i.project_id,
                records: Array.isArray(r.list), twin: t.project_id, after: after.project_id,
            });
        }
        else if (scenario === 'encryption') {
            const s = new Skapi('<Project ID>', { autoLogin: false, encryption: true });
            // Undecorated and does not await the connection: it has to wait for the
            // answer itself, or it reports the encryption it has not set up yet.
            const lock = await s.lockEncryption();
            done({ lock });
        }
        else if (scenario === 'cancel') {
            const s = new Skapi('<Project ID>', { autoLogin: false });
            const e1 = await errOf(s.getConnectionInfo());
            const e2 = await errOf(s.getRecords({ table: { name: 'notes', access_group: 0 } }));
            const e3 = await errOf(s.__connection);
            done({ e1, e2, e3 });
        }
        else if (scenario === 'saved') {
            window.sessionStorage.setItem('skapi:project_id', process.env.VALID_ID);
            const s = new Skapi('<Project ID>', { autoLogin: false });
            const i = await s.getConnectionInfo();
            done({ service: s.service, owner: s.owner, project_id: i.project_id });
        }
        else if (scenario === 'saved-fails') {
            window.sessionStorage.setItem('skapi:project_id', process.env.VALID_ID);
            const s = new Skapi('<Project ID>', { autoLogin: false });
            const e = await errOf(s.__connection);
            await new Promise((r) => setTimeout(r, 0));
            done({ e });
        }
        else if (scenario === 'no-tty') {
            let thrown = null;
            try { new Skapi('<Project ID>'); } catch (e) { thrown = { message: e.message, code: e.code }; }
            done({ thrown });
        }
        else if (scenario === 'saved-garbage') {
            window.sessionStorage.setItem('skapi:project_id', 'not a project id');
            let thrown = null;
            try { new Skapi('<Project ID>'); } catch (e) { thrown = { message: e.message }; }
            done({ thrown });
        }
        else if (scenario === 'real-id') {
            let thrown = null;
            try { new Skapi('abc-def'); } catch (e) { thrown = { message: e.message }; }
            const s = new Skapi(process.env.VALID_ID, { autoLogin: false });
            await s.__connection;
            done({ thrown, service: s.service, owner: s.owner, gate: s.__projectIdInput });
        }
    })().catch((e) => { done({ crashed: String(e && e.stack || e) }); });
    return;
}

/* ---- parent side --------------------------------------------------------- */

// Runs a scenario. `script(child, stderrSoFar)` is called on every stderr chunk
// and writes the answers; resolves to { out, stderr, code } once the child exits.
function run(scenario, env, script) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [__filename], {
            env: Object.assign({}, process.env, { PROJECT_ID_CHILD: scenario }, env),
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error(`${scenario}: timed out; stderr: ${stderr}`)); }, 20000);
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; if (script) script(child, stderr); });
        child.on('exit', (code) => {
            clearTimeout(timer);
            let out = null;
            try { out = JSON.parse(stdout); } catch (e) { return reject(new Error(`${scenario}: bad output ${stdout} / ${stderr}`)); }
            resolve({ out, stderr, code });
        });
    });
}

const count = (s, needle) => s.split(needle).length - 1;

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

(async () => {

// A real compound Project ID for SERVICE/OWNER, from the SDK itself.
// project_id is set synchronously by the constructor; the fetch it starts is
// never answered, so nothing leaves this machine.
globalThis.fetch = () => new Promise(() => {});
const { Skapi } = require(BUNDLE);
const PROJECT_ID = new Skapi(SERVICE, OWNER, { autoLogin: false }).project_id;
assert.ok(PROJECT_ID && PROJECT_ID.split('-').length === 2, 'could not build a Project ID');
const env = { VALID_ID: PROJECT_ID };

await test('asks on the terminal, re-asks on an invalid answer, and starts with the valid one', async () => {
    let step = 0;
    const { out, stderr, code } = await run('ask', Object.assign({ FAKE_TTY: '1' }, env), (child, err) => {
        if (step === 0 && count(err, 'Enter your Project ID: ') === 1) {
            step = 1;
            // Give the calls made at construction every chance to go out early.
            setTimeout(() => child.stdin.write('not-a-project-id\n'), 150);
        }
        else if (step === 1 && err.includes('is not a valid Project ID')) {
            step = 2;
            child.stdin.write(`  ${PROJECT_ID}  \n`);
        }
    });
    assert.ok(!out.crashed, out.crashed);
    assert.strictEqual(code, 0);
    assert.ok(stderr.includes('new Skapi() was given the placeholder "<Project ID>" instead of your Project ID.'), stderr);
    assert.ok(stderr.includes('"not-a-project-id" is not a valid Project ID.'), stderr);
    assert.strictEqual(out.service, SERVICE);
    assert.strictEqual(out.owner, OWNER);
    assert.strictEqual(out.project_id, PROJECT_ID, 'getConnectionInfo() made during the question');
    assert.strictEqual(out.records, true, 'getRecords() made during the question');
    assert.strictEqual(out.saved, PROJECT_ID, 'the answer is saved, trimmed');
    assert.deepStrictEqual(out.unhandled, []);
});

await test('nothing reaches the network before the answer', async () => {
    let step = 0;
    const { out } = await run('ask', Object.assign({ FAKE_TTY: '1' }, env), (child, err) => {
        if (step === 0 && err.includes('Enter your Project ID: ')) {
            step = 1;
            setTimeout(() => child.stdin.write(PROJECT_ID + '\n'), 300);
        }
    });
    assert.ok(out.answeredAt, 'the answer was not seen');
    assert.ok(out.fetches.length > 0, 'nothing was fetched at all');
    const early = out.fetches.filter((f) => f.at < out.answeredAt);
    assert.deepStrictEqual(early.map((f) => f.url), [], 'fetched before the answer');
    // The service and owner travel in the Content-Meta header.
    const recordCall = out.fetches.find((f) => f.url.includes('get-records'));
    assert.ok(recordCall, 'getRecords never went out');
    const meta = JSON.parse(recordCall.meta);
    assert.strictEqual(meta.service, SERVICE, 'getRecords went out with the wrong service');
    assert.strictEqual(meta.owner, OWNER, 'getRecords went out with the wrong owner');
});

await test('instances created while the question is open share ONE question; later ones reuse the answer', async () => {
    let step = 0;
    const { out, stderr } = await run('ask', Object.assign({ FAKE_TTY: '1' }, env), (child, err) => {
        if (step === 0 && err.includes('Enter your Project ID: ')) {
            step = 1;
            setTimeout(() => child.stdin.write(PROJECT_ID + '\n'), 50);
        }
    });
    assert.strictEqual(count(stderr, 'Enter your Project ID: '), 1, stderr);
    assert.strictEqual(out.twin, PROJECT_ID);
    assert.strictEqual(out.after, PROJECT_ID);
});

await test('lockEncryption() made during the question waits for it instead of reporting "disabled"', async () => {
    let step = 0;
    const { out } = await run('encryption', Object.assign({ FAKE_TTY: '1' }, env), (child, err) => {
        if (step === 0 && err.includes('Enter your Project ID: ')) {
            step = 1;
            setTimeout(() => child.stdin.write(PROJECT_ID + '\n'), 50);
        }
    });
    assert.ok(!out.crashed, out.crashed);
    assert.deepStrictEqual(out.lock, { status: 'locked' });
});

await test('end of input cancels: every waiting call rejects with "Project ID is required." and nothing is unhandled', async () => {
    let step = 0;
    const { out, code } = await run('cancel', Object.assign({ FAKE_TTY: '1' }, env), (child, err) => {
        if (step === 0 && err.includes('Enter your Project ID: ')) {
            step = 1;
            child.stdin.end();
        }
    });
    assert.strictEqual(code, 0);
    for (const e of [out.e1, out.e2, out.e3]) {
        assert.ok(e, 'a call resolved after a cancel');
        assert.strictEqual(e.message, 'Project ID is required.');
        assert.strictEqual(e.code, 'INVALID_PARAMETER');
    }
    assert.strictEqual(out.fetches.length, 0, 'fetched after a cancel');
    assert.strictEqual(out.saved, null);
    assert.deepStrictEqual(out.unhandled, []);
});

await test('a saved answer is reused without asking, even with no terminal', async () => {
    const { out, stderr } = await run('saved', env);
    assert.ok(!out.crashed, out.crashed);
    assert.strictEqual(stderr, '');
    assert.strictEqual(out.service, SERVICE);
    assert.strictEqual(out.owner, OWNER);
    assert.strictEqual(out.project_id, PROJECT_ID);
});

await test('a saved answer that does not reach a project is forgotten', async () => {
    const { out } = await run('saved-fails', Object.assign({ SERVICE_FAILS: '1' }, env));
    assert.ok(out.e, 'the connection did not fail');
    assert.strictEqual(out.saved, null);
    assert.deepStrictEqual(out.unhandled, []);
});

await test('with no terminal and nothing saved the constructor throws, as before', async () => {
    const { out, stderr } = await run('no-tty', env);
    assert.deepStrictEqual(out.thrown, { message: 'Project ID is required.', code: 'INVALID_PARAMETER' });
    assert.strictEqual(stderr, '', 'asked with no terminal');
});

await test('a saved value that is not a Project ID is dropped, not used', async () => {
    const { out } = await run('saved-garbage', env);
    assert.deepStrictEqual(out.thrown, { message: 'Project ID is required.' });
    assert.strictEqual(out.saved, null);
});

await test('a real Project ID is untouched: no question, no gate, invalid ids still throw', async () => {
    const { out, stderr } = await run('real-id', Object.assign({ FAKE_TTY: '1' }, env));
    assert.strictEqual(stderr, '');
    assert.deepStrictEqual(out.thrown, { message: 'Service ID is invalid.' });
    assert.strictEqual(out.service, SERVICE);
    assert.strictEqual(out.owner, OWNER);
    assert.strictEqual(out.gate, null);
    assert.strictEqual(out.saved, null, 'a real id is not saved');
});

let failed = 0;
for (const [ok, name, detail] of results) {
    console.log((ok ? 'ok   ' : 'FAIL ') + ' ' + name + (detail ? '  -> ' + detail : ''));
    if (!ok) failed++;
}
console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);

})();

// Offline checks for the 2.6.0 record changes: source.can_modify_referencing_records,
// record.updated_by (prv_acs.upb) and the redacted "ip" field. No network calls.
//
// Bundles src/methods/database.ts with esbuild (a devDependency through tsup) and
// re-exports the private setupPostRecordConfig so its validation can be called directly.
//
//   node ./tests/referencing-owner-rights.cjs

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const esbuild = require('esbuild');

const repoRoot = path.resolve(__dirname, '..');
const databaseTs = path.join(repoRoot, 'src', 'methods', 'database.ts');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

async function load() {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skapi-ref-owner-'));
    const outfile = path.join(outDir, 'database.cjs');
    await esbuild.build({
        stdin: {
            contents: `export { normalizeRecord, setupPostRecordConfig } from ${JSON.stringify(databaseTs)};`,
            resolveDir: repoRoot,
            loader: 'ts'
        },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile,
        logLevel: 'silent',
        define: { __SKAPI_VERSION__: JSON.stringify(pkg.version) },
        plugins: [{
            name: 'expose-setup-post-record-config',
            setup(build) {
                build.onLoad({ filter: /[\\/]methods[\\/]database\.ts$/ }, args => ({
                    contents: fs.readFileSync(args.path, 'utf8') + '\nexport { setupPostRecordConfig };\n',
                    loader: 'ts'
                }));
            }
        }]
    });
    try {
        return require(outfile);
    }
    finally {
        fs.rmSync(outDir, { recursive: true, force: true });
    }
}

const ctx = { __user: { user_id: 'user-a' }, service: 'service-id', owner: 'owner-id', __private_access_key: {}, __my_unique_ids: {} };

function baseRecord(extra) {
    return Object.assign({
        rec: '1AbCdEfGh12345abcd',
        usr: 'user-b',
        tbl: 'comments/service-id/00',
        ip: '203.0.113.5#',
        prv_acs: {}
    }, extra);
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

let db;

test('version is 2.6.0', () => {
    assert.strictEqual(pkg.version, '2.6.0');
});

test('postRecord accepts source.can_modify_referencing_records as a boolean', () => {
    const { config } = db.setupPostRecordConfig.call(ctx, {
        table: { name: 'posts', access_group: 'public' },
        source: { can_modify_referencing_records: true }
    });
    assert.strictEqual(config.source.can_modify_referencing_records, true);

    const off = db.setupPostRecordConfig.call(ctx, {
        record_id: 'rec1',
        source: { can_modify_referencing_records: false }
    });
    assert.strictEqual(off.config.source.can_modify_referencing_records, false);
});

test('postRecord rejects a non-boolean can_modify_referencing_records', () => {
    assert.throws(() => db.setupPostRecordConfig.call(ctx, {
        table: { name: 'posts' },
        source: { can_modify_referencing_records: 'yes' }
    }), err => /can_modify_referencing_records/.test(String(err && err.message)) && /boolean/.test(String(err && err.message)));
});

test('reference: null still unlinks', () => {
    const { config } = db.setupPostRecordConfig.call(ctx, { record_id: 'rec1', reference: null });
    assert.deepStrictEqual(config.reference, { record_id: null });
});

test('source defaults include can_modify_referencing_records: false', async () => {
    const r = await db.normalizeRecord.call(ctx, baseRecord(), undefined, true, true, true);
    assert.strictEqual(r.source.can_modify_referencing_records, false);
    assert.strictEqual(r.updated_by, undefined);
});

test('prv_acs.can_modify_referencing_records is returned in source', async () => {
    const r = await db.normalizeRecord.call(ctx, baseRecord({ prv_acs: { can_modify_referencing_records: true } }), undefined, true, true, true);
    assert.strictEqual(r.source.can_modify_referencing_records, true);
});

test('prv_acs.upb becomes updated_by and never a source setting', async () => {
    const r = await db.normalizeRecord.call(ctx, baseRecord({ prv_acs: { upb: 'user-a', can_remove_referencing_records: true } }), undefined, true, true, true);
    assert.strictEqual(r.updated_by, 'user-a');
    assert.ok(!('upb' in r.source));
    assert.strictEqual(r.source.can_remove_referencing_records, true);
    assert.strictEqual(r.user_id, 'user-b');
});

test('full ip is kept for the uploader / admins', async () => {
    const r = await db.normalizeRecord.call(ctx, baseRecord({ ip: '203.0.113.5R#my-id' }), undefined, true, true, true);
    assert.strictEqual(r.ip, '203.0.113.5');
    assert.strictEqual(r.readonly, true);
    assert.strictEqual(r.unique_id, 'my-id');
});

test('redacted ip of a signed-in uploader: empty address, flags kept', async () => {
    const cases = [
        ['R#my#id', '', true, 'my#id'],
        ['#my-id', '', false, 'my-id'],
        ['R', '', true, undefined],
        ['', '', false, undefined],
        [null, '', false, undefined]
    ];
    for (const [ip, want, readonly, uid] of cases) {
        const r = await db.normalizeRecord.call(ctx, baseRecord({ ip }), undefined, true, true, true);
        assert.strictEqual(r.ip, want, `ip for ${JSON.stringify(ip)}`);
        assert.strictEqual(r.readonly, readonly, `readonly for ${JSON.stringify(ip)}`);
        assert.strictEqual(r.unique_id, uid, `unique_id for ${JSON.stringify(ip)}`);
        assert.strictEqual(r.user_id, 'user-b');
    }
});

test('redacted ip of an anonymous uploader still reads as anonymous', async () => {
    const r = await db.normalizeRecord.call(ctx, baseRecord({ ip: '0-0-0-0R#anon-id' }), undefined, true, true, true);
    assert.strictEqual(r.ip, '0.0.0.0');
    assert.strictEqual(r.readonly, true);
    assert.strictEqual(r.unique_id, 'anon-id');
    assert.strictEqual(r.user_id, 'anonymous:user-b');
});

(async () => {
    db = await load();
    let failed = 0;
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log(`ok - ${name}`);
        }
        catch (err) {
            failed++;
            console.log(`not ok - ${name}\n  ${err && err.stack || err}`);
        }
    }
    console.log(`${tests.length - failed}/${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})().catch(err => {
    console.error(err);
    process.exit(1);
});

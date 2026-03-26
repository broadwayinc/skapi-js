const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
        ...options
    });

    if (result.status !== 0) {
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
        throw new Error(`${command} ${args.join(' ')} failed\n${output}`.trim());
    }

    return result.stdout.trim();
}

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function assertOutputContains(output, marker, description) {
    if (!output.includes(marker)) {
        throw new Error(`${description} did not print ${marker}\n${output}`);
    }
}

const packOutput = run('npm', ['pack']);
const packageFile = packOutput.split(/\r?\n/).filter(Boolean).pop();

if (!packageFile) {
    throw new Error('npm pack did not return a tarball name');
}

const packagePath = path.join(repoRoot, packageFile);
const consumerRoot = makeTempDir('skapi-node-import-');
const cjsProject = path.join(consumerRoot, 'consumer-cjs');
const esmProject = path.join(consumerRoot, 'consumer-esm');
const tsProject = path.join(consumerRoot, 'consumer-ts');

fs.mkdirSync(cjsProject, { recursive: true });
fs.mkdirSync(esmProject, { recursive: true });
fs.mkdirSync(tsProject, { recursive: true });

writeJson(path.join(cjsProject, 'package.json'), {
    name: 'consumer-cjs',
    private: true
});
writeJson(path.join(esmProject, 'package.json'), {
    name: 'consumer-esm',
    private: true,
    type: 'module'
});
writeJson(path.join(tsProject, 'package.json'), {
    name: 'consumer-ts',
    private: true,
    type: 'module'
});

for (const project of [cjsProject, esmProject, tsProject]) {
    run('npm', ['install', packagePath], { cwd: project });
}

run('npm', ['install', 'typescript@5.9.3'], { cwd: tsProject });

fs.writeFileSync(path.join(cjsProject, 'index.js'), [
    "const { Skapi } = require('skapi-js');",
    "if (typeof Skapi !== 'function') {",
    "  throw new Error('Skapi export is not a function');",
    "}",
    "console.log('CJS_OK');"
].join('\n'));

fs.writeFileSync(path.join(esmProject, 'index.js'), [
    "import { Skapi } from 'skapi-js';",
    "if (typeof Skapi !== 'function') {",
    "  throw new Error('Skapi export is not a function');",
    "}",
    "console.log('ESM_OK');"
].join('\n'));

fs.writeFileSync(path.join(tsProject, 'consumer.ts'), [
    "import { Skapi } from 'skapi-js';",
    "import type { RecordData, DatabaseResponse } from 'skapi-js';",
    '',
    "const sdk = new Skapi('SERVICE_ID');",
    'let record: RecordData | null = null;',
    'let databaseRecords: DatabaseResponse<RecordData> | null = null;',
    '',
    'void sdk;',
    'void record;',
    'void databaseRecords;'
].join('\n'));

fs.writeFileSync(path.join(tsProject, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
        noEmit: true,
        target: 'ES2020',
        module: 'NodeNext',
        moduleResolution: 'NodeNext'
    },
    include: ['consumer.ts']
}, null, 2));

const cjsOutput = run('node', ['index.js'], { cwd: cjsProject });
assertOutputContains(cjsOutput, 'CJS_OK', 'CommonJS import test');

const esmOutput = run('node', ['index.js'], { cwd: esmProject });
assertOutputContains(esmOutput, 'ESM_OK', 'ES module import test');

run('npx', ['tsc', '--project', 'tsconfig.json'], { cwd: tsProject });

console.log('NODE_IMPORT_COMPATIBILITY_OK');

fs.rmSync(consumerRoot, { recursive: true, force: true });
fs.rmSync(packagePath, { force: true });
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'tsup';

const packageJson = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));
// One line instead of the whole LICENSE text (11 KB in every output file). The full
// text ships as LICENSE in the package. "/*!" keeps the notice when an app re-bundles
// the SDK, since bundlers and minifiers preserve those comments.
const banner = `/*! skapi-js v${packageJson.version} | (c) ${new Date().getFullYear()} broadway Inc. | Apache-2.0 | https://www.apache.org/licenses/LICENSE-2.0 */`;
const browserShim = path.resolve(__dirname, 'src/shims/empty-node.ts');
const externalDependencies = ['cocochex', 'qpass'];

export default defineConfig([
    {
        entry: {
            skapi: 'src/Main.ts'
        },
        format: ['esm', 'cjs'],
        dts: {
            compilerOptions: {
                target: 'ES2020',
                module: 'ES2020',
                moduleResolution: 'node',
                experimentalDecorators: true,
                esModuleInterop: true,
                noImplicitAny: false,
                strictNullChecks: false,
                noImplicitThis: false
            }
        },
        sourcemap: true,
        minify: true,
        clean: true,
        splitting: false,
        target: 'es2020',
        outDir: 'dist',
        treeshake: true,
        external: externalDependencies,
        outExtension({ format }) {
            return {
                js: format === 'esm' ? '.mjs' : '.cjs'
            };
        },
        banner: {
            js: banner
        },
        define: {
            __SKAPI_VERSION__: JSON.stringify(packageJson.version)
        },
        esbuildOptions(options) {
            // Maps point at the TS sources instead of embedding them: the embedded copy
            // was about 1 MB per map, most of the npm package.
            options.sourcesContent = false;
        }
    },
    {
        entry: {
            skapi: 'src/browser.ts'
        },
        format: ['esm', 'iife'],
        platform: 'browser',
        globalName: '__SKAPI_BUNDLE__',
        dts: false,
        sourcemap: true,
        minify: true,
        clean: false,
        splitting: false,
        target: 'es2020',
        outDir: 'dist',
        treeshake: true,
        noExternal: externalDependencies,
        outExtension({ format }) {
            return {
                js: format === 'esm' ? '.browser.mjs' : '.js'
            };
        },
        banner: {
            js: banner
        },
        define: {
            __SKAPI_VERSION__: JSON.stringify(packageJson.version),
            global: 'globalThis'
        },
        esbuildOptions(options) {
            options.sourcesContent = false;
            options.alias = {
                ...(options.alias || {}),
                fs: browserShim,
                path: browserShim,
                // src/utils/crypto.ts lazily require()s node:crypto as a fallback
                // for runtimes where globalThis.crypto.subtle is missing. A browser
                // always has the global, so alias the fallback away rather than
                // shipping a bare require() into a <script> bundle.
                crypto: browserShim,
                'node:crypto': browserShim
            };
        }
    }
]);
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'tsup';

const license = readFileSync(path.resolve(__dirname, 'LICENSE'), 'utf8').replace('[xxxx]', String(new Date().getFullYear()));
const packageJson = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));
const banner = `/**\n * @license\n${license}\n */`;
const browserShim = path.resolve(__dirname, 'src/shims/empty-node.ts');
const externalDependencies = ['amazon-cognito-identity-js', 'cocochex', 'qpass'];
const sharedTsCompilerOptions = {
    target: 'ES2020',
    module: 'ES2020',
    moduleResolution: 'node',
    experimentalDecorators: true,
    esModuleInterop: true,
    strict: true,
    noImplicitAny: false,
    strictNullChecks: false,
    noImplicitThis: false,
    skipLibCheck: true
};

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
            options.tsconfigRaw = {
                compilerOptions: sharedTsCompilerOptions
            };
        }
    },
    {
        entry: {
            skapi: 'src/browser.ts'
        },
        format: ['iife'],
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
        outExtension() {
            return {
                js: '.js'
            };
        },
        banner: {
            js: banner
        },
        define: {
            __SKAPI_VERSION__: JSON.stringify(packageJson.version)
        },
        esbuildOptions(options) {
            options.tsconfigRaw = {
                compilerOptions: sharedTsCompilerOptions
            };
            options.alias = {
                ...(options.alias || {}),
                fs: browserShim,
                path: browserShim
            };
        }
    }
]);
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'tsup';

const license = readFileSync(path.resolve(__dirname, 'LICENSE'), 'utf8').replace('[xxxx]', String(new Date().getFullYear()));
const banner = `/**\n * @license\n${license}\n */`;
const browserShim = path.resolve(__dirname, 'src/shims/empty-node.ts');
const externalDependencies = ['amazon-cognito-identity-js', 'cocochex', 'qpass'];

export default defineConfig([
    {
        entry: {
            skapi: 'src/Main.ts'
        },
        format: ['esm', 'cjs'],
        dts: true,
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
        esbuildOptions(options) {
            options.alias = {
                ...(options.alias || {}),
                fs: browserShim,
                path: browserShim
            };
        }
    }
]);
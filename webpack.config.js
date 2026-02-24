const path = require('path');
const fs = require('fs');
const { BannerPlugin } = require('webpack');
const BundleAnalyzerPlugin = require('webpack-bundle-analyzer').BundleAnalyzerPlugin;
// Read the LICENSE file
const license = fs.readFileSync(path.resolve(__dirname, 'LICENSE'), 'utf8').replace('[xxxx]', new Date().getFullYear());

module.exports = [
    {
        // cdn
        mode: 'production',
        target: 'web',
        entry: './src/Main.ts',
        output: {
            filename: 'skapi.js',
            libraryTarget: 'umd'
        },
        module: {
            rules: [
                {
                    test: /\.tsx?$/,
                    use: 'ts-loader',
                    exclude: /node_modules/,
                },
            ],
        },
        resolve: {
            extensions: ['.tsx', '.ts', '.js'],
        },
        devtool: 'source-map',
        plugins: [
            new BundleAnalyzerPlugin({
                analyzerMode: 'static',
                reportFilename: 'bundle-report.html',
                openAnalyzer: false,
                excludeAssets: [/node_modules/]
            }),
            new BannerPlugin({
                banner: `
/**
 * @license
${license}
 */
                `.trim(),
                raw: true
            })
        ],
    },
    {
        // ESM build
        mode: 'production',
        target: ['web', 'es2020'],
        entry: './src/Main.ts',
        experiments: {
            outputModule: true
        },
        output: {
            filename: 'skapi.mjs',
            library: {
                type: 'module'
            },
            module: true
        },
        module: {
            rules: [
                {
                    test: /\.tsx?$/,
                    use: 'ts-loader',
                    exclude: /node_modules/,
                },
            ],
        },
        resolve: {
            extensions: ['.tsx', '.ts', '.js'],
        },
        devtool: 'source-map',
        plugins: [
            new BundleAnalyzerPlugin({
                analyzerMode: 'static',
                reportFilename: 'bundle-report-esm.html',
                openAnalyzer: false,
                excludeAssets: [/node_modules/]
            }),
            new BannerPlugin({
                banner: `
/**
 * @license
${license}
 */
                `.trim(),
                raw: true
            })
        ],
    },
    {
        // CommonJS build
        mode: 'production',
        target: 'node',
        entry: './src/Main.ts',
        output: {
            filename: 'skapi.cjs',
            libraryTarget: 'commonjs2'
        },
        module: {
            rules: [
                {
                    test: /\.tsx?$/,
                    use: 'ts-loader',
                    exclude: /node_modules/,
                },
            ],
        },
        resolve: {
            extensions: ['.tsx', '.ts', '.js'],
        },
        devtool: 'source-map',
        plugins: [
            new BundleAnalyzerPlugin({
                analyzerMode: 'static',
                reportFilename: 'bundle-report-commonjs.html',
                openAnalyzer: false,
                excludeAssets: [/node_modules/]
            }),
            new BannerPlugin({
                banner: `
/**
 * @license
${license}
 */
                `.trim(),
                raw: true
            })
        ],
    },
    {
        // Node ESM build
        mode: 'production',
        target: 'node',
        entry: './src/Main.ts',
        experiments: {
            outputModule: true
        },
        output: {
            filename: 'skapi.node.mjs',
            library: {
                type: 'module'
            },
            module: true
        },
        module: {
            rules: [
                {
                    test: /\.tsx?$/,
                    use: 'ts-loader',
                    exclude: /node_modules/,
                },
            ],
        },
        resolve: {
            extensions: ['.tsx', '.ts', '.js'],
        },
        devtool: 'source-map',
        plugins: [
            new BundleAnalyzerPlugin({
                analyzerMode: 'static',
                reportFilename: 'bundle-report-node-esm.html',
                openAnalyzer: false,
                excludeAssets: [/node_modules/]
            }),
            new BannerPlugin({
                banner: `
/**
 * @license
${license}
 */
                `.trim(),
                raw: true
            })
        ],
    }
];
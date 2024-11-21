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
//     {
//         // webpack
//         mode: 'production',
//         target: 'web',
//         entry: './src/Main.ts',
//         output: {
//             filename: 'skapi.mjs',
//             libraryTarget: 'module'
//         },
//         module: {
//             rules: [
//                 {
//                     test: /\.tsx?$/,
//                     use: 'ts-loader',
//                     exclude: /node_modules/,
//                 },
//             ],
//         },
//         resolve: {
//             extensions: ['.tsx', '.ts', '.js'],
//         },
//         experiments: {
//             outputModule: true
//         },
//         devtool: 'source-map',
//         plugins: [
//             new BundleAnalyzerPlugin({
//                 analyzerMode: 'static',
//                 reportFilename: 'bundle-report-module.html',
//                 openAnalyzer: false,
//                 excludeAssets: [/node_modules/]
//             }),
//             new BannerPlugin({
//                 banner: `
// /**
//  * @license
// ${license}
//  */
//                 `.trim(),
//                 raw: true
//             })
//         ],
//     }
];
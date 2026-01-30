const path = require('path');
const fs = require('fs');
const { BannerPlugin } = require('webpack');
const BundleAnalyzerPlugin = require('webpack-bundle-analyzer').BundleAnalyzerPlugin;

// Read the LICENSE file
const license = fs.readFileSync(path.resolve(__dirname, 'LICENSE'), 'utf8').replace('[xxxx]', new Date().getFullYear());

module.exports = {
    // Node.js CommonJS build
    mode: 'production',
    target: 'node',
    entry: './src/Main.ts',
    output: {
        filename: 'skapi.cjs',
        path: path.resolve(__dirname, 'dist'),
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
        alias: {
            // Point platform/runtime to node.ts directly
            '../platform/runtime': path.resolve(__dirname, 'src/platform/node.ts'),
        }
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
};

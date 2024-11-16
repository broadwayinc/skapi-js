const path = require('path');
const BundleAnalyzerPlugin = require('webpack-bundle-analyzer').BundleAnalyzerPlugin;
module.exports = [
    {
        // cdn
        mode: 'production',
        target: 'web',
        entry: './js/Main.js',
        output: {
            filename: 'skapi.js',
            libraryTarget: 'umd'
        },
        devtool: 'source-map',
        plugins: [
            new BundleAnalyzerPlugin({
                analyzerMode: 'static',
                reportFilename: 'bundle-report.html',
                openAnalyzer: false,
                excludeAssets: [/node_modules/]
              })
        ],
    },
    {
        // webpack
        mode: 'production',
        target: 'web',
        // entry: './js/Main.js',
        entry: './src/Main.ts',
        output: {
            filename: 'skapi.module.js',
            libraryTarget: 'module'
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
        experiments: {
            outputModule: true
        },
        devtool: 'source-map',
        plugins: [
            new BundleAnalyzerPlugin({
                analyzerMode: 'static',
                reportFilename: 'bundle-report-module.html',
                openAnalyzer: false,
                excludeAssets: [/node_modules/]
              })
        ],
    }
];

// module.exports = 
//     {
//         // cdn
//         mode: 'production',
//         target: 'web',
//         entry: './js/Main.js',
//         output: {
//             filename: 'skapi.js',
//             libraryTarget: 'umd'
//         },
//         devtool: 'source-map',
//         plugins: [
//             new BundleAnalyzerPlugin({
//                 analyzerMode: 'static',
//                 reportFilename: 'bundle-report.html',
//                 openAnalyzer: false,
//                 excludeAssets: [/node_modules/]
//               })
//         ],
//     }
//     // {
//     //     // webpack
//     //     mode: 'production',
//     //     target: 'web',
//     //     // entry: './js/Main.js',
//     //     entry: './src/Main.ts',
//     //     output: {
//     //         filename: 'skapi.module.js',
//     //         libraryTarget: 'module'
//     //     },
//     //     module: {
//     //         rules: [
//     //             {
//     //                 test: /\.tsx?$/,
//     //                 use: 'ts-loader',
//     //                 exclude: /node_modules/,
//     //             },
//     //         ],
//     //     },
//     //     resolve: {
//     //         extensions: ['.tsx', '.ts', '.js'],
//     //     },
//     //     experiments: {
//     //         outputModule: true
//     //     },
//     //     devtool: 'source-map',
//     //     plugins: [
//     //         new BundleAnalyzerPlugin({
//     //             analyzerMode: 'static',
//     //             reportFilename: 'bundle-report.html',
//     //             openAnalyzer: false,
//     //             excludeAssets: [/node_modules/]
//     //           })
//     //     ],
//     // };
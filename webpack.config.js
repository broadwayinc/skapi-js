const path = require('path');
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
        devtool: 'source-map'
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
        devtool: 'source-map'
    }
];
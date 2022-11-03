const path = require('path');
module.exports = {
    mode: 'production',
    target: 'web',
    // target: 'node',
    // externals: [nodeExternals()], // removes node_modules from your final bundle
    entry: './js/Api.js',
    output: {
        // path: path.join(__dirname, 'bundle'),
        filename: 'skapi.js',
        libraryTarget: 'umd'
        // libraryTarget: 'module'
    },
    // experiments: {
    //     outputModule: true
    // },
    // optimization: {
    //     minimize: true
    // },
    devtool: 'source-map'
};
const path = require('path');
module.exports = [{
    // cdn
    mode: 'production',
    target: 'web',
    entry: './js/Api.js',
    output: {
        filename: 'skapi.js',
        libraryTarget: 'umd'
    },
    devtool: 'source-map'
}, {
    // webpack
    mode: 'production',
    target: 'web',
    entry: './js/Api.js',
    output: {
        filename: 'skapi.module.js',
        libraryTarget: 'module'
    },
    experiments: {
        outputModule: true
    },
    devtool: 'source-map'
}];
const path = require('path');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
    const isDev = argv.mode === 'development';

    return {
        entry: {
            // Content script bundle — injected into youtube.com/watch pages
            'content-script': './src/content-script/inject.ts',
            // Background service worker
            'background/service-worker': './src/background/service-worker.ts',
            // Library page script
            'library/notes-library': './src/library/notes-library.ts',
        },
        output: {
            path: path.resolve(__dirname, 'dist'),
            filename: '[name].js',
            clean: true,
        },
        resolve: {
            extensions: ['.ts', '.tsx', '.js'],
            alias: {
                // Tiptap ships ESM — ensure we get a single copy
                '@tiptap/core': path.resolve(__dirname, 'node_modules/@tiptap/core'),
            },
        },
        module: {
            rules: [
                {
                    test: /\.tsx?$/,
                    use: 'ts-loader',
                    exclude: /node_modules/,
                },
                {
                    // CSS is extracted to a separate file so the content script can
                    // inject it via chrome.scripting.insertCSS or a <link> tag,
                    // keeping it out of the JS bundle to avoid FOUC.
                    test: /\.css$/,
                    use: [MiniCssExtractPlugin.loader, 'css-loader'],
                },
            ],
        },
        plugins: [
            new MiniCssExtractPlugin({
                filename: 'styles/[name].css',
            }),
            new CopyWebpackPlugin({
                patterns: [
                    { from: 'manifest.json', to: '.' },
                    { from: 'src/library/notes-library.html', to: 'library/' },
                    { from: 'src/styles', to: 'styles' },
                    // Icons (provide your own PNGs in public/icons/)
                    {
                        from: 'public',
                        to: '.',
                        noErrorOnMissing: true,
                    },
                ],
            }),
        ],
        optimization: {
            // Do NOT split chunks — Chrome extensions load files individually,
            // not via a module loader that handles async imports.
            splitChunks: false,
        },
        devtool: isDev ? 'inline-source-map' : false,
    };
};

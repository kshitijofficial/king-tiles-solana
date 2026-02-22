const webpack = require('webpack');

module.exports = {
  webpack: {
    configure: (webpackConfig) => {
      webpackConfig.resolve.fallback = {
        ...webpackConfig.resolve.fallback,
        vm: require.resolve('vm-browserify'),
        buffer: require.resolve('buffer'),
        crypto: require.resolve('crypto-browserify'),
        stream: require.resolve('stream-browserify'),
        process: require.resolve('process/browser.js'),
        http: require.resolve('stream-http'),
        https: require.resolve('https-browserify'),
        os: false,
        path: false,
        fs: false,
        zlib: false,
      };

      webpackConfig.plugins = [
        ...webpackConfig.plugins,
        new webpack.ProvidePlugin({
          Buffer: ['buffer', 'Buffer'],
          process: 'process/browser.js',
        }),
      ];

      // Allow react-refresh from node_modules (fixes WSL / path resolution errors)
      if (webpackConfig.resolve.plugins) {
        webpackConfig.resolve.plugins = webpackConfig.resolve.plugins.filter(
          (p) => p.constructor?.name !== 'ModuleScopePlugin'
        );
      }

      return webpackConfig;
    },
  },
};

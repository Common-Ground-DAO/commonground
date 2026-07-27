const webpack = require("webpack");
const path = require('path');
const BundleAnalyzerPlugin = require('webpack-bundle-analyzer').BundleAnalyzerPlugin;
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  style: {
    postcss: {
      loaderOptions: (postcssLoaderOptions) => {
        postcssLoaderOptions.postcssOptions.plugins = [
          require('tailwindcss/nesting'),
          require('tailwindcss'),
          require('autoprefixer')
        ];
        
        return postcssLoaderOptions
      },
    },
  },
  webpack: {
    configure: (webpackConfig, { env, paths }) => {
      webpackConfig.resolve.fallback = {
        ...webpackConfig.resolve.fallback,
        "fs": false,
        "tls": false,
        "net": false,
        "path": false,
        "zlib": false,
        "http": false,
        "https": false,
        "stream": false,
        "crypto": false,
        "url": false,
        "os": false,
        "crypto-browserify": false,
        stream: require.resolve("stream-browserify"),
        buffer: require.resolve("buffer"),
        assert: require.resolve("assert")
      };
      // Load the ALTCHA web component bundle under a stub module name so its
      // type declarations never enter the TS program: altcha's d.ts augments
      // react/jsx-runtime with a JSX namespace, which with @types/react 18.0.x
      // shadows the real one and breaks JSX children inference project-wide.
      webpackConfig.resolve.alias = {
        ...webpackConfig.resolve.alias,
        "altcha-widget-element$": "altcha",
      };
      webpackConfig.plugins.push(
        new webpack.ProvidePlugin({
          Buffer: ["buffer", "Buffer"]
        }),
        /* new BundleAnalyzerPlugin({
          analyzerMode: 'disabled',
          generateStatsFile: true,
          statsFilename: '../tools/buildStats.json',
          openAnalyzer: false
        }), */
        /*new webpack.optimize.LimitChunkCountPlugin({
          maxChunks: 25,
        }),*/
      );

      // Add HtmlWebpackPlugin for the new entry point
      webpackConfig.plugins.push(
        new HtmlWebpackPlugin({
          inject: true,
          template: path.resolve(__dirname, 'public', 'index_cgid.html'),
          minify: {
            removeComments: true,
            collapseWhitespace: true,
            removeRedundantAttributes: true,
            useShortDoctype: true,
            removeEmptyAttributes: true,
            removeStyleLinkTypeAttributes: true,
            keepClosingSlash: true,
            minifyJS: true,
            minifyCSS: true,
            minifyURLs: true
          },
          filename: 'index_cgid.html',
          chunks: ['index_cgid'],
        }),
      );
      
      webpackConfig.entry = {
        'main': path.resolve(__dirname, 'src', 'index.tsx'),
        'index_cgid': path.resolve(__dirname, 'src', 'index_cgid.tsx'),
      };

      webpackConfig.output.filename = 'static/js/[name].[fullhash:8].js';

      return webpackConfig;
    }
  },
  plugins: [{
    plugin: {
      overrideWebpackConfig: ({ webpackConfig, context: { env, paths } }) => {
        try {
          let foundInjectManifest = false;
          webpackConfig.plugins.forEach((plugin) => {
            if (plugin.constructor.name === "InjectManifest") {
              // add rule to ignore static svg files
              foundInjectManifest = true;
              plugin.config.exclude = [
                ({ asset }) => {
                  if (asset?.name?.endsWith('index_cgid.html')) {
                    return true;
                  }
                  if (!asset?.name?.match?.(/static\/media\/.+\.svg$/)) {
                    return false;
                  }
                  const _source = asset?.source?._source;
                  if (
                    _source?._valueIsBuffer === true &&
                    _source?._value instanceof Buffer &&
                    _source._value.length < 5000
                  ) {
                    return true;
                  }
                  return false;
                },
                ...(plugin.config.exclude || [])
              ];
            }
          });
          if (!foundInjectManifest && process.env.DEPLOYMENT !== "dev") {
            throw new Error("<InjectManifest> Plugin is missing, but required for CG service worker build");
          }
        } catch (error) {
          console.log("\x1b[31m%s\x1b[0m", `[craco-workbox]`);
          console.log("\x1b[31m%s\x1b[0m", error.stack);
          process.exit(1);
        }
    
        // Always return the config object.
        return webpackConfig;
      },
    }
  }]
}
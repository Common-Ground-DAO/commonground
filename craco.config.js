const webpack = require("webpack");
const path = require('path');
const BundleAnalyzerPlugin = require('webpack-bundle-analyzer').BundleAnalyzerPlugin;
const HtmlWebpackPlugin = require('html-webpack-plugin');

// Mirrors react-scripts' own @svgr/webpack options
// (node_modules/react-scripts/config/webpack.config.js:392-401) — `svgo: false`
// matters: svgr's default svgo pass strips `viewBox`.
const SVGR_OPTIONS = {
  prettier: false,
  svgo: false,
  svgoConfig: {
    plugins: [{ removeViewBox: false }],
  },
  titleProp: true,
  ref: true,
};

module.exports = {
  // Both HTML entry templates moved out of `public/` for the Vite migration
  // (Vite's publicDir cannot hold HTML entries). react-scripts hardcodes
  // `public/index.html` via paths.appHtml — repoint it at the new location so
  // the CRA build keeps working in parallel until the Phase-3 cutover.
  paths: (paths) => {
    paths.appHtml = path.resolve(__dirname, 'index.html');
    return paths;
  },
  style: {
    css: {
      // `src/index.css` now loads the Inter fonts through server-relative
      // `/fonts/*.ttf` URLs (they used to reach into `../public/`, which Vite
      // cannot do). Vite leaves server-relative `url()`s untouched; webpack's
      // css-loader tries to resolve them through `resolve.roots` and fails, so
      // opt them out here and let the web server serve `public/fonts/`.
      // Side effect (intended, §5.4): the fonts are no longer *also* emitted
      // hashed into `static/media/` — they ship once, at the URL the service
      // worker precaches.
      loaderOptions: (cssLoaderOptions) => {
        cssLoaderOptions.url = { filter: (url) => !url.startsWith('/') };
        return cssLoaderOptions;
      },
    },
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
      // `import X from './foo.svg?react'` — the Vite/svgr form the source tree
      // was codemodded to. react-scripts' own `.svg` rule chains
      // @svgr/webpack + file-loader, which makes the *default* export the URL
      // and the component a named `ReactComponent` export; running svgr alone
      // for the `?react` query restores "default export = component" so both
      // build stacks agree. Additive, and dies with craco.config.js in Phase 3.
      const oneOfRules = webpackConfig.module.rules.find((rule) => Array.isArray(rule.oneOf));
      if (!oneOfRules) {
        throw new Error("Could not find the react-scripts `oneOf` rule list to register the SVG `?react` loader");
      }
      oneOfRules.oneOf.unshift({
        test: /\.svg$/,
        resourceQuery: /^\?react$/,
        issuer: {
          and: [/\.(ts|tsx|js|jsx|md|mdx)$/],
        },
        use: [
          {
            loader: require.resolve("@svgr/webpack"),
            options: SVGR_OPTIONS,
          },
        ],
      });

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
          template: path.resolve(__dirname, 'index_cgid.html'),
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
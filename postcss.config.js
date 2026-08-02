// NOTE: craco currently overrides this chain — `craco.config.js` (style.postcss)
// replaces the plugin array wholesale, so this file is not read by the CRA build.
// It IS read by other PostCSS consumers (and will be read by Vite after the
// build-stack cutover), so both must stay in sync until CRA/craco is removed.
module.exports = {
  plugins: {
    'tailwindcss/nesting': {},
    tailwindcss: {},
    autoprefixer: {},
  },
}

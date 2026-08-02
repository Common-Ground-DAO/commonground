// NOTE: craco currently overrides this chain — `craco.config.js` (style.postcss)
// replaces the plugin array wholesale, so nothing reads this file today. Vite will
// read it after the build-stack cutover, so it must stay in sync with the craco
// chain until CRA/craco is removed.
module.exports = {
  plugins: {
    'tailwindcss/nesting': {},
    tailwindcss: {},
    autoprefixer: {},
  },
}

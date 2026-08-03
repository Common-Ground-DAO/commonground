// The single source of truth for the PostCSS chain. Vite reads this file
// automatically. Until the CRA removal, `craco.config.js` (style.postcss)
// replaced the plugin array wholesale and nothing read this file at all — the
// two had drifted apart (a dead `postcss-import` here), which is why Phase 1
// reconciled them before Vite started reading it.
module.exports = {
  plugins: {
    'tailwindcss/nesting': {},
    tailwindcss: {},
    autoprefixer: {},
  },
}

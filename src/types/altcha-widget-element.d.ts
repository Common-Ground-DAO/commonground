// Stub for the resolve alias "altcha-widget-element" -> altcha's built bundle
// (see the `resolve.alias` entry in vite.config.ts). The real package's types
// must stay OUT of the TS program: its `declare module 'react/jsx-runtime'`
// JSX augmentation shadows the entire JSX namespace under @types/react 18.0.x
// and breaks children inference in every component. (altcha 3 moved that
// augmentation out of the default types entry into `altcha/types/react`, so
// the hazard is narrower now — but the alias is what keeps it out for good.)
// The import is side-effect only (registers the <altcha-widget> custom
// element), so no types are needed; the widget is created via
// React.createElement('altcha-widget', ...).
declare module 'altcha-widget-element';

// Stub for the webpack alias "altcha-widget-element" -> altcha's built bundle
// (see craco.config.js). The real package's altcha.d.ts must stay OUT of the
// TS program: its `declare module 'react/jsx-runtime'` JSX augmentation
// shadows the entire JSX namespace under @types/react 18.0.x / TS 4.5 and
// breaks children inference in every component. The import is side-effect
// only (registers the <altcha-widget> custom element), so no types are needed;
// the widget is created via React.createElement('altcha-widget', ...).
declare module 'altcha-widget-element';

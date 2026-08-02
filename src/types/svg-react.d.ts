// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

// `import Icon from './icon.svg?react'` — the SVGR component form used by both
// build stacks (vite-plugin-svgr under Vite, an additive @svgr/webpack rule
// under CRA/craco, see craco.config.js).
//
// This intentionally does NOT come from `vite/client`: that module redeclares
// the whole `*.svg` / `*.png` / `*.css` ambient wildcard set, which collides
// with the react-scripts ambient types still referenced by
// `src/react-app-env.d.ts` (duplicate identifiers). `vite/client` replaces
// react-app-env.d.ts in Phase 3, when CRA is removed.
declare module '*.svg?react' {
  import * as React from 'react';
  const ReactComponent: React.FunctionComponent<
    React.SVGProps<SVGSVGElement> & { title?: string }
  >;
  export default ReactComponent;
}

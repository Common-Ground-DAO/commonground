// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

// `import Icon from './icon.svg?react'` — the SVGR component form used by both
// build stacks (vite-plugin-svgr under Vite, an additive @svgr/webpack rule
// under CRA/craco, see craco.config.js).
//
// `vite/client` does not cover this form — it comes from
// vite-plugin-svgr's own client types, which cannot be referenced without also
// pulling in the plugin's Vite-6 type surface. Declaring it here keeps the
// declaration readable and independent of the plugin version.
//
// `vite/client` itself *is* in the tsconfig `types` array and covers the plain
// `*.svg` / `*.png` / `*.css` wildcards that used to come from react-scripts
// via `src/react-app-env.d.ts` (deleted with CRA).
declare module '*.svg?react' {
  import * as React from 'react';
  const ReactComponent: React.FunctionComponent<
    React.SVGProps<SVGSVGElement> & { title?: string }
  >;
  export default ReactComponent;
}

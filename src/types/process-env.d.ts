// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

// The last remnant of the ambient typing that came from react-scripts via
// `src/react-app-env.d.ts` (deleted with CRA).
//
// `src/service-worker.ts:181` reads `process.env.PUBLIC_URL`, which
// `vite/serviceWorker.ts` substitutes with a `define` at build time — the same
// thing CRA's DefinePlugin did. It is the only bare `process.env` access left
// in `src/`: `src/common/config.ts` reaches its env through a
// `const that: any = globalThis` indirection on purpose, because that file also
// runs in Node (the `srv/common` symlink), and must never be statically
// substituted.
//
// Pulling in `@types/node` instead would drop the whole Node global surface
// into a browser program, which is exactly what the explicit `types` array in
// tsconfig.json exists to prevent.
declare const process: {
  env: {
    PUBLIC_URL: string;
  };
};

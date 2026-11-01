// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

// Placeholder for the Vite dev server and for builds served without the Caddy
// edge. Behind Caddy, /instance-config.js is rendered per instance from
// docker/caddy/instance-config.js and declares window.__CG_INSTANCE__
// (src/common/instance.ts); without it the app falls back to its built-in
// detection.

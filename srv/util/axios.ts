// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import axios from 'axios';
import http from 'http';
import https from 'https';

// Workaround for the Node >=19 default `keepAlive: true` agents: a socket the
// server has already FIN'd stays in the pool and the next request on it fails
// with ECONNRESET / "socket hang up".
// Sources:
// https://github.com/axios/axios/issues/5929 due to https://github.com/nodejs/node/issues/47130
//
// Re-checked 2026-08-04 on Node 24 + axios 1.19.0 — still needed:
// - nodejs/node#47130 was closed *as not planned* (2024-07-22), labelled "known
//   limitation"; nodejs/node#55170 (in 20.18.0) only narrowed the race window.
// - axios/axios#6113 collects reports on Node 22.12 with axios 1.9; the axios
//   maintainer's own advice there (2025-08-27) is exactly this `keepAlive: false`
//   agent pair. The axios 1.7→1.19 changelog contains no fix for it (only
//   keep-alive *listener leak* fixes, #10788/#10576).
// - The upstream alternative is dropping the http adapter for undici/fetch,
//   which is a bigger change than this workstream covers.
// Drop this only once Node itself changes the pooling behaviour, or once the
// backend moves to axios' fetch adapter.
const ax = axios.create({
    httpAgent: new http.Agent({ keepAlive: false }),
    httpsAgent: new https.Agent({ keepAlive: false }),
});
export default ax;
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import app from './util/express';
import { listenerProbe, postgresProbe, startHealthcheck } from './healthcheck';
import { valkeyProbe } from './redis/healthProbe';
import pool from './util/postgres';
import imageFilter from './moderation/imageFilter';
import { apiErrorHandler } from './api/util';
import { mountApiRouters } from './api/mountRouters';
import { validateTransferConfigAtStartup } from './util/transferLink';
import { validateGatewayConfig } from './util/gateway';

// A misconfigured transfer-link target (TRANSFER_TARGET_URL) stops the process.
validateTransferConfigAtStartup();
// A gateway (CG_GATEWAY=true) needs legacy CG ID mode and a transfer target;
// what it serves is decided by its allowlist (srv/util/express.ts).
validateGatewayConfig({ needsTransferTarget: true });

// every router and page route (srv/api/mountRouters.ts); the account-security
// step runs in front of the API routers
mountApiRouters(app);

// Errors handed to next() by middleware — e.g. the session store failing while
// the Valkey state instance is unreachable, or body-parser rejecting a
// malformed/oversized body — get the API's JSON error format instead of
// Express' default HTML error page. Keeps a 4xx status set by the middleware.
app.use(apiErrorHandler);

const shutdown = async (code = 0) => {
  process.exit(code);
}

// healthy: the database and the Valkey state instance (sessions) answer, and
// the HTTP listener (util/express.ts) accepts connections
startHealthcheck([postgresProbe(pool), valkeyProbe(), listenerProbe(4000)]);

// Fire-and-forget: reports a broken NSFW model in the startup log rather than
// letting it surface as failing uploads later (it never rejects, and every
// upload path waits on the same cached load anyway).
void imageFilter.warmUp();

process.on("SIGTERM", () => shutdown());
process.on("unhandledRejection", (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  shutdown(1);
});
process.on("uncaughtException", (error, origin) => {
  console.error('Uncaught Exception at:', error, 'origin:', origin);
  shutdown(1);
});

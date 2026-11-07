// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type express from "express";
import errors from "../common/errors";
import { dockerSecret } from ".";
import { sharedMailLimitSecret } from "./sessionSecret";

/**
 * Gateway mode (docs/auth-identity §12): a second instance of the same code on
 * the same database and Valkey — during the move the old domain
 * (app.cg / id.app.cg) runs it next to the new instance (cg.box). People sign
 * in there exactly as before and get a one-time transfer link to the new
 * instance; nothing else is served.
 *
 * - `CG_GATEWAY=true` on every gateway process (api, wsapi). The gateway runs
 *   in legacy CG ID mode (`CG_LEGACY_CGID=true`), which keeps the full old
 *   sign-up and sign-in surface: what a gateway serves is decided only by the
 *   allowlists below, enforced by the api (GATEWAY_API_ALLOWLIST, in front of
 *   every router and the session) and the wsapi (GATEWAY_SOCKET_EVENTS, in
 *   front of every event handler; token handshakes are refused).
 * - The gateway's sessions, session index, session generations, revocations
 *   and Socket.IO channels live under their own key prefix
 *   (instanceKeyPrefix), and it signs its cookies with its own secret: a
 *   session or cookie of one instance is unknown to the other.
 * - Singleton processes (job-runner, onchain, memberlist, the call server,
 *   migrate-db) belong to the main instance only and refuse to start in
 *   gateway mode (refuseInGatewayMode).
 */

export function isGatewayMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CG_GATEWAY === "true";
}

/** prefix of the gateway's own Valkey keys and Socket.IO channels */
export const GATEWAY_KEY_PREFIX = "gateway:";

/**
 * Prefix for every per-instance key in the shared Valkey state instance:
 * sessions (`sess:`), revoked session ids (`sess-revoked:`), the index of each
 * user's sessions (`sess-user:`), the copies of the session generations
 * (`sess-gen:`, `sess-keep:`, `sess-gen-copied`) and the Socket.IO adapter
 * and emitter channels (`v2:`). Empty on the main instance (its keys keep
 * their names), `gateway:` on a gateway.
 */
export function instanceKeyPrefix(env: NodeJS.ProcessEnv = process.env): string {
  return isGatewayMode(env) ? GATEWAY_KEY_PREFIX : "";
}

/** the Socket.IO redis adapter / emitter key of this instance */
export function socketIoKey(env: NodeJS.ProcessEnv = process.env): string {
  return `${instanceKeyPrefix(env)}v2:`;
}

/** `host` is `domain` itself or one of its subdomains (case-insensitive, a trailing dot ignored) */
function isSameOrSubdomain(host: string, domain: string): boolean {
  const normalize = (name: string) => name.toLowerCase().replace(/\.$/, "");
  const h = normalize(host);
  const d = normalize(domain);
  return !!d && (h === d || h.endsWith(`.${d}`));
}

/** host of an http(s) URL, or undefined when it does not parse */
function urlHost(value: string | undefined): string | undefined {
  try {
    return value?.trim() ? new URL(value.trim()).hostname : undefined;
  }
  catch {
    return undefined;
  }
}

/**
 * Every startup check of a gateway process: it never runs with
 * DEPLOYMENT=dev, it must run in legacy CG ID mode (the passkeys of the old
 * origin), and the api must know where its transfer links lead — an instance
 * that does not lie on or under the gateway's own domain (it would share the
 * old domain's cookies, `connect.sid` included) — and the mail-limit secret
 * it shares with that instance (read like the mail limits read it,
 * sharedMailLimitSecret). Outside dev, the other way round: a process with
 * the gateway's settings (CG_LEGACY_CGID=true, TRANSFER_TARGET_URL) must be
 * a gateway. Throws with a descriptive message.
 */
export function validateGatewayConfig(
  options: { needsTransferTarget: boolean },
  env: NodeJS.ProcessEnv = process.env,
  readDockerSecret: (name: string) => string | false | undefined = dockerSecret,
): void {
  const dev = env.DEPLOYMENT === "dev";
  if (!isGatewayMode(env)) {
    if (env.CG_GATEWAY !== undefined && env.CG_GATEWAY !== "" && env.CG_GATEWAY !== "false") {
      throw new Error(`CG_GATEWAY must be "true" or "false", got "${env.CG_GATEWAY}"`);
    }
    // Legacy CG ID mode keeps the whole old sign-up and sign-in surface; only
    // the gateway's allowlists restrict it. A process with the gateway's
    // settings but without CG_GATEWAY=true would be a full instance on the old
    // domain (on the main instance's Valkey keys and Socket.IO channels).
    if (!dev && env.CG_LEGACY_CGID === "true") {
      throw new Error("CG_LEGACY_CGID=true is for a gateway only and needs CG_GATEWAY=true (outside dev)");
    }
    if (!dev && env.TRANSFER_TARGET_URL?.trim()) {
      throw new Error("TRANSFER_TARGET_URL is for a gateway only and needs CG_GATEWAY=true (outside dev)");
    }
    return;
  }
  if (dev) {
    // a dev stack turns off login throttles, accepts http transfer targets
    // and local origins: nothing a gateway that takes real sign-ins may do
    throw new Error("CG_GATEWAY=true does not run with DEPLOYMENT=dev");
  }
  if (env.CG_LEGACY_CGID !== "true") {
    throw new Error("CG_GATEWAY=true needs CG_LEGACY_CGID=true (the gateway serves the old sign-in methods)");
  }
  if (options.needsTransferTarget && !env.TRANSFER_TARGET_URL?.trim()) {
    throw new Error("CG_GATEWAY=true needs TRANSFER_TARGET_URL (the instance the transfer links lead to)");
  }
  if (options.needsTransferTarget) {
    const targetHost = urlHost(env.TRANSFER_TARGET_URL);
    const gatewayHost = urlHost(env.BASE_URL);
    if (targetHost && gatewayHost && isSameOrSubdomain(targetHost, gatewayHost)) {
      throw new Error(`CG_GATEWAY=true: TRANSFER_TARGET_URL (${targetHost}) must not be the gateway's domain or lie under it (${gatewayHost}): it would share the old domain's cookies`);
    }
  }
  if (options.needsTransferTarget && !sharedMailLimitSecret(env, readDockerSecret)) {
    // without it the per-address mail limits would be counted apart from the
    // instance's (they are keyed with the session secret otherwise)
    throw new Error("CG_GATEWAY=true needs CG_MAIL_LIMIT_SECRET (shared with the instance it leads to)");
  }
}

/**
 * For processes that run only once, for the main instance: exits with an
 * error in gateway mode instead of running a second copy against the shared
 * database.
 */
export function refuseInGatewayMode(processName: string, env: NodeJS.ProcessEnv = process.env): void {
  if (isGatewayMode(env)) {
    console.error(`${processName} runs only for the main instance, never with CG_GATEWAY=true: exiting`);
    process.exit(1);
  }
}

// --- api -------------------------------------------------------------------

type AllowedRoute = {
  method: "GET" | "POST";
  /** as mounted in srv/api.ts (the edge strips /api/v2) */
  path: string;
  /** what the gateway needs it for */
  purpose: string;
};

/**
 * Everything a gateway api serves. Sign-in with every old method (but no
 * sign-up), the session, and transfer links; no data of any kind.
 */
export const GATEWAY_API_ALLOWLIST: readonly AllowedRoute[] = Object.freeze([
  // the session
  { method: "POST", path: "/User/getSignableSecret", purpose: "challenge of the device-key and wallet sign-in" },
  { method: "POST", path: "/User/login", purpose: "sign-in (every method; device key, wallet, password, email code, CG ID passkey, X, LUKSO, Farcaster)" },
  { method: "POST", path: "/User/checkLoginStatus", purpose: "session state" },
  { method: "POST", path: "/User/ensureSession", purpose: "session keepalive" },
  { method: "POST", path: "/User/logout", purpose: "sign-out" },
  { method: "POST", path: "/User/clearLoginSession", purpose: "drops a prepared X/LUKSO/Farcaster sign-in" },
  // sign-in methods that need a step before User/login
  { method: "POST", path: "/User/prepareWalletAction", purpose: "wallet and recovery-phrase sign-in (signature check)" },
  { method: "POST", path: "/User/sendOneTimePasswordForLogin", purpose: "email-code sign-in (sends the code)" },
  { method: "POST", path: "/CgId/generateAuthenticationOptions", purpose: "CG ID passkey assertion (options)" },
  { method: "POST", path: "/CgId/verifyAuthenticationResponse", purpose: "CG ID passkey assertion (verification)" },
  { method: "POST", path: "/CgId/ensureSession", purpose: "CG ID app keepalive" },
  { method: "GET", path: "/Twitter/startLogin", purpose: "X sign-in (redirect to X)" },
  { method: "GET", path: "/twitter-callback", purpose: "X sign-in (return from X)" },
  { method: "GET", path: "/twitter-login", purpose: "X sign-in (the popup's page)" },
  { method: "POST", path: "/Twitter/finishLogin", purpose: "X sign-in (profile of the prepared login)" },
  { method: "POST", path: "/Lukso/PrepareLuksoAction", purpose: "LUKSO sign-in (signature check)" },
  { method: "POST", path: "/Accounts/Farcaster/verifyLogin", purpose: "Farcaster sign-in (signature check)" },
  // the move
  { method: "POST", path: "/User/createTransferLink", purpose: "the one-time link to the new instance" },
  // configuration the web app reads
  { method: "GET", path: "/Instance/config", purpose: "instance configuration" },
]);

/**
 * Express matches paths case-insensitively and ignores one trailing slash
 * (non-strict routing); compare in that form. Anything else — another case
 * of a percent-encoding, double slashes, dot segments — is simply not on the
 * list, so it is refused.
 */
export function normalizeRoutePath(path: string): string {
  const lower = path.toLowerCase();
  return lower.length > 1 && lower.endsWith("/") ? lower.slice(0, -1) : lower;
}

const allowedKeys = new Set(GATEWAY_API_ALLOWLIST.map(route => `${route.method} ${normalizeRoutePath(route.path)}`));

/** whether a gateway serves this request (HEAD counts as GET, like in Express) */
export function isGatewayApiRequestAllowed(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  const asMethod = upper === "HEAD" ? "GET" : upper;
  return allowedKeys.has(`${asMethod} ${normalizeRoutePath(path)}`);
}

/**
 * In gateway mode: answers every request that is not on GATEWAY_API_ALLOWLIST
 * — and every request with an Authorization header — with 404
 * `NOT_SUPPORTED`, before the session (no session is read, created
 * or refreshed for it) and before any router. Mounted first, right after CORS
 * (srv/util/express.ts). Outside gateway mode it does nothing.
 */
export function gatewayApiGuard(env: NodeJS.ProcessEnv = process.env): express.RequestHandler {
  const active = isGatewayMode(env);
  return function gatewayApiGuardMiddleware(request, response, next) {
    // bearer tokens (bots) belong to the main instance: refused before the
    // token is looked up
    if (!active || (request.headers.authorization === undefined && isGatewayApiRequestAllowed(request.method, request.path))) {
      next();
      return;
    }
    response.status(404).json({ status: "ERROR", error: errors.server.NOT_SUPPORTED });
  };
}

// --- wsapi -----------------------------------------------------------------

/**
 * Socket events a gateway serves: the keepalive, and watching the result of
 * a CG ID passkey popup (cliCgIdSignResponse). No socket sign-in: a gateway
 * socket never joins a user's, community's or device's room.
 */
export const GATEWAY_SOCKET_EVENTS: readonly string[] = Object.freeze(["cgPing", "watchCgIdRequest"]);

export function isGatewaySocketEventAllowed(event: unknown): boolean {
  return typeof event === "string" && GATEWAY_SOCKET_EVENTS.includes(event);
}

/**
 * Socket.IO per-socket middleware (`socket.use`): in gateway mode an event
 * that is not on GATEWAY_SOCKET_EVENTS never reaches its handler and gets no
 * acknowledgement. Outside gateway mode it passes everything.
 */
export function gatewaySocketEventGuard(env: NodeJS.ProcessEnv = process.env): (packet: unknown[], next: (err?: Error) => void) => void {
  const active = isGatewayMode(env);
  return (packet, next) => {
    if (!active || isGatewaySocketEventAllowed(packet[0])) {
      next();
    }
    // dropped: no next(), so no handler and no "error" event either
  };
}

/**
 * Socket.IO handshake middleware (`io.use`): a gateway accepts no bot token
 * handshakes (bots belong to the main instance).
 */
export function gatewayHandshakeGuard(env: NodeJS.ProcessEnv = process.env): (socket: { handshake: { auth?: Record<string, unknown> } }, next: (err?: Error) => void) => void {
  const active = isGatewayMode(env);
  return (socket, next) => {
    if (active && socket.handshake.auth?.token !== undefined) {
      next(new Error("unauthorized"));
      return;
    }
    next();
  };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type cors from "cors";
import type express from "express";
import config from "../common/config";
import errors from "../common/errors";
import urls from "./urls";
import { isLegacyCgidMode } from "./passkeyConfig";

/**
 * The origins the web app of this instance runs on: exactly the BASE_URL
 * origin, plus the local development origins in dev. Used for the domain of
 * wallet sign-in messages (SIWE) and as the base of allowedOrigins().
 */
export function appOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const origins = [new URL(urls.APP_URL).origin];
  if (config.DEPLOYMENT === 'dev') {
    origins.push(
      'http://localhost:3000',
      'https://localhost:3000',
      'http://localhost:8000',
      'https://localhost:8001',
      'http://app.cg.local:3000',
      'https://app.cg.local:3000',
      'http://app.cg.local:8000',
      'https://app.cg.local:8001',
      'https://bs-local.com:3000',
      'https://bs-local.com:8001',
    );
    if (env.LOCAL_CERTIFICATE_IP) {
      origins.push(
        `http://${env.LOCAL_CERTIFICATE_IP}:3000`,
        `https://${env.LOCAL_CERTIFICATE_IP}:3000`,
        `http://${env.LOCAL_CERTIFICATE_IP}:8000`,
        `https://${env.LOCAL_CERTIFICATE_IP}:8001`,
      );
    }
  }
  return origins;
}

/**
 * The one list of origins whose pages may call this instance's api and wsapi
 * with credentials (CORS) and open its sockets: appOrigins() — derived from
 * BASE_URL (and LOCAL_CERTIFICATE_IP in dev) —, plus the CG ID app's origin
 * (CGID_URL) on a legacy CG ID process outside dev, whose mini-app calls the
 * api from its own origin.
 */
export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const origins = appOrigins(env);
  if (config.DEPLOYMENT !== 'dev' && isLegacyCgidMode(env) && env.CGID_URL) {
    origins.push(new URL(env.CGID_URL).origin);
  }
  return Array.from(new Set(origins));
}

/**
 * Request headers a cross-origin page may send (CORS preflight). Everything
 * the web app, the CG ID app and the SDK set; `X-Cg-Socket-Id` names the
 * socket of the tab that sends a request (realtime events skip that socket).
 */
export const CORS_ALLOWED_HEADERS = ['Accept', 'Content-Type', 'Authorization', 'X-Cg-Socket-Id'];

/**
 * CORS for the api and the wsapi (polling transport). A request with an
 * Origin outside the list is refused before (originGuard, socketOriginCheck);
 * a request without an Origin header (same-origin GET, curl, the SDK, bots)
 * gets no CORS headers and needs none.
 */
export function createCorsOptions(origins: string[] = allowedOrigins()): cors.CorsOptions {
  return {
    origin: (origin, callback) => callback(null, !!origin && origins.includes(origin)),
    credentials: true,
    allowedHeaders: CORS_ALLOWED_HEADERS,
    preflightContinue: false,
  };
}

/** an Origin header outside the list; a missing one is not a refusal here */
export function isRefusedOrigin(origin: string | undefined, origins: string[]): boolean {
  return origin !== undefined && !origins.includes(origin);
}

/**
 * api: answers a request whose Origin header names another origin with 403
 * NOT_ALLOWED — preflights included — before anything else runs, except on
 * the routes of ORIGIN_FREE_ROUTES. Requests
 * without an Origin are left alone: browsers omit it on same-origin GETs, and
 * the session cookie (SameSite=Lax) never comes along on another site's
 * requests anyway.
 */
export function originGuard(origins: string[] = allowedOrigins()): express.RequestHandler {
  return function originGuardMiddleware(request, response, next) {
    if (isRefusedOrigin(request.headers.origin, origins) && !isOriginFreeRoute(request.path)) {
      response.status(403).json({ status: 'ERROR', error: errors.server.NOT_ALLOWED });
      return;
    }
    next();
  };
}

/**
 * Routes another site may call: one-click unsubscribe (RFC 8058,
 * srv/api/emailUnsubscribe.ts) — mail providers send its POST from their
 * servers or from their web mail's pages, with their own Origin or none; the
 * signed token in the URL alone authorizes it, and it can only turn mails off.
 */
export const ORIGIN_FREE_ROUTES = ['/user/emailunsubscribe'];

/** compared like Express routes: case-insensitive, one trailing slash ignored */
export function isOriginFreeRoute(path: string): boolean {
  const lower = path.toLowerCase();
  return ORIGIN_FREE_ROUTES.includes(lower.length > 1 && lower.endsWith('/') ? lower.slice(0, -1) : lower);
}

type SocketRequest = { headers: { origin?: string } };

/**
 * wsapi: whether a Socket.IO request (handshake, polling request or WebSocket
 * upgrade) may proceed; a refusal names the reason. An Origin header that is
 * present must be on the list — browsers always send one on a WebSocket and
 * on cross-origin requests, so another site's page is refused. Requests
 * without one proceed: the web app's same-origin polling GETs, and
 * non-browser clients (bots with their token, the SDK, which connects with
 * its session cookie and no Origin).
 */
export function socketOriginCheck(request: SocketRequest, origins: string[]): string | null {
  const { origin } = request.headers;
  if (origin !== undefined && !origins.includes(origin)) {
    return 'origin not allowed';
  }
  return null;
}

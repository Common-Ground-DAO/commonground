// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import crypto from 'crypto';
import cookie from 'cookie';
import type express from 'express';
import session from 'express-session';
import passport from 'passport';
import config from '../common/config';
import serverconfig from '../serverconfig';
import urls from './urls';
import { isLegacyCgidMode } from './passkeyConfig';
import { SIGNUP_CAPTCHA_TTL_MS } from './signupEmail';
import { sessionGenerationGuard } from './userSessions';
import { requireSessionSecret } from './sessionSecret';
import { instanceKeyPrefix } from './gateway';

// Session setup of the api process (srv/util/express.ts).
//
// A session — and with it a cookie — only exists once a request stores
// something in it (login, sign-up, WebAuthn/SIWE challenges, …;
// `saveUninitialized: false`): an anonymous request that stores nothing
// creates no session and gets no Set-Cookie. Otherwise the parallel requests
// of a page load without a valid session each minted an anonymous session,
// and their cookies could overwrite the one the device login had just set.
//
// `rolling` is off as well: the cookie of a logged-in session is re-sent with
// every response (rollLoggedInSessionCookie), the cookie of any other session
// only when the session changes. A response to a request that left with the
// anonymous pre-login cookie (the device login's challenge lives in it) thus
// cannot put that id back into the browser after the login replaced it.
//
// A session id that is destroyed (logout) or replaced (regenerate: login) is
// revoked for a while (withSessionRevocation): the store refuses to write it
// again, and a request that loaded the session before it went away answers
// without it (revokedSessionGuard) — no Set-Cookie of the old id and no save
// that would bring a logged-out session back. Left open: a request whose
// response was complete on the server before the revocation but reaches the
// browser after the new cookie (delivery reordering) can still set the old id.
//
// A session without a logged-in user (the device login's challenge, a sign-up
// in progress, a WebAuthn ceremony) is kept in the store for a short time only
// (sessionStoreTtlSeconds); from login on, the full 12 hours apply.

let configuredSessionSecret: string | undefined;
/**
 * The secret that signs the session cookie, read once; a missing one stops
 * the api when it builds its session middleware (srv/util/sessionSecret.ts).
 */
export function sessionSecret(): string {
  return configuredSessionSecret ??= requireSessionSecret();
}

/**
 * key prefix of the sessions in the store: connect-redis' default `sess:` on
 * the main instance, `gateway:sess:` on a gateway (srv/util/gateway.ts), so
 * neither ever loads the other's sessions
 */
export const SESSION_KEY_PREFIX = `${instanceKeyPrefix()}sess:`;

const SESSION_MAX_AGE_MS = 12*60*60*1000; // 12 hours

// kept in its own binding because `SessionOptions['cookie']` is a union with a
// per-request callback since express-session 1.19 — indexing into it directly
// no longer type-checks
export const sessionCookieOptions: session.CookieOptions = {
  maxAge: SESSION_MAX_AGE_MS,
  httpOnly: true,
  secure: config.DEPLOYMENT !== "dev",
  sameSite: 'lax',
};

/**
 * How long the store keeps a session without a logged-in user after its last
 * request. Every request refreshes it, so does the web app's keepalive
 * (User/ensureSession, every 29 minutes) while a tab is open — twice within
 * the hour, so one keepalive that a throttled background tab or a sleeping
 * laptop delays does not lose a sign-up or wallet step in progress.
 */
export const ANONYMOUS_SESSION_TTL_MS = 60 * 60 * 1000;

/**
 * Store TTL of a session, in seconds (connect-redis `ttl`): the rest of the
 * cookie's lifetime for a logged-in session; for any other session at most
 * ANONYMOUS_SESSION_TTL_MS — longer only while a sign-up in it needs its state:
 * until the verified address or the code runs out (`expiresAt`, at most an
 * hour) and while the solved captcha still counts for a new code
 * (SIGNUP_CAPTCHA_TTL_MS). Never beyond the cookie. A request that loads the
 * session computes it again, so the short TTL ends with the login.
 */
export function sessionStoreTtlSeconds(
  sess: Omit<Partial<session.SessionData>, 'cookie'> & { cookie?: { expires?: Date | string | null } },
  now = Date.now(),
): number {
  const expires = sess.cookie?.expires;
  const cookieMs = expires ? new Date(expires).getTime() - now : SESSION_MAX_AGE_MS;
  let keepMs = cookieMs;
  if (!sess.user) {
    keepMs = ANONYMOUS_SESSION_TTL_MS;
    const signup = sess.signupEmail;
    if (signup) {
      keepMs = Math.max(keepMs, signup.expiresAt - now);
      if (typeof signup.captchaAt === 'number') {
        keepMs = Math.max(keepMs, signup.captchaAt + SIGNUP_CAPTCHA_TTL_MS - now);
      }
    }
    keepMs = Math.min(keepMs, cookieMs);
  }
  return Math.ceil(keepMs / 1000);
}

// Legacy CG ID mode only: scope the session cookie to all subdomains so the
// app and the CG ID app (id.<domain>) share a session (.app.cg unchanged).
// Everywhere else the cookie is host-only — no other host under the domain
// ever receives it.
if (config.DEPLOYMENT !== 'dev' && isLegacyCgidMode()) {
  sessionCookieOptions.domain = `.${urls.APP_HOSTNAME}`;
}

export function createSessionOptions(store: session.Store): session.SessionOptions {
  return {
    store,
    name: serverconfig.SESSION_COOKIE_NAME,
    secret: sessionSecret(),
    proxy: true,
    cookie: sessionCookieOptions,
    resave: false,
    saveUninitialized: false,
    rolling: false,
  };
}

/** Revoked session ids (destroyed or regenerated), for REVOCATION_TTL_MS. */
export type SessionRevocations = {
  revoke(sid: string): Promise<void>;
  isRevoked(sid: string): Promise<boolean>;
};

// long enough for any request that loaded the session before it went away
const REVOCATION_TTL_MS = 60 * 60 * 1000;

type RevocationClient = {
  set(key: string, value: string, options: { PX: number }): Promise<unknown>;
  exists(key: string): Promise<number>;
};

/**
 * `sess-revoked:<id>` keys next to the sessions (`sess:<id>`), with the
 * instance's key prefix (`gateway:` on a gateway)
 */
export function redisSessionRevocations(client: RevocationClient, prefix: string = instanceKeyPrefix()): SessionRevocations {
  const key = (sid: string) => `${prefix}sess-revoked:${sid}`;
  return {
    revoke: async (sid) => {
      await client.set(key(sid), '1', { PX: REVOCATION_TTL_MS });
    },
    isRevoked: async (sid) => (await client.exists(key(sid))) > 0,
  };
}

/**
 * Wraps the store: destroy() (also the one regenerate() calls) first revokes
 * the id, set() never writes a revoked id. set() checks again after writing
 * and removes what it wrote if the id was revoked in the meantime — a destroy
 * that overtook the write revoked the id before deleting, so either the
 * delete or this re-check removes it.
 */
export function withSessionRevocation<S extends session.Store>(store: S, revocations: SessionRevocations): S {
  const destroy = store.destroy.bind(store);
  const set = store.set.bind(store);
  store.destroy = (sid, callback) => {
    revocations.revoke(sid).then(() => destroy(sid, callback), (e) => callback?.(e));
  };
  store.set = (sid, data, callback) => {
    revocations.isRevoked(sid).then((revoked) => {
      if (revoked) {
        callback?.();
        return;
      }
      set(sid, data, (e?: unknown) => {
        if (e) {
          callback?.(e);
          return;
        }
        revocations.isRevoked(sid).then(
          (revokedNow) => (revokedNow ? destroy(sid, () => callback?.()) : callback?.()),
          (e2) => callback?.(e2),
        );
      });
    }, (e) => callback?.(e));
  };
  return store;
}

/**
 * The session middlewares in order. Bot requests (bearer token,
 * srv/util/botPrincipal.ts) skip all of them: they never have a session.
 * `store` should be wrapped with withSessionRevocation using the same
 * `revocations`.
 */
export function createSessionMiddlewares(store: session.Store, revocations: SessionRevocations): express.RequestHandler[] {
  const sessionMiddleware = session(createSessionOptions(store));
  const passportInitializeMiddleware = passport.initialize();
  const passportSessionMiddleware = passport.session();
  const skipBots = (middleware: express.RequestHandler): express.RequestHandler => (request, response, next) => {
    if (request.botPrincipal) return next();
    middleware(request, response, next);
  };
  return [
    // before the session middleware: express-session wraps writeHead after
    // this, so its own Set-Cookie decision is made before the hook runs
    skipBots((request, response, next) => {
      beforeHeaders(response, () => rollLoggedInSessionCookie(request, response));
      next();
    }),
    skipBots(sessionMiddleware),
    // after the session middleware: wraps res.end around express-session's
    skipBots(revokedSessionGuard(revocations)),
    // after the revocation guard: a session of an older generation than its
    // user's (signed out from another device) ends here, and the guard above
    // keeps it from being saved or re-sent (srv/util/sessionGenerations.ts)
    skipBots(sessionGenerationGuard()),
    skipBots(passportInitializeMiddleware),
    skipBots(passportSessionMiddleware),
    skipBots(legacyDomainCookieMiddleware),
  ];
}

/** the session holds data (it was loaded from the store or written in this request) */
export function hasStoredData(current: session.Session & Partial<session.SessionData>): boolean {
  return Object.keys(current).some(key => key !== 'cookie');
}

/**
 * For a session loaded from the store (it has data before the handler ran):
 * if its id was revoked while the request ran — logout destroyed it, a login
 * replaced it — the request ends without a session, so express-session
 * neither saves it nor sends its cookie, and no logged-in cookie is rolled.
 * The check runs before the response starts: before res.end, or before the
 * first res.write of a streamed response (which sends the headers). Writes
 * and the end that arrive meanwhile are queued in order; a write answers
 * `false` and the response emits 'drain' once the queue is flushed, so a
 * piped stream waits.
 */
function revokedSessionGuard(revocations: SessionRevocations): express.RequestHandler {
  return (request, response, next) => {
    const loadedId = request.session && hasStoredData(request.session) ? request.sessionID : undefined;
    if (!loadedId) {
      return next();
    }
    const write = response.write as (...a: unknown[]) => boolean;
    const end = response.end as (...a: unknown[]) => express.Response;
    let state: 'pending' | 'checking' | 'done' = 'pending';
    const queue: (() => void)[] = [];
    // a session this request destroyed or replaced itself is handled by
    // express-session (no session / a new id); headers already out: too late
    const needsCheck = () =>
      state !== 'done' && !!request.session && request.sessionID === loadedId && !response.headersSent;
    const check = () => {
      state = 'checking';
      revocations.isRevoked(loadedId).then((revoked) => {
        if (revoked) {
          delete (request as { session?: unknown }).session;
        }
      }, (e) => {
        console.error("Error checking the session revocation", e);
      }).finally(() => {
        state = 'done';
        const hadWrites = queue.length > 0;
        for (const run of queue.splice(0)) {
          run();
        }
        if (hadWrites) {
          response.emit('drain');
        }
      });
    };
    response.write = function (this: express.Response, ...args: unknown[]) {
      if (!needsCheck()) {
        return write.apply(response, args);
      }
      queue.push(() => { write.apply(response, args); });
      if (state === 'pending') {
        check();
      }
      return false;
    } as typeof response.write;
    response.end = function (this: express.Response, ...args: unknown[]) {
      if (!needsCheck()) {
        return end.apply(response, args);
      }
      queue.push(() => { end.apply(response, args); });
      if (state === 'pending') {
        check();
      }
      return response;
    } as typeof response.end;
    next();
  };
}

/** the request came with a session cookie (valid or not) */
export function hasSessionCookie(request: express.Request): boolean {
  return request.cookies?.[serverconfig.SESSION_COOKIE_NAME] !== undefined;
}

/**
 * Instances upgraded in place used to scope the session cookie to
 * `.<APP_HOSTNAME>`; the cookie is host-only now (except in legacy CG ID mode,
 * which keeps the old scope, and in dev).
 */
export function legacyDomainCookieCleanupActive(): boolean {
  return config.DEPLOYMENT !== 'dev' && !isLegacyCgidMode();
}

/**
 * Expires such an old subdomain-scoped cookie so the browser does not keep
 * sending two cookies of the same name. Only a request that carries a session
 * cookie can come from a browser that still has the old one; a login marks its
 * session (`legacyDomainCookieCleared`, establishLoginSession), which ends the
 * clearing for it. This never writes to the session: a request that stores
 * nothing must not create one.
 */
function legacyDomainCookieMiddleware(request: express.Request, response: express.Response, next: express.NextFunction) {
  if (
    legacyDomainCookieCleanupActive() &&
    hasSessionCookie(request) &&
    !request.session?.legacyDomainCookieCleared
  ) {
    response.clearCookie(serverconfig.SESSION_COOKIE_NAME, {
      domain: `.${urls.APP_HOSTNAME}`,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
  }
  next();
}

/** expires the session cookie itself (logout: the session it named is gone) */
export function clearSessionCookie(response: express.Response) {
  // no maxAge here: Express would turn it into a future expiry
  const { domain, httpOnly, secure, sameSite } = sessionCookieOptions;
  response.clearCookie(serverconfig.SESSION_COOKIE_NAME, { domain, path: '/', httpOnly, secure: secure === true, sameSite });
}

function setCookieLines(response: express.Response): string[] {
  const value = response.getHeader('Set-Cookie');
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [String(value)];
}

/**
 * Sliding expiry for logged-in sessions: re-sends the cookie of the request's
 * session with a fresh expiry when the session has a user and express-session
 * did not set the cookie itself in this response (it does for a new, changed
 * or regenerated session). Runs right before the headers go out, after
 * express-session's own Set-Cookie decision. The value is signed exactly like
 * express-session signs it (`s:` + HMAC-SHA256, cookie-signature).
 */
export function rollLoggedInSessionCookie(request: express.Request, response: express.Response) {
  const { session: current, sessionID } = request;
  if (!current?.user || typeof sessionID !== 'string' || current.id !== sessionID) {
    return;
  }
  const lines = setCookieLines(response);
  const prefix = `${serverconfig.SESSION_COOKIE_NAME}=`;
  if (lines.some(line => line.startsWith(prefix) && !/Expires=Thu, 01 Jan 1970/i.test(line))) {
    return;
  }
  // like express-session: secure cookies only over https (behind the proxy)
  if (current.cookie.secure && !request.secure) {
    return;
  }
  current.touch();
  const signature = crypto.createHmac('sha256', sessionSecret()).update(sessionID).digest('base64').replace(/=+$/, '');
  const { expires, httpOnly, secure, domain, path, sameSite } = current.cookie;
  const line = cookie.serialize(serverconfig.SESSION_COOKIE_NAME, `s:${sessionID}.${signature}`, {
    expires: expires ?? undefined,
    httpOnly,
    secure: secure === true,
    domain,
    path,
    sameSite,
  });
  response.setHeader('Set-Cookie', [...lines, line]);
}

/**
 * Calls `hook` once, right before the response headers are written (also for
 * the implicit writeHead of res.end). Middleware that wraps writeHead later
 * (express-session) runs its own header work first.
 */
function beforeHeaders(response: express.Response, hook: () => void) {
  const writeHead = response.writeHead;
  let fired = false;
  response.writeHead = function (this: express.Response, ...args: unknown[]) {
    if (!fired) {
      fired = true;
      hook();
    }
    return (writeHead as (...a: unknown[]) => express.Response).apply(this, args);
  } as typeof response.writeHead;
}

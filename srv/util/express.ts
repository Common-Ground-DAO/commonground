// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from 'express';
import cors from 'cors';
import 'express-session';
import { RedisStore } from 'connect-redis';
import cookieParser from 'cookie-parser';
import redisManager from '../redis';
import serverconfig from '../serverconfig';
import { UserV2 } from 'twitter-api-v2';
import type { ChallengeEntry, PendingPasskey } from './passkeys';
import type { AuthMethod } from './authSession';
import { botAllowlistMiddleware, botAuthenticationMiddleware } from './botPrincipal';
import { createSessionMiddlewares, redisSessionRevocations, SESSION_KEY_PREFIX, sessionStoreTtlSeconds, withSessionRevocation } from './sessionSetup';
import { redisUserSessionIndex, withUserSessionIndex } from './userSessions';
import { GenerationReconciler, redisSessionGenerations } from './sessionGenerations';
import userHelper from '../repositories/users';
import deviceHelper from '../repositories/device';
import { allowedOrigins, createCorsOptions, originGuard } from './origins';
import { gatewayApiGuard } from './gateway';

// TYPES
export type User = {
  id: string; 
  deviceId: string;
}

declare module 'express-session' {
  interface SessionData {
    user?: User;
    signSecret?: string;
    // when the login session was created (establishLoginSession); nothing
    // reads it
    createdAt?: Date;
    // the session generation read when the session's login started
    // (establishLoginSession); a lower one than its user's ends the session
    // (srv/util/sessionGenerations.ts)
    gen?: number;
    passport?: any;

    twitter?: {
      codeVerifier: string;
      state: string;

      accessToken?: string;
      refreshToken?: string;
      userData?: UserV2;
    };

    lukso?: {
      message: string;
      address: string;
      username: string;
      profileImageUrl: string;
      signature: string;
      description?: string;
      existsAlready?: boolean;
      /** when Lukso/PrepareLuksoAction checked the message and signature (ms) */
      preparedAt?: number;
    };

    farcaster?: {
      address: Common.Address;
      fid: number;
      readyForLogin: boolean;
      readyForCreation: boolean;
      displayName: string;
      username: string;
      bio?: string;
      url?: string;
      imageId: string | null;
    };

    preparedCredential?: Models.Server.Session.PreparedCredential;

    // WebAuthn ceremonies in flight, keyed by challenge (srv/util/passkeys.ts)
    webauthnChallenges?: Record<string, ChallengeEntry>;

    // a passkey registered during sign-up, inserted by createUser
    pendingPasskey?: PendingPasskey;

    // sign-up email verification before the account exists
    // (User/requestSignupEmailCode, User/verifySignupEmailCode)
    signupEmail?: {
      email: string;
      codeId?: string;
      codeHash?: string;
      expiresAt: number;
      attempts: number;
      verifiedAt?: number;
      // when the captcha of this sign-up was solved (requestSignupEmailCode);
      // createUser then accepts the verified address without a second one
      captchaAt?: number;
    };

    // when and how the session last authenticated interactively (step-up,
    // srv/util/authSession.ts); never set by a device-key login
    authAt?: number;
    authMethod?: AuthMethod;

    // legacy CG ID mode only: result of a successful CgId assertion, redeemed
    // by User/login {type:'passkey-success'}
    passkeyData?: {
      step: "success";
      passkeyId: string;
      userId: string | null;
      expiresAt: number;
    };

    // set at login once the obsolete subdomain-scoped session cookie was
    // expired (srv/util/sessionSetup.ts, establishLoginSession)
    legacyDomainCookieCleared?: boolean;

    // the session user's account was found complete (account-security step,
    // srv/util/securityStep.ts); a new login regenerates the session
    securityStepClearFor?: { userId: string; version: string | null };

    temporaryArticleIds?: string[];
  }
}

// APP SETUP
const app = express();
// one origin list for the api and the wsapi (srv/util/origins.ts): a request
// with another Origin is refused with 403, CORS headers only for listed ones
const origins = allowedOrigins();
app.set('trust proxy', true);
app.use(originGuard(origins));
app.use(cors(createCorsOptions(origins)));
// gateway mode (srv/util/gateway.ts): only the gateway's routes, refused
// before the session is read or created and before any router
app.use(gatewayApiGuard());
// only json responses
app.use((request, response, next) => {
  response.setHeader("Content-Type", "application/json");
  next();
});
app.use(cookieParser());

// SESSION SETUP
// connect-redis ≥7 exports the store as a plain class instead of the
// `connectRedis(session)` factory v6 used, and talks to node-redis through its
// promise API (no `legacyMode` client any more). The default key prefix is
// still `sess:`, so sessions written by the old store keep working.

// Sessions are only created when something is stored in them, and only the
// cookie of a logged-in session is re-sent on every response
// (srv/util/sessionSetup.ts). A session without a logged-in user is kept for
// a short time only (sessionStoreTtlSeconds); the logged-in sessions of each
// user are indexed, and a per-user session generation ends every session
// whose login started before the user's last sign-out of other devices
// (srv/util/userSessions.ts, srv/util/sessionGenerations.ts).
app.use(botAuthenticationMiddleware);
const sessionRevocations = redisSessionRevocations(redisManager.getClient('session'));
const sessionGenerations = redisSessionGenerations(redisManager.getClient('session'));
const sessionStore = withUserSessionIndex(new RedisStore({
  client: redisManager.getClient('session'),
  prefix: SESSION_KEY_PREFIX,
  ttl: sessionStoreTtlSeconds,
}), redisUserSessionIndex(redisManager.getClient('session')), {
  generations: sessionGenerations,
  generationsReady: () => generationReconciler.ready,
  currentGeneration: (userId) => userHelper.getSessionGeneration(userId),
  discardDevice: (deviceId) => deviceHelper.deleteDevice(deviceId),
});
// copies the generations committed since its last run to Valkey: at start
// (retried until Valkey and PostgreSQL answer; logged-in requests fail until
// then) and every 30 s — a copy that failed at sign-out, or one lost with a
// Valkey restored from an older snapshot, arrives within one interval
const generationReconciler = new GenerationReconciler(sessionGenerations, (after) => userHelper.sessionGenerationsSince(after));
generationReconciler.start();
app.use(createSessionMiddlewares(withSessionRevocation(sessionStore, sessionRevocations), sessionRevocations));
app.use(botAllowlistMiddleware);

  /**
 * ==========  start server  ==========
 */

// Express 5 (path-to-regexp 8): a wildcard needs a name; the braces make it
// match the root path as well, like Express 4's '*'
app.options('/{*splat}', () => undefined);

app.listen(4000);

export default app;

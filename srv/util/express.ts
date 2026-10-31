// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from 'express';
import cors from 'cors';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import cookieParser from 'cookie-parser';
import redisManager from '../redis';
import { dockerSecret } from '.';
import config from '../common/config';
import serverconfig from '../serverconfig';
import urls from './urls';
import { UserV2 } from 'twitter-api-v2';
import passport from 'passport';
import type { ChallengeEntry, PendingPasskey } from './passkeys';
import type { AuthMethod } from './authSession';
import { isLegacyCgidMode } from './passkeyConfig';
import { botAllowlistMiddleware, botAuthenticationMiddleware } from './botPrincipal';

// TYPES
export type User = {
  id: string; 
  deviceId: string;
}

declare module 'express-session' {
  interface SessionData {
    user?: User;
    signSecret?: string;
    createdAt?: Date;
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

    // set once the obsolete subdomain-scoped session cookie was expired
    legacyDomainCookieCleared?: boolean;

    temporaryArticleIds?: string[];
  }
}

// APP SETUP
const app = express();
const allowedOrigins = [ process.env.BASE_URL as string ];
if (config.DEPLOYMENT === 'dev') {
  allowedOrigins.push('http://localhost:3000');
  allowedOrigins.push('https://localhost:3000');
  allowedOrigins.push('http://localhost:8000');
  allowedOrigins.push('https://localhost:8001');
  allowedOrigins.push('http://app.cg.local:3000');
  allowedOrigins.push('https://app.cg.local:3000');
  allowedOrigins.push('http://app.cg.local:8000');
  allowedOrigins.push('https://app.cg.local:8001');
  allowedOrigins.push('https://bs-local.com:3000');
  allowedOrigins.push('https://bs-local.com:8001');
  if (!!process.env.LOCAL_CERTIFICATE_IP) {
    allowedOrigins.push(`http://${process.env.LOCAL_CERTIFICATE_IP}:3000`);
    allowedOrigins.push(`https://${process.env.LOCAL_CERTIFICATE_IP}:3000`);
    allowedOrigins.push(`http://${process.env.LOCAL_CERTIFICATE_IP}:8000`);
    allowedOrigins.push(`https://${process.env.LOCAL_CERTIFICATE_IP}:8001`);
  }
}
else if (isLegacyCgidMode() && process.env.CGID_URL) {
  // legacy CG ID app on its own origin (gateway mode only)
  allowedOrigins.push(new URL(process.env.CGID_URL).origin);
}
const corsOptions: cors.CorsOptions = {
  origin: function(origin, callback){
    // allow requests with no origin 
    // (like mobile apps or curl requests)
    if(!origin) return callback(null, true);
    if(allowedOrigins.indexOf(origin) === -1){
      var msg = 'The CORS policy for this site does not ' +
                'allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true,
  preflightContinue: false,
};
app.set('trust proxy', true);
app.use(cors(corsOptions));
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

// kept in its own binding because `SessionOptions['cookie']` is a union with a
// per-request callback since express-session 1.19 — indexing into it directly
// no longer type-checks
const sessionCookieOptions: session.CookieOptions = {
  maxAge: 12*60*60*1000, // 12 hours
  httpOnly: true,
  secure: config.DEPLOYMENT !== "dev",
  sameSite: 'lax',
};

const sessionOptions: session.SessionOptions = {
  store: new RedisStore({
    client: redisManager.getClient('session')
  }),
  name: serverconfig.SESSION_COOKIE_NAME,
  secret: dockerSecret('redis_secret') || process.env.REDIS_SECRET as string,
  proxy: true,
  cookie: sessionCookieOptions,
  resave: false,
  saveUninitialized: true,
  rolling: true,
};

// Legacy CG ID mode only: scope the session cookie to all subdomains so the
// app and the CG ID app (id.<domain>) share a session (.app.cg unchanged).
// Everywhere else the cookie is host-only — no other host under the domain
// ever receives it.
if (config.DEPLOYMENT !== 'dev' && isLegacyCgidMode()) {
  sessionCookieOptions.domain = `.${urls.APP_HOSTNAME}`;
}

const sessionMiddleware = session(sessionOptions);
const passportInitializeMiddleware = passport.initialize();
const passportSessionMiddleware = passport.session();

app.use(botAuthenticationMiddleware);
app.use((request, response, next) => {
  if (request.botPrincipal) return next();
  sessionMiddleware(request, response, next);
});
app.use((request, response, next) => {
  if (request.botPrincipal) return next();
  passportInitializeMiddleware(request, response, next);
});
app.use((request, response, next) => {
  if (request.botPrincipal) return next();
  passportSessionMiddleware(request, response, next);
});

app.use((request, response, next) => {
  if (request.botPrincipal) return next();
  if (!request.session.createdAt) {
    request.session.createdAt = new Date();
  }
  next();
});
// Instances upgraded in place used to scope the session cookie to
// `.<APP_HOSTNAME>`; the cookie is host-only now. Expire such an old
// subdomain-scoped cookie once per session so the browser does not keep
// sending two cookies of the same name (legacy CG ID mode keeps the old scope).
app.use((request, response, next) => {
  if (request.botPrincipal || config.DEPLOYMENT === 'dev' || isLegacyCgidMode()) return next();
  if (!request.session.legacyDomainCookieCleared) {
    response.clearCookie(serverconfig.SESSION_COOKIE_NAME, {
      domain: `.${urls.APP_HOSTNAME}`,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
    request.session.legacyDomainCookieCleared = true;
  }
  next();
});
app.use(botAllowlistMiddleware);

  /**
 * ==========  start server  ==========
 */

app.options('*', () => undefined);

app.listen(4000);

export default app;

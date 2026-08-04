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
import {
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import passport from 'passport';
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

    passkeyData?: {
      step: "registration_sign";
      options: PublicKeyCredentialCreationOptionsJSON;
    } | {
      step: "authentication_sign";
      options: PublicKeyCredentialRequestOptionsJSON;
    } | {
      step: "success";
      passkeyId: string;
      userId: string | null;
    } | {
      step: "error";
      message: string;
    };

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
else {
  allowedOrigins.push(process.env.CGID_URL as string);
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

// allow session cookie for subdomains so that the app and the CG ID app
// (id.<domain>) share a session; derived from BASE_URL so self-hosted
// instances get their own domain (.app.cg / .staging.app.cg unchanged)
if (config.DEPLOYMENT !== 'dev') {
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
app.use(botAllowlistMiddleware);

  /**
 * ==========  start server  ==========
 */

app.options('*', () => undefined);

app.listen(4000);

export default app;

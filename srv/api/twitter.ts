// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from "express";
import { TwitterApi } from 'twitter-api-v2';
import errors from "../common/errors";
import { handleError, registerPostRoute } from "./util";
import ipRateLimitHandler from "../util/rateLimit";
import { RateLimitError } from "../util/rateLimitError";
import { AUTH_LIMITS } from "../util/authLimits";
import validators from "../validators";
import userHelper from "../repositories/users";
import { dockerSecret } from "../util";
import passport from "passport";
import { Strategy as TwitterStrategy } from "passport-twitter";
import urls from "../util/urls";

const twitterRouter = express.Router();

const TWITTER_CALLBACK_URL = process.env.TWITTER_CALLBACK_URL || "";

const TWITTER_API_KEY = dockerSecret("twitter_api_v1_key") || process.env.TWITTER_API_KEY || '';
const TWITTER_API_SECRET = dockerSecret("twitter_api_v1_secret") || process.env.TWITTER_API_SECRET || '';

if (TWITTER_API_KEY && TWITTER_API_SECRET) {
  passport.use(new TwitterStrategy({
    consumerKey: TWITTER_API_KEY,
    consumerSecret: TWITTER_API_SECRET,
    callbackURL: TWITTER_CALLBACK_URL
  }, (token, tokenSecret, profile, done) => {
    return done(null, profile); // Pass the data to the session
  }));
}

// Serialize the Twitter user data into the session
passport.serializeUser((twitterUserData: any, done) => {
  done(null, twitterUserData);
});

// Deserialize the Twitter user data from the session
passport.deserializeUser((twitterUserData: any, done) => {
  done(null, twitterUserData);
});

// The redirect stores the OAuth request token in a session (a new one for a
// visitor without): limited per client network (srv/util/authLimits.ts
// "preLogin")
const xRedirectLimiter = ipRateLimitHandler({
  bucket: 'twitter:start-login',
  ...AUTH_LIMITS.preLogin.xRedirect,
});

// Check getRoutes.ts for the twitter-callback route
twitterRouter.get('/startLogin', (request, response, next) => {
  xRedirectLimiter(request, response).then(() => next(), (e) => {
    if (e instanceof RateLimitError) {
      // a page navigation (the X popup): the popup's page says it
      response.redirect(`/twitter-login?error=rate-limited&retryAfter=${e.retryAfterSeconds}`);
      return;
    }
    handleError(response, e);
  });
}, passport.authenticate("twitter"));

registerPostRoute<
  API.Twitter.finishLogin.Request,
  API.Twitter.finishLogin.Response
>(
  twitterRouter,
  '/finishLogin',
  undefined,
  async (request, response, data) => {
    const user = request?.session?.passport?.user;

    if (!user) {
      throw new Error(errors.server.TWITTER_SESSION_EXPIRED);
    }

    return {
      username: user.username,
      profileImageUrl: user._json.profile_image_url,
      description: user._json.description,
      homepage: user._json.url,
    };
  }
);

// registerPostRoute<
//   API.Twitter.shareJoined.Request,
//   API.Twitter.shareJoined.Response
// >(
//   twitterRouter,
//   '/shareJoined',
//   undefined,
//   async (request, response, data) => {
//     const { user } = request.session;
//     if (!user) {
//       throw new Error(errors.server.LOGIN_REQUIRED);
//     }

//     if (!request.session.twitter || !request.session.twitter.accessToken) {
//       throw new Error(errors.server.TWITTER_TWEET_FAILED);
//     }

//     try {
//       const loggedClient = new TwitterApi(request.session.twitter.accessToken);
//       await loggedClient.v2.tweet("I'm on Common Ground, will you join me? https://app.cg");
//       await userHelper.addUserFeatures(user.id, { twittedInvite: true });
//     } catch (e) {
//       console.log(e);
//       throw new Error(errors.server.TWITTER_TWEET_FAILED);
//     }

//     return { ok: true };
//   }
// );

export default twitterRouter;


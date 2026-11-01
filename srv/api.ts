// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import app from './util/express';
import userRouter from './api/user';
import communityRouter from './api/community';
import messageRouter from './api/messages';
import fileRouter from './api/files';
import chatRouter from './api/chats';
import contractRouter from './api/contracts';
import notificationRouter from './api/notifications';
import getRoutes from './api/getRoutes';
import luksoUniversalProfileRouter from './api/luksoUniversalProfile';
import twitterRouter from './api/twitter';
import cgIdRouter from './api/cgid';
import passkeyRouter from './api/passkeys';
import { isLegacyCgidMode, validatePasskeyConfigAtStartup } from './util/passkeyConfig';
import accountsRouter from './api/accounts';
import { fakeHealthcheck } from './healthcheck';
import imageFilter from './moderation/imageFilter';
import pluginRouter from './api/plugins';
import searchRouter from './api/search';
import reportRouter from './api/report';
import botRouter from './api/bots';
import botV1Router from './api/botV1';
import stakingRouter from './api/staking';
import captchaRouter from './api/captcha';
import instanceRouter from './api/instance';
import feedRouter from './api/feed';
import { apiErrorHandler } from './api/util';
import { securityStepMiddleware } from './util/securityStep';
import { emailEnabled } from './api/emails';
import { validateTransferConfigAtStartup } from './util/transferLink';

// A misconfigured transfer-link target (TRANSFER_TARGET_URL) stops the process.
validateTransferConfigAtStartup();

// Accounts that still have to finish the account-security step (no sign-in
// method that works here, no verified email, a password below the policy)
// reach only the endpoints of that step: the check runs in front of every
// API router and the gated file routes, not in front of the page routes
// (social previews, redirects), which serve HTML (docs/auth-identity §11).
const securityStep = securityStepMiddleware(emailEnabled);

app.use('/Chat', securityStep, chatRouter);
app.use('/Community', securityStep, communityRouter);
app.use('/File', securityStep, fileRouter);
app.use('/Message', securityStep, messageRouter);
app.use('/User', securityStep, userRouter);
app.use('/Contract', securityStep, contractRouter);
app.use('/Notification', securityStep, notificationRouter);
app.use('/Twitter', securityStep, twitterRouter);
app.use('/Lukso', securityStep, luksoUniversalProfileRouter);
// Exactly one passkey surface per process (docs/auth-identity §7): the
// main-origin Passkey API, or — legacy CG ID (gateway) mode — the
// authentication-only CgId API. A bad relying-party configuration stops the
// process here.
validatePasskeyConfigAtStartup();
if (isLegacyCgidMode()) {
  app.use('/CgId', securityStep, cgIdRouter);
}
else {
  app.use('/Passkey', securityStep, passkeyRouter);
}
app.use('/Accounts', securityStep, accountsRouter);
app.use('/Plugins', securityStep, pluginRouter);
app.use('/Search', securityStep, searchRouter);
app.use('/Report', securityStep, reportRouter);
app.use('/Bot', securityStep, botRouter);
app.use('/BotV1', securityStep, botV1Router);
app.use('/Staking', securityStep, stakingRouter);
app.use('/Captcha', securityStep, captchaRouter);
app.use('/Instance', securityStep, instanceRouter);
app.use('/Feed', securityStep, feedRouter);
app.use(['/gated-videos', '/gated-files'], securityStep);
app.use('/', getRoutes);

// Errors handed to next() by middleware — e.g. the session store failing while
// the Valkey state instance is unreachable, or body-parser rejecting a
// malformed/oversized body — get the API's JSON error format instead of
// Express' default HTML error page. Keeps a 4xx status set by the middleware.
app.use(apiErrorHandler);

const shutdown = async (code = 0) => {
  process.exit(code);
}

fakeHealthcheck();

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

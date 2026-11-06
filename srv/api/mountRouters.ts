// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type express from 'express';
import userRouter from './user';
import communityRouter from './community';
import messageRouter from './messages';
import syncStateRouter from './syncState';
import fileRouter from './files';
import chatRouter from './chats';
import contractRouter from './contracts';
import notificationRouter from './notifications';
import getRoutes from './getRoutes';
import luksoUniversalProfileRouter from './luksoUniversalProfile';
import twitterRouter from './twitter';
import cgIdRouter from './cgid';
import passkeyRouter from './passkeys';
import { isLegacyCgidMode, validatePasskeyConfigAtStartup } from '../util/passkeyConfig';
import accountsRouter from './accounts';
import pluginRouter from './plugins';
import searchRouter from './search';
import reportRouter from './report';
import botRouter from './bots';
import botV1Router from './botV1';
import stakingRouter from './staking';
import captchaRouter from './captcha';
import instanceRouter from './instance';
import feedRouter from './feed';
import { securityStepMiddleware } from '../util/securityStep';
import { emailEnabled } from './emails';

/**
 * Every route of the api process, mounted on `app` (srv/api.ts). Kept apart
 * from the process setup so the complete route list can be built from it
 * (srv/tests/gatewayAllowlist.spec.ts checks the gateway allowlist against it).
 */
export function mountApiRouters(app: express.Express): void {
  // Accounts that still have to finish the account-security step (no sign-in
  // method that works here, no verified email, a password below the policy)
  // reach only the endpoints of that step: the check runs in front of every
  // API router and the gated file routes, not in front of the page routes
  // (social previews, redirects), which serve HTML (docs/auth-identity §11).
  const securityStep = securityStepMiddleware(emailEnabled);

  app.use('/Chat', securityStep, chatRouter);
  app.use('/Community', securityStep, communityRouter);
  app.use('/File', securityStep, fileRouter);
  // one mount, so the security step runs once for /Message/getSyncState too
  app.use('/Message', securityStep, messageRouter, syncStateRouter);
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
}

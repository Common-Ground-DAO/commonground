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
import accountsRouter from './api/accounts';
import { fakeHealthcheck } from './healthcheck';
import pluginRouter from './api/plugins';
import searchRouter from './api/search';
import reportRouter from './api/report';
import botRouter from './api/bots';
import botV1Router from './api/botV1';
import stakingRouter from './api/staking';
import captchaRouter from './api/captcha';
import instanceRouter from './api/instance';
import feedRouter from './api/feed';

app.use('/Chat', chatRouter);
app.use('/Community', communityRouter);
app.use('/File', fileRouter);
app.use('/Message', messageRouter);
app.use('/User', userRouter);
app.use('/Contract', contractRouter);
app.use('/Notification', notificationRouter);
app.use('/Twitter', twitterRouter);
app.use('/Lukso', luksoUniversalProfileRouter);
app.use('/CgId', cgIdRouter);
app.use('/Accounts', accountsRouter);
app.use('/Plugins', pluginRouter);
app.use('/Search', searchRouter);
app.use('/Report', reportRouter);
app.use('/Bot', botRouter);
app.use('/BotV1', botV1Router);
app.use('/Staking', stakingRouter);
app.use('/Captcha', captchaRouter);
app.use('/Instance', instanceRouter);
app.use('/Feed', feedRouter);
app.use('/', getRoutes);

const shutdown = async (code = 0) => {
  process.exit(code);
}

fakeHealthcheck();

process.on("SIGTERM", () => shutdown());
process.on("unhandledRejection", (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  shutdown(1);
});
process.on("uncaughtException", (error, origin) => {
  console.error('Uncaught Exception at:', error, 'origin:', origin);
  shutdown(1);
});

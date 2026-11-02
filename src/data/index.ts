// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

// data managers
import communityDB from "./databases/community";
import notificationDB from "./databases/notification";
import userDB from './databases/user';
import signedUrlsDB from './databases/signedUrls';
import chatsDB from './databases/chats';
import channelManager from "./databases/channel";

const data = {
  community: communityDB,
  notification: notificationDB,
  user: userDB,
  signedUrls: signedUrlsDB,
  chats: chatsDB,
  channelManager,
};
export default Object.freeze(data);
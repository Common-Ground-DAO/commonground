// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { Flow } from '../lib/harness.ts';
import { anonymous } from './01-anonymous.ts';
import { auth } from './02-auth.ts';
import { reload } from './03-reload.ts';
import { communityChat } from './04-community-chat.ts';
import { images } from './05-images.ts';
import { settings } from './06-settings.ts';
import { call } from './07-call.ts';
import { articlePlugin } from './08-article-plugin.ts';
import { csCallChat } from './09-cs-call-chat.ts';
import { csUnreadTabs } from './10-cs-unread-tabs.ts';
import { csReconnect } from './11-cs-reconnect.ts';
import { csMultiTab } from './12-cs-multi-tab.ts';
import { csNotifications } from './13-cs-notifications.ts';
import { csLoginTime } from './14-cs-login-time.ts';
import { csSplitFrozen } from './15-cs-split-frozen.ts';

/** every flow, in run order (each is independent; --flow picks a subset) */
export const flows: Flow[] = [
  anonymous,
  auth,
  reload,
  communityChat,
  images,
  settings,
  call,
  articlePlugin,
  csCallChat,
  csUnreadTabs,
  csReconnect,
  csMultiTab,
  csNotifications,
  csLoginTime,
  csSplitFrozen,
];

/**
 * Named groups for --flow (a group name stands for its flows):
 * `chat-sync` is the acceptance set E1–E5, E7, E8 of
 * docs/todo/ROADMAP_chat-sync.md (E6 needs message persistence, which that
 * package does not ship).
 */
export const flowGroups: Record<string, string[]> = {
  'chat-sync': [csCallChat, csUnreadTabs, csReconnect, csMultiTab, csNotifications, csLoginTime, csSplitFrozen].map(flow => flow.id),
};

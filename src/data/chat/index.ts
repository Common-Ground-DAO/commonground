// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * Entry point of the chat-sync store cores (contract: ./types.ts, summary:
 * ./README.md). The façade (data.channelManager / data.notification) builds
 * the stores with the real connectors, the event source and systemClock.
 */

import type messageApi from 'data/api/messages';
import type notificationsApi from 'data/api/notifications';
import type { ChatApi, NotificationApi } from './types';

export { createChannelStore } from './channelStore';
export { createReadStateStore } from './readStateStore';
export { createNotificationStore } from './notificationStore';
export { mergeReadState, emptyReadState, sameReadState } from './mergeReadState';
export { systemClock } from './util';

// compile-time: the connectors can be passed as the injected APIs directly
type Assert<T extends true> = T;
export type MessageApiIsChatApi = Assert<typeof messageApi extends ChatApi ? true : false>;
export type NotificationsApiIsNotificationApi = Assert<typeof notificationsApi extends NotificationApi ? true : false>;

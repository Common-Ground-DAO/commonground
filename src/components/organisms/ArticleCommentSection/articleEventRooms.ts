// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * Event rooms of article comment channels, ref-counted per access.
 *
 * The room is per socket on the server and shared by every comment section of
 * the tab that shows the article, so a section acquires it and releases it on
 * unmount; the room is left only when the last section released it. While
 * held it is joined whenever the socket is live and joined again on every
 * live transition (new socket, or the socket's user changed).
 */

import type { Transport, Unsubscribe } from 'data/appstate/transport';

type ArticleAccess = API.Messages.MessageAccess & { articleId: string };

export type ArticleRoomDeps = {
  transport: Pick<Transport, 'live' | 'onLive'>;
  join: (access: ArticleAccess) => Promise<unknown>;
  leave: (access: ArticleAccess) => Promise<unknown>;
};

type Room = {
  access: ArticleAccess;
  /** sections holding the room */
  count: number;
  /** a join was acked on the socket that is (or was) live */
  joined: boolean;
  /** joins in flight */
  joining: number;
  unsubscribeLive: Unsubscribe | null;
};

export function articleRoomKey(access: ArticleAccess): string {
  const owner = 'articleCommunityId' in access ? `c:${access.articleCommunityId}` : 'articleUserId' in access ? `u:${access.articleUserId}` : '';
  return `${access.articleId}|${access.channelId}|${owner}`;
}

export function createArticleRoomRegistry(deps: ArticleRoomDeps) {
  const rooms = new Map<string, Room>();

  const close = (key: string, room: Room) => {
    // a join in flight settles first and closes the room then
    if (room.count > 0 || room.joining > 0) return;
    if (rooms.get(key) === room) rooms.delete(key);
    const wasJoined = room.joined;
    room.joined = false;
    // not live: the socket that joined is gone
    if (wasJoined && deps.transport.live) {
      deps.leave(room.access).catch(() => {
        console.error('Failed to leave article event room');
      });
    }
  };

  const join = (key: string, room: Room) => {
    if (room.count === 0 || !deps.transport.live) return;
    room.joining++;
    deps.join(room.access)
      .then(() => {
        room.joined = true;
      }, () => {
        console.error('Failed to join article event room');
      })
      .finally(() => {
        room.joining--;
        if (room.count === 0) close(key, room);
      });
  };

  return {
    /** hold the room of `access`; returns its release (idempotent) */
    acquire(access: ArticleAccess): () => void {
      const key = articleRoomKey(access);
      let room = rooms.get(key);
      if (!room) {
        room = { access, count: 0, joined: false, joining: 0, unsubscribeLive: null };
        rooms.set(key, room);
      }
      const held = room;
      held.count++;
      if (held.count === 1) {
        held.unsubscribeLive = deps.transport.onLive(() => join(key, held));
        if (!held.joined && held.joining === 0) join(key, held);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held.count--;
        if (held.count > 0) return;
        held.unsubscribeLive?.();
        held.unsubscribeLive = null;
        close(key, held);
      };
    },
    /** sections holding the room of `access` (tests) */
    holders(access: ArticleAccess): number {
      return rooms.get(articleRoomKey(access))?.count ?? 0;
    },
  };
}

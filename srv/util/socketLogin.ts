// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { PresenceTracker } from './presence';

/** what the end of a socket login needs of a socket.io socket */
export type LoginSocket = {
  readonly id: string;
  readonly connected: boolean;
  readonly rooms: Set<string>;
  leave(room: string): unknown;
  disconnect(close?: boolean): unknown;
};

export type LoginAck = 'OK' | 'ERROR';

/**
 * The end of a socket `login` (wsapi), after `presence.socketAuthenticated`
 * and the room join:
 *
 * - the device key may have become invalid between its verification and the
 *   join (the account signed out its other devices,
 *   srv/util/signOutOtherDevices.ts): answer `ERROR` and disconnect;
 * - the socket may have gone away while the login was in flight.
 *
 * socket.io (4.8) leaves every room at a disconnect and makes a later `join`
 * a no-op, but the socket's disconnect handler only releases the presence
 * when the user id was already set, which it is not for a disconnect before
 * the join. So a socket that is no longer connected leaves whatever rooms it
 * still has (defensive) and releases the presence here, in both cases;
 * otherwise the process would keep the user in its presence set and keep
 * them online. A socket that is still connected is disconnected instead, and
 * its disconnect handler releases the presence.
 *
 * `ack` is called at most once, before any disconnect; a socket that is gone
 * gets no ack.
 */
export async function finishSocketLogin(
  socket: LoginSocket,
  userId: string,
  deps: {
    isLiveDevice: () => Promise<boolean>;
    presence: Pick<PresenceTracker, 'socketGone' | 'userLoggedIn'>;
    ack: (result: LoginAck) => void;
  },
): Promise<void> {
  const releaseGoneSocket = () => {
    for (const roomId of Array.from(socket.rooms)) {
      if (roomId !== socket.id) {
        socket.leave(roomId);
      }
    }
    deps.presence.socketGone(userId);
  };

  if (!(await deps.isLiveDevice())) {
    if (socket.connected) {
      deps.ack('ERROR');
      socket.disconnect(false);
    }
    else {
      releaseGoneSocket();
    }
    return;
  }
  if (!socket.connected) {
    releaseGoneSocket();
    return;
  }
  await deps.presence.userLoggedIn(userId);
  // only acknowledged once identity, room membership and presence are set
  deps.ack('OK');
}

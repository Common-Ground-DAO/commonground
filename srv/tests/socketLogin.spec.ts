// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The end of a socket `login` (`util/socketLogin.ts`, called by wsapi after
 * the room join): a revoked device key and a socket that went away while
 * the login was in flight must not leave the user in the process's presence
 * set (kept online by the periodic touch) or in a room.
 *
 * The presence is the real PresenceTracker; the sockets are a small model of
 * socket.io's, and the first test checks that model's disconnect behaviour
 * against socket.io itself.
 */

import { Server, Socket as IoSocket } from 'socket.io';
import { PresenceTracker, type PresenceDeps } from '../util/presence';
import { finishSocketLogin, type LoginAck } from '../util/socketLogin';

const USER = '00000000-0000-4000-8000-000000000001';
const USER_ROOM = `user:${USER}`;

/** socket.io (4.8): a disconnect leaves every room, a later join is a no-op unless `leakyJoin` */
class FakeSocket {
  static all: FakeSocket[] = [];
  connected = true;
  rooms: Set<string>;
  data: { userId?: string } = {};
  constructor(readonly id: string, private readonly onDisconnect: (socket: FakeSocket) => void, private readonly leakyJoin = false) {
    this.rooms = new Set([id]);
    FakeSocket.all.push(this);
  }
  join(rooms: string[]) {
    if (this.connected || this.leakyJoin) rooms.forEach(room => this.rooms.add(room));
  }
  leave(room: string) {
    this.rooms.delete(room);
  }
  disconnect() {
    if (!this.connected) return;
    this.rooms.clear();
    this.connected = false;
    this.onDisconnect(this);
  }
}

const hasLocalSocket = (userId: string) => FakeSocket.all.some(s => s.rooms.has(`user:${userId}`));

function setup(options: { live: boolean; leakyJoin?: boolean }) {
  const deps = {
    hasLocalSocket: jest.fn(hasLocalSocket),
    probeCluster: jest.fn(async () => ({ present: [], complete: true })),
    markOnline: jest.fn(async (_userId: string) => {}),
    markOffline: jest.fn(async (_userIds: string[]) => {}),
  } satisfies PresenceDeps;
  const presence = new PresenceTracker(deps);
  const gone = jest.spyOn(presence, 'socketGone');
  // wsapi's disconnect handler: releases the presence once the user id is set
  const socket = new FakeSocket('sockAaaaaaaaaaaaaaaa', s => {
    if (s.data.userId) presence.socketGone(s.data.userId);
  }, options.leakyJoin);
  const acks: LoginAck[] = [];
  /** wsapi's login after the device verification, with an optional disconnect before the join */
  const login = async (disconnectBeforeJoin: boolean) => {
    presence.socketAuthenticated(USER);
    if (disconnectBeforeJoin) socket.disconnect();
    socket.data.userId = USER;
    socket.join([USER_ROOM, 'community:c1']);
    await finishSocketLogin(socket, USER, {
      isLiveDevice: async () => options.live,
      presence,
      ack: result => { acks.push(result); },
    });
  };
  return { presence, deps, socket, gone, acks, login };
}

beforeEach(() => {
  jest.useFakeTimers();
  FakeSocket.all = [];
});

afterEach(() => {
  jest.useRealTimers();
});

describe('socket.io semantics the login relies on', () => {
  it('a disconnected socket has left its rooms and cannot join again', () => {
    const io = new Server();
    const nsp = io.of('/');
    const client = {
      conn: { protocol: 4, remoteAddress: '127.0.0.1', secure: false, transport: { name: 'websocket' } },
      request: { headers: {}, url: '/api/ws/', connection: {} },
      _remove: () => undefined,
    };
    const socket = new IoSocket(nsp, client as any, {});
    (socket as any).connected = true;
    socket.join(['a', 'b']);
    expect([...socket.rooms].sort()).toEqual(['a', 'b']);
    (socket as any)._onclose('transport close');
    expect(socket.connected).toBe(false);
    expect([...socket.rooms]).toEqual([]);
    socket.join(['c']);
    expect([...socket.rooms]).toEqual([]);
  });
});

describe('finishSocketLogin', () => {
  it('a live device on a connected socket: online, acknowledged, tracked as connected', async () => {
    const { deps, acks, presence, login } = setup({ live: true });
    await login(false);
    expect(acks).toEqual(['OK']);
    expect(deps.markOnline).toHaveBeenCalledWith(USER);
    expect(presence.touchSets()).toEqual({ connected: [USER], grace: [] });
  });

  it('a revoked device on a connected socket: ERROR, disconnected, presence released by the disconnect handler', async () => {
    const { deps, acks, socket, presence, gone, login } = setup({ live: false });
    await login(false);
    expect(acks).toEqual(['ERROR']);
    expect(socket.connected).toBe(false);
    expect(socket.rooms.size).toBe(0);
    expect(gone).toHaveBeenCalledWith(USER);
    expect(deps.markOnline).not.toHaveBeenCalled();
    expect(presence.isPending(USER)).toBe(true);
  });

  it.each([
    ['live device', true],
    ['revoked device', false],
  ])('%s, socket gone before the join: no ack, no rooms, presence released', async (_name, live) => {
    const { deps, acks, socket, presence, gone, login } = setup({ live });
    await login(true);
    expect(acks).toEqual([]);
    expect(socket.rooms.size).toBe(0);
    expect(gone).toHaveBeenCalledWith(USER);
    expect(deps.markOnline).not.toHaveBeenCalled();
    // the grace period runs, then the user goes offline and is no longer touched
    expect(presence.isPending(USER)).toBe(true);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(deps.markOffline).toHaveBeenCalledWith([USER]);
    expect(presence.touchSets()).toEqual({ connected: [], grace: [] });
  });

  it('a join that still added rooms to a gone socket: the rooms are left again', async () => {
    const { socket, gone, login } = setup({ live: false, leakyJoin: true });
    await login(true);
    expect([...socket.rooms]).toEqual([]);
    expect(hasLocalSocket(USER)).toBe(false);
    expect(gone).toHaveBeenCalledWith(USER);
  });
});

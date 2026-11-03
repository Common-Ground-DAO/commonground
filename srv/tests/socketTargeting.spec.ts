// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Socket-scoped targeting (srv/util/requestSocket.ts): the header helper, and
 * the EventHelper operations run against a small model of the socket.io
 * adapter (rooms per socket; a broadcast reaches the sockets in any target
 * room and in no except room, each once — like the redis adapter applies an
 * emitter request). The sockets join their rooms as wsapi's
 * `joinAuthenticatedRooms` does, so "a socket id of another device / an
 * unknown one names an empty room" is checked end to end.
 */

jest.mock('@socket.io/redis-emitter', () => {
  const world = {
    rooms: new Map<string, Set<string>>(),
    received: new Map<string, { event: string; data: unknown }[]>(),
    disconnected: new Set<string>(),
  };
  const list = (rooms: string | string[]) => (Array.isArray(rooms) ? rooms : [rooms]);
  class Operator {
    constructor(private readonly target = new Set<string>(), private readonly excepted = new Set<string>()) {}
    to(rooms: string | string[]) {
      return new Operator(new Set([...this.target, ...list(rooms)]), this.excepted);
    }
    in(rooms: string | string[]) {
      return this.to(rooms);
    }
    except(rooms: string | string[]) {
      return new Operator(this.target, new Set([...this.excepted, ...list(rooms)]));
    }
    private selected() {
      return [...world.rooms.entries()]
        .filter(([, rooms]) => [...rooms].some(r => this.target.has(r)) && ![...rooms].some(r => this.excepted.has(r)))
        .map(([id]) => id);
    }
    emit(event: string, data: unknown) {
      for (const id of this.selected()) {
        world.received.set(id, [...(world.received.get(id) || []), { event, data }]);
      }
    }
    socketsJoin(rooms: string | string[]) {
      for (const id of this.selected()) {
        for (const room of list(rooms)) world.rooms.get(id)!.add(room);
      }
    }
    socketsLeave(rooms: string | string[]) {
      for (const id of this.selected()) {
        for (const room of list(rooms)) world.rooms.get(id)!.delete(room);
      }
    }
    disconnectSockets() {
      for (const id of this.selected()) {
        world.disconnected.add(id);
        world.rooms.delete(id);
      }
    }
  }
  class Emitter extends Operator {
    constructor() {
      super();
    }
  }
  return { Emitter, __world: world };
});
jest.mock('../redis', () => ({ __esModule: true, default: { getClient: jest.fn(() => ({})) } }));
jest.mock('../repositories/notifications', () => ({ __esModule: true, default: {} }));

import eventHelper from '../repositories/event';
import { deviceSocketRoomKey, getRequestSocketId, requestSockets, senderExcept, SOCKET_ID_HEADER } from '../util/requestSocket';
import { articleRoomKey, deviceRoomKey, userRoomKey } from '../util';

const world = jest.requireMock('@socket.io/redis-emitter').__world as {
  rooms: Map<string, Set<string>>;
  received: Map<string, { event: string; data: unknown }[]>;
  disconnected: Set<string>;
};

const ME = 'user-me';
const OTHER = 'user-other';
const MY_DEVICE = 'device-mine';
const MY_OTHER_DEVICE = 'device-mine-2';
const OTHER_DEVICE = 'device-other';
// socket.io ids: 20 characters of [A-Za-z0-9_-]
const TAB_A = 'tabAaaaaaaaaaaaaaaaa';
const TAB_B = 'tabBbbbbbbbbbbbbbbbb';
const TAB_C = 'tabCcccccccccccccccc';
const TAB_D = 'tabDdddddddddddddddd';
const UNKNOWN = 'unknownSocketId_____';

/** the rooms wsapi's `joinAuthenticatedRooms` joins at socket login */
function socketLogin(socketId: string, userId: string, deviceId: string) {
  world.rooms.set(socketId, new Set([
    socketId,
    deviceRoomKey(deviceId),
    deviceSocketRoomKey(deviceId, socketId),
    userRoomKey(userId),
  ]));
}

/** wsapi's socket `logout`: every room but the socket's own */
function socketLogout(socketId: string) {
  world.rooms.set(socketId, new Set([socketId]));
}

const got = (socketId: string, event: string) => (world.received.get(socketId) || []).filter(e => e.event === event).length;
const message = { type: 'cliMessageEvent', action: 'new', data: { id: 'm1' } } as any;

beforeEach(() => {
  world.rooms.clear();
  world.received.clear();
  world.disconnected.clear();
  // two tabs of my browser, my other browser, someone else
  socketLogin(TAB_A, ME, MY_DEVICE);
  socketLogin(TAB_B, ME, MY_DEVICE);
  socketLogin(TAB_C, ME, MY_OTHER_DEVICE);
  socketLogin(TAB_D, OTHER, OTHER_DEVICE);
});

describe('getRequestSocketId', () => {
  const withHeader = (value: unknown, extra: Record<string, unknown> = {}) => ({ headers: { [SOCKET_ID_HEADER]: value as any }, ...extra });

  it('returns a socket id in the socket.io format', () => {
    expect(getRequestSocketId(withHeader(TAB_A))).toBe(TAB_A);
    expect(getRequestSocketId(withHeader('AbCdEfGhIj0123456_-x'))).toBe('AbCdEfGhIj0123456_-x');
  });

  it('ignores a missing or malformed header', () => {
    expect(getRequestSocketId({ headers: {} })).toBeNull();
    expect(getRequestSocketId({})).toBeNull();
    for (const value of ['', 'a'.repeat(19), 'a'.repeat(21), 'a'.repeat(19) + '.', 'a'.repeat(19) + ' ', `${TAB_A}, ${TAB_B}`, [TAB_A], 42]) {
      expect(getRequestSocketId(withHeader(value))).toBeNull();
    }
  });

  it('ignores the header on bot requests', () => {
    expect(getRequestSocketId(withHeader(TAB_A, { botPrincipal: { kind: 'bot-token' } }))).toBeNull();
  });

  it('senderExcept names the socket, or the whole device without one', () => {
    expect(senderExcept(requestSockets(withHeader(TAB_A), MY_DEVICE))).toEqual({ deviceSockets: [{ deviceId: MY_DEVICE, socketId: TAB_A }] });
    expect(senderExcept(requestSockets({ headers: {} }, MY_DEVICE))).toEqual({ deviceIds: [MY_DEVICE] });
  });
});

describe('echo exclusion', () => {
  const emitToUsers = (except: ReturnType<typeof senderExcept>) => eventHelper.emit(message, { userIds: [ME, OTHER] }, except);

  it('with the sender socket: only that socket misses the event, the other tabs get it', async () => {
    await emitToUsers(senderExcept({ deviceId: MY_DEVICE, socketId: TAB_A }));
    expect(got(TAB_A, 'cliMessageEvent')).toBe(0);
    expect(got(TAB_B, 'cliMessageEvent')).toBe(1);
    expect(got(TAB_C, 'cliMessageEvent')).toBe(1);
    expect(got(TAB_D, 'cliMessageEvent')).toBe(1);
  });

  it("a socket id of another device excludes nobody", async () => {
    await emitToUsers(senderExcept({ deviceId: MY_DEVICE, socketId: TAB_D }));
    for (const tab of [TAB_A, TAB_B, TAB_C, TAB_D]) {
      expect(got(tab, 'cliMessageEvent')).toBe(1);
    }
  });

  it('an unknown socket id excludes nobody', async () => {
    await emitToUsers(senderExcept({ deviceId: MY_DEVICE, socketId: UNKNOWN }));
    for (const tab of [TAB_A, TAB_B, TAB_C, TAB_D]) {
      expect(got(tab, 'cliMessageEvent')).toBe(1);
    }
  });

  it('a logged-out socket is no longer addressed by its id', async () => {
    socketLogout(TAB_A);
    // re-joined someone's room afterwards (e.g. a visitor room): still not excludable
    world.rooms.get(TAB_A)!.add(userRoomKey(OTHER));
    await emitToUsers(senderExcept({ deviceId: MY_DEVICE, socketId: TAB_A }));
    expect(got(TAB_A, 'cliMessageEvent')).toBe(1);
  });

  it('without a socket id the whole device is excluded, as before', async () => {
    await emitToUsers(senderExcept({ deviceId: MY_DEVICE, socketId: null }));
    expect(got(TAB_A, 'cliMessageEvent')).toBe(0);
    expect(got(TAB_B, 'cliMessageEvent')).toBe(0);
    expect(got(TAB_C, 'cliMessageEvent')).toBe(1);
    expect(got(TAB_D, 'cliMessageEvent')).toBe(1);
  });

  it('one emit to overlapping rooms reaches each socket once', async () => {
    await eventHelper.emit(message, { userIds: [ME, OTHER], deviceIds: [MY_DEVICE] });
    expect(got(TAB_A, 'cliMessageEvent')).toBe(1);
    expect(got(TAB_D, 'cliMessageEvent')).toBe(1);
  });
});

describe('article rooms', () => {
  const ARTICLE = 'article-1';
  const inArticle = (socketId: string) => world.rooms.get(socketId)?.has(articleRoomKey(ARTICLE)) ?? false;

  it('a join with the socket id joins only that socket', async () => {
    await eventHelper.requestSocketsJoinRooms({ deviceId: MY_DEVICE, socketId: TAB_A }, { articleIds: [ARTICLE] });
    expect(inArticle(TAB_A)).toBe(true);
    expect(inArticle(TAB_B)).toBe(false);
    await eventHelper.emit(message, { articleIds: [ARTICLE] });
    expect(got(TAB_A, 'cliMessageEvent')).toBe(1);
    expect(got(TAB_B, 'cliMessageEvent')).toBe(0);
  });

  it('a join with a socket id of another device or an unknown one joins nobody', async () => {
    await eventHelper.requestSocketsJoinRooms({ deviceId: MY_DEVICE, socketId: TAB_D }, { articleIds: [ARTICLE] });
    await eventHelper.requestSocketsJoinRooms({ deviceId: MY_DEVICE, socketId: UNKNOWN }, { articleIds: [ARTICLE] });
    for (const tab of [TAB_A, TAB_B, TAB_C, TAB_D]) {
      expect(inArticle(tab)).toBe(false);
    }
  });

  it('closing the article in one tab keeps the other tab in the room', async () => {
    await eventHelper.requestSocketsJoinRooms({ deviceId: MY_DEVICE, socketId: TAB_A }, { articleIds: [ARTICLE] });
    await eventHelper.requestSocketsJoinRooms({ deviceId: MY_DEVICE, socketId: TAB_B }, { articleIds: [ARTICLE] });
    await eventHelper.requestSocketsLeaveRooms({ deviceId: MY_DEVICE, socketId: TAB_A }, { articleIds: [ARTICLE] });
    expect(inArticle(TAB_A)).toBe(false);
    expect(inArticle(TAB_B)).toBe(true);
  });

  it('a leave with a socket id of another device removes nobody', async () => {
    world.rooms.get(TAB_D)!.add(articleRoomKey(ARTICLE));
    await eventHelper.requestSocketsLeaveRooms({ deviceId: MY_DEVICE, socketId: TAB_D }, { articleIds: [ARTICLE] });
    expect(inArticle(TAB_D)).toBe(true);
  });

  it('without a socket id the device joins and leaves, as before', async () => {
    await eventHelper.requestSocketsJoinRooms({ deviceId: MY_DEVICE, socketId: null }, { articleIds: [ARTICLE] });
    expect([inArticle(TAB_A), inArticle(TAB_B), inArticle(TAB_C)]).toEqual([true, true, false]);
    await eventHelper.requestSocketsLeaveRooms({ deviceId: MY_DEVICE, socketId: null }, { articleIds: [ARTICLE] });
    expect([inArticle(TAB_A), inArticle(TAB_B)]).toEqual([false, false]);
  });
});

describe("logout: the device's sockets", () => {
  it('the other sockets are signed out and disconnected; the requesting socket and other devices are not', async () => {
    await eventHelper.logoutDeviceSockets({ deviceId: MY_DEVICE, socketId: TAB_A });
    expect(got(TAB_B, 'cliSignedOut')).toBe(1);
    expect(world.disconnected.has(TAB_B)).toBe(true);
    expect(got(TAB_A, 'cliSignedOut')).toBe(0);
    expect(world.disconnected.has(TAB_A)).toBe(false);
    for (const tab of [TAB_C, TAB_D]) {
      expect(got(tab, 'cliSignedOut')).toBe(0);
      expect(world.disconnected.has(tab)).toBe(false);
    }
  });

  it('with a socket id that is not one of the device: every socket of the device goes', async () => {
    await eventHelper.logoutDeviceSockets({ deviceId: MY_DEVICE, socketId: TAB_D });
    expect([...world.disconnected].sort()).toEqual([TAB_A, TAB_B].sort());
    expect(got(TAB_D, 'cliSignedOut')).toBe(0);
  });

  it('without a socket id (old clients) every socket of the device is disconnected, without cliSignedOut', async () => {
    await eventHelper.logoutDeviceSockets({ deviceId: MY_DEVICE, socketId: null });
    expect([...world.disconnected].sort()).toEqual([TAB_A, TAB_B].sort());
    expect(world.received.size).toBe(0);
  });
});

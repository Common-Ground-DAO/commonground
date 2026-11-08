// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it, vi } from 'vitest';
import { installBrowserEnv, type BrowserEnv, type BrowserEnvOptions } from 'test/env';
import { createFakeIo, NO_ACK, type FakeIo, type FakeSocket } from 'test/fakeSocket';
import { importAsNewTab } from 'test/modules';
import { useDataLayerFakeTimers } from 'test/timers';
import { flushMicrotasks } from 'test/deferred';
import {
  HIDDEN_DISCONNECT_AFTER_MS,
  RESUME_MIN_HIDDEN_MS,
  SOCKET_ID_PATTERN,
  type LiveKind,
  type ResumeReason,
} from './transport';

/*
 * Transport state machine of data/appstate/webSocket.ts (chat-sync [1]):
 * one socket per tab, live only after the socket-login ack, hidden-tab
 * policy with holds, lifecycle reconnects, onLive vs onResume, and the
 * version flag that no longer freezes the socket.
 */

const fake = vi.hoisted(() => ({ io: undefined as FakeIo | undefined }));
vi.mock('socket.io-client', () => ({
  io: (...args: Parameters<FakeIo['io']>) => fake.io!.io(...args),
}));
vi.mock('data/util/device', () => ({
  signApiSecret: async (deviceId: string, secret: string) => ({ deviceId, secret, base64Signature: `sig-${secret}` }),
}));
vi.mock('data/api/user', () => ({
  default: { ensureSession: async () => undefined },
}));

type Tab = Awaited<ReturnType<typeof openTab>>;

// constants of webSocket.ts (it reads `window` at import; checked in openTab)
const SOCKET_LOGIN_ACK_TIMEOUT_MS = 20_000;
const SOCKET_LOGIN_RETRY_MS = [5_000, 15_000, 60_000] as const;

async function openTab(options: BrowserEnvOptions & { deviceId?: string; start?: boolean } = {}) {
  const { deviceId, start = true, ...envOptions } = options;
  fake.io = createFakeIo();
  const env: BrowserEnv = installBrowserEnv({ url: 'https://app.test/', ...envOptions });
  const wsModule = await importAsNewTab(() => import('data/appstate/webSocket'));
  expect(wsModule.SOCKET_LOGIN_ACK_TIMEOUT_MS).toBe(SOCKET_LOGIN_ACK_TIMEOUT_MS);
  expect(wsModule.SOCKET_LOGIN_RETRY_MS).toEqual(SOCKET_LOGIN_RETRY_MS);
  const ws = wsModule.default;
  const lives: LiveKind[] = [];
  const resumes: ResumeReason[] = [];
  const liveChanges: boolean[] = [];
  const states: Common.WebSocketState[] = [];
  const events: string[] = [];
  ws.onLive(kind => lives.push(kind));
  ws.onResume(reason => resumes.push(reason));
  ws.onLiveChange(live => liveChanges.push(live));
  ws.onStateChange = state => { states.push(state); };
  ws.clientEventHandler = (name) => { events.push(name); };
  if (deviceId) {
    await ws.login(deviceId);
  }
  if (start) {
    ws.start();
  }
  return {
    env, ws, lives, resumes, liveChanges, states, events,
    get socket(): FakeSocket {
      return fake.io!.last;
    },
  };
}

/** Lets the fake server answer and the transport's async steps (dynamic import, signing) run. */
async function settle(tab: Tab, rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await flushMicrotasks();
    if (fake.io!.sockets.length > 0) await tab.socket.settle();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

describe('live = connected and socket login acked', () => {
  it('connect -> login ack -> live (established)', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ deviceId: 'dev-1' });
    expect(tab.ws.live).toBe(false);
    await settle(tab);

    expect(tab.socket.loginCount).toBe(1);
    expect(tab.socket.sentOf('login')[0].args[0]).toEqual({ deviceId: 'dev-1', secret: 'secret-1', base64Signature: 'sig-secret-1' });
    expect(tab.ws.live).toBe(true);
    expect(tab.ws.state).toBe('connected');
    expect(tab.lives).toEqual(['established']);
    expect(tab.states).toEqual(['connecting', 'connected']);
  });

  it('events before the login ack are delivered but do not count as live', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ deviceId: 'dev-1' });
    await flushMicrotasks();
    // no handler: the ack waits in pendingAcks for respond()
    tab.socket.handle('login', undefined);
    await settle(tab);

    expect(tab.socket.connected).toBe(true);
    tab.socket.deliver('cliMessageEvent', { action: 'new' });
    expect(tab.events).toEqual(['cliMessageEvent']);
    expect(tab.ws.live).toBe(false);
    expect(tab.ws.state).toBe('connecting');
    expect(tab.lives).toEqual([]);

    tab.socket.respond('login', 'OK');
    await settle(tab);
    expect(tab.ws.live).toBe(true);
    expect(tab.lives).toEqual(['established']);
  });

  it('login() resolves only after the ack and rejects after the ack timeout', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab();
    await settle(tab);
    expect(tab.lives).toEqual(['established']); // anonymous

    tab.socket.handle('login', () => NO_ACK);
    let settled: string | undefined;
    tab.ws.login('dev-1').then(() => { settled = 'resolved'; }, (e: Error) => { settled = e.message; });
    await settle(tab);
    expect(settled).toBeUndefined();
    expect(tab.ws.live).toBe(false);

    // the server answers again from now on
    tab.socket.handle('login', () => 'OK');
    await vi.advanceTimersByTimeAsync(SOCKET_LOGIN_ACK_TIMEOUT_MS);
    await settle(tab);
    expect(settled).toBe('socket login timed out');
    // one timeout: the login is retried after the (randomised) first backoff, on the same connection
    await vi.advanceTimersByTimeAsync(SOCKET_LOGIN_RETRY_MS[0] * 1.5);
    await settle(tab);
    expect(tab.ws.live).toBe(true);
    expect(tab.lives).toEqual(['established', 'user']);
    expect(fake.io!.last.sentOf('login')).toHaveLength(2);
  });

  it('ack timeouts back off and reconnect only after two in a row (no storm)', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ start: false });
    await tab.ws.login('dev-1');
    tab.ws.start();
    await flushMicrotasks();
    let connects = 0;
    tab.socket.on('connect', () => { connects++; });
    tab.socket.handle('login', () => NO_ACK);
    for (let i = 0; i < 300; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      await settle(tab, 1);
    }
    // 5 minutes of an unanswering server: a handful of attempts, not one per 10 s
    expect(tab.socket.sentOf('login').length).toBeLessThanOrEqual(7);
    expect(connects).toBeLessThanOrEqual(4);
    expect(connects).toBeGreaterThanOrEqual(1);
    expect(tab.ws.live).toBe(false);
  });

  it('the first timeout retries the login, the second one restarts the connection', async () => {
    useDataLayerFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter
    const tab = await openTab({ deviceId: 'dev-1' });
    await settle(tab);
    tab.socket.handle('login', () => NO_ACK);
    tab.socket.drop('transport close');
    tab.socket.accept();
    await settle(tab);
    const connectsBefore = tab.socket.sentOf('cgPing').length;
    await vi.advanceTimersByTimeAsync(SOCKET_LOGIN_ACK_TIMEOUT_MS + SOCKET_LOGIN_RETRY_MS[0]);
    await settle(tab);
    // retried on the same connection
    expect(tab.socket.sentOf('login')).toHaveLength(3);
    expect(tab.socket.sentOf('cgPing').length).toBe(connectsBefore);
    await vi.advanceTimersByTimeAsync(SOCKET_LOGIN_ACK_TIMEOUT_MS + SOCKET_LOGIN_RETRY_MS[1]);
    await settle(tab);
    // a new connection (its connect pings) and a new login on it
    expect(tab.socket.sentOf('cgPing').length).toBeGreaterThan(connectsBefore);
    expect(tab.socket.sentOf('login')).toHaveLength(4);
    vi.mocked(Math.random).mockRestore();
  });

  it('a device signature that never settles times out instead of blocking later logins', async () => {
    useDataLayerFakeTimers();
    const device = await import('data/util/device');
    const sign = vi.spyOn(device, 'signApiSecret').mockImplementationOnce(() => new Promise(() => undefined));
    const tab = await openTab();
    await settle(tab);
    const first = tab.ws.login('dev-1').catch((e: Error) => e.message);
    await settle(tab);
    await vi.advanceTimersByTimeAsync(SOCKET_LOGIN_ACK_TIMEOUT_MS);
    expect(await first).toBe('device signature timed out');
    await tab.ws.login('dev-1');
    expect(tab.ws.live).toBe(true);
    sign.mockRestore();
  });

  it('an anonymous tab is live once connected, after re-sending its socket-scoped joins', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ start: false });
    tab.ws.watchCgIdRequest('req-1');
    let sentAtLive: string[] = [];
    tab.ws.onLive(() => { sentAtLive = tab.socket.sent.map(p => p.event); });
    tab.ws.start();
    await settle(tab);
    expect(tab.ws.live).toBe(true);
    expect(sentAtLive).toContain('watchCgIdRequest');
    expect(tab.socket.loginCount).toBe(0);
  });

  it('SECURITY_STEP_REQUIRED is not live and shows the security step', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab();
    await settle(tab);
    const { default: securityStepState } = await import('data/auth/securityStep');
    tab.socket.loginResult = 'SECURITY_STEP_REQUIRED';
    await expect(tab.ws.login('dev-1')).rejects.toThrow('SECURITY_STEP_REQUIRED');
    expect(tab.ws.live).toBe(false);
    expect(securityStepState.required).toBe(true);

    // a visibility return does not ask again on the same connection
    tab.env.hide();
    tab.env.show();
    await settle(tab);
    expect(tab.socket.loginCount).toBe(1);
  });

  it('ERROR is not live; the socket login is retried with a backoff', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab();
    await settle(tab);
    tab.socket.loginResult = 'ERROR';
    await expect(tab.ws.login('dev-1')).rejects.toThrow('ERROR');
    expect(tab.ws.live).toBe(false);
    // retried with backoff while visible
    tab.socket.loginResult = 'OK';
    await vi.advanceTimersByTimeAsync(SOCKET_LOGIN_RETRY_MS[0] * 1.5);
    await settle(tab);
    expect(tab.ws.live).toBe(true);
    expect(tab.lives).toEqual(['established', 'user']);
  });

  it('a login, user switch and logout on a live socket go through not-live to live(user)', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ deviceId: 'dev-1' });
    await settle(tab);
    tab.liveChanges.length = 0;

    await tab.ws.login('dev-2');
    expect(tab.socket.sentOf('logout')).toHaveLength(1);
    expect(tab.socket.loginCount).toBe(2);
    expect(tab.liveChanges).toEqual([false, true]);

    tab.ws.logout();
    await settle(tab);
    expect(tab.socket.sentOf('logout')).toHaveLength(2);
    expect(tab.ws.live).toBe(true);
    expect(tab.lives).toEqual(['established', 'user', 'user']);
    expect(tab.socket.connected).toBe(true);
  });
});

describe('device signed out', () => {
  it('drops the device: the reconnect after the server disconnect stays anonymous', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ deviceId: 'dev-1' });
    await settle(tab);
    tab.socket.loginResult = 'ERROR'; // the key is gone on the server
    tab.ws.deviceSignedOut('dev-1');
    tab.socket.drop('io server disconnect');
    await settle(tab);
    tab.env.hide();
    tab.env.show();
    tab.env.goOnline();
    await vi.advanceTimersByTimeAsync(SOCKET_LOGIN_RETRY_MS[2] * 2);
    await settle(tab);
    expect(tab.socket.loginCount).toBe(1);
    expect(tab.socket.connected).toBe(true);
    expect(tab.ws.live).toBe(true);
  });

  it('a no-op for another device', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ deviceId: 'dev-2' });
    await settle(tab);
    tab.ws.deviceSignedOut('dev-1');
    tab.socket.drop('transport close');
    tab.socket.accept();
    await settle(tab);
    expect(tab.socket.loginCount).toBe(2);
    expect(tab.socket.sentOf('login')[1].args[0]).toMatchObject({ deviceId: 'dev-2' });
  });

  it('an ERROR answer for a device dropped while its login ran is no error and not retried', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ deviceId: 'dev-1' });
    await flushMicrotasks();
    tab.socket.handle('login', undefined); // the ack waits for respond()
    await settle(tab);
    expect(tab.socket.sentOf('login')).toHaveLength(1);
    const errors = vi.spyOn(console, 'error');
    try {
      tab.ws.deviceSignedOut('dev-1');
      tab.socket.respond('login', 'ERROR');
      await settle(tab);
      await vi.advanceTimersByTimeAsync(SOCKET_LOGIN_RETRY_MS[0] * 2);
      await settle(tab);
      expect(errors).not.toHaveBeenCalled();
      expect(tab.socket.sentOf('login')).toHaveLength(1);
      expect(tab.ws.live).toBe(true); // anonymous
    } finally {
      errors.mockRestore();
    }
  });
});

describe('reconnect', () => {
  it('a reconnect does the socket login only and fires restored', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ deviceId: 'dev-1' });
    await settle(tab);

    tab.socket.drop('transport close');
    expect(tab.ws.live).toBe(false);
    expect(tab.ws.state).toBe('connecting');
    tab.socket.accept();
    await settle(tab);

    expect(tab.socket.loginCount).toBe(2);
    expect(tab.lives).toEqual(['established', 'restored']);
    expect(tab.liveChanges).toEqual([true, false, true]);
    expect(fake.io!.sockets).toHaveLength(1);
  });

  it('reconnects itself after a server disconnect', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ deviceId: 'dev-1' });
    await settle(tab);
    tab.socket.drop('io server disconnect');
    await settle(tab);
    expect(tab.ws.live).toBe(true);
    expect(tab.lives).toEqual(['established', 'restored']);
  });
});

describe('hidden-tab policy', () => {
  it('a hidden tab disconnects after HIDDEN_DISCONNECT_AFTER_MS and does not reconnect while hidden', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ deviceId: 'dev-1' });
    await settle(tab);

    tab.env.hide();
    await vi.advanceTimersByTimeAsync(HIDDEN_DISCONNECT_AFTER_MS - 1);
    expect(tab.socket.connected).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(tab.socket.connected).toBe(false);
    expect(tab.socket.active).toBe(false);
    expect(tab.ws.state).toBe('disconnected');

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    tab.env.goOffline();
    tab.env.goOnline();
    await settle(tab);
    expect(tab.socket.active).toBe(false);
    expect(tab.lives).toEqual(['established']);
  });

  it('a hold keeps the socket while hidden; after its release the timer starts', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ deviceId: 'dev-1' });
    await settle(tab);

    const hold = tab.ws.holdSocket('call');
    tab.env.hide();
    await vi.advanceTimersByTimeAsync(3 * HIDDEN_DISCONNECT_AFTER_MS);
    expect(tab.socket.connected).toBe(true);

    hold.release();
    hold.release(); // exactly once
    await vi.advanceTimersByTimeAsync(HIDDEN_DISCONNECT_AFTER_MS - 1);
    expect(tab.socket.connected).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(tab.socket.connected).toBe(false);
  });

  it('a hold taken while hidden stops the running timer', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ deviceId: 'dev-1' });
    await settle(tab);
    tab.env.hide();
    await vi.advanceTimersByTimeAsync(HIDDEN_DISCONNECT_AFTER_MS - 1000);
    const hold = tab.ws.holdSocket('call');
    await vi.advanceTimersByTimeAsync(HIDDEN_DISCONNECT_AFTER_MS);
    expect(tab.socket.connected).toBe(true);
    hold.release();
  });

  it('freeze and pagehide close the socket regardless of holds', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ deviceId: 'dev-1' });
    await settle(tab);
    tab.ws.holdSocket('call');
    tab.env.freeze();
    expect(tab.socket.connected).toBe(false);
    expect(tab.socket.active).toBe(false);

    tab.env.resume();
    await settle(tab);
    expect(tab.ws.live).toBe(true);
    tab.env.pagehide(false);
    expect(tab.socket.connected).toBe(false);
    expect(tab.socket.active).toBe(false);
  });

  it('a tab opened hidden connects and then closes after the timeout', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ deviceId: 'dev-1', visibilityState: 'hidden' });
    await settle(tab);
    expect(tab.ws.live).toBe(true);
    await vi.advanceTimersByTimeAsync(HIDDEN_DISCONNECT_AFTER_MS);
    expect(tab.socket.connected).toBe(false);
  });
});

describe('returning tabs reconnect', () => {
  async function closedByPolicy() {
    const tab = await openTab({ deviceId: 'dev-1' });
    await settle(tab);
    tab.env.hide();
    await vi.advanceTimersByTimeAsync(HIDDEN_DISCONNECT_AFTER_MS);
    expect(tab.socket.active).toBe(false);
    return tab;
  }

  it('on becoming visible', async () => {
    useDataLayerFakeTimers();
    const tab = await closedByPolicy();
    tab.env.show();
    await settle(tab);
    expect(tab.ws.live).toBe(true);
    expect(tab.lives).toEqual(['established', 'restored']);
    expect(tab.resumes).toEqual([]);
  });

  it('on a bfcache restore (resume, pageshow persisted, visible): one reconnect, no resume signal', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ deviceId: 'dev-1' });
    await settle(tab);
    tab.env.enterBfcache();
    expect(tab.socket.active).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    tab.env.restoreFromBfcache();
    await settle(tab);
    expect(tab.lives).toEqual(['established', 'restored']);
    expect(tab.socket.loginCount).toBe(2);
    expect(tab.resumes).toEqual([]);
  });

  it('on pageshow (persisted) of a visible page', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ deviceId: 'dev-1' });
    await settle(tab);
    tab.env.pagehide(true);
    tab.env.pageshow(true);
    await settle(tab);
    expect(tab.lives).toEqual(['established', 'restored']);
  });

  it('on resume after freeze', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ deviceId: 'dev-1' });
    await settle(tab);
    tab.env.freeze();
    tab.env.resume();
    await settle(tab);
    expect(tab.lives).toEqual(['established', 'restored']);
  });

  it('on online: skips the reconnect backoff', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ deviceId: 'dev-1' });
    await settle(tab);
    tab.socket.drop('transport close');
    tab.env.goOffline();
    expect(tab.ws.state).toBe('disconnected');
    tab.env.goOnline();
    await settle(tab);
    expect(tab.ws.live).toBe(true);
    expect(tab.lives).toEqual(['established', 'restored']);
  });
});

describe('onLive vs onResume', () => {
  it('a socket that stayed live asks for a catch-up after a long hide, not after a short one', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ deviceId: 'dev-1' });
    await settle(tab);

    tab.env.hide();
    await vi.advanceTimersByTimeAsync(RESUME_MIN_HIDDEN_MS - 1);
    tab.env.show();
    expect(tab.resumes).toEqual([]);

    tab.env.hide();
    await vi.advanceTimersByTimeAsync(RESUME_MIN_HIDDEN_MS);
    tab.env.show();
    expect(tab.resumes).toEqual(['visible']);
    expect(tab.lives).toEqual(['established']);
  });

  it('pageshow, resume and online with a live socket are resume signals only', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ deviceId: 'dev-1' });
    await settle(tab);
    tab.env.pageshow(true);
    tab.env.resume();
    tab.env.goOffline();
    tab.env.goOnline();
    expect(tab.resumes).toEqual(['pageshow', 'resume', 'online']);
    expect(tab.lives).toEqual(['established']);
  });

  it('never both for one occasion: a hide that outlasts the timeout gives live(restored) only', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ deviceId: 'dev-1' });
    await settle(tab);
    tab.env.hide();
    await vi.advanceTimersByTimeAsync(HIDDEN_DISCONNECT_AFTER_MS + RESUME_MIN_HIDDEN_MS);
    tab.env.show();
    await settle(tab);
    expect(tab.lives).toEqual(['established', 'restored']);
    expect(tab.resumes).toEqual([]);
  });
});

describe('version update', () => {
  it('sets updateAvailable once and keeps pings, reconnects and the socket login working', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ deviceId: 'dev-1' });
    await settle(tab);
    const updates = vi.fn();
    tab.ws.onUpdateAvailable(updates);

    tab.socket.deliver('buildId', 'another-build', Date.now());
    tab.socket.deliver('buildId', 'another-build', Date.now());
    expect(tab.ws.updateAvailable).toBe(true);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(tab.ws.state).toBe('connected');

    const pings = tab.socket.sentOf('cgPing').length;
    await vi.advanceTimersByTimeAsync(59_000);
    expect(tab.socket.sentOf('cgPing').length).toBe(pings + 1);

    tab.socket.drop('transport close');
    tab.socket.accept();
    await settle(tab);
    expect(tab.socket.loginCount).toBe(2);
    expect(tab.ws.state).toBe('connected');
    expect(tab.lives).toEqual(['established', 'restored']);

    tab.ws.setTyping({ channelId: 'c1' } as API.Messages.MessageAccess, true);
    expect(tab.socket.sentOf('setTyping')).toHaveLength(1);
  });

  it('the same build sets nothing', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab();
    await settle(tab);
    const { default: buildId } = await import('common/buildId');
    tab.socket.deliver('buildId', buildId, Date.now());
    expect(tab.ws.updateAvailable).toBe(false);
  });
});

describe('request socket id', () => {
  it('is the connected socket id, else a fallback in the same format that is no socket', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab({ start: false });
    const { getRequestSocketId } = await import('data/appstate/requestSocketId');
    const fallback = tab.ws.getRequestSocketId();
    expect(fallback).toMatch(SOCKET_ID_PATTERN);
    tab.ws.start();
    await settle(tab);
    expect(tab.ws.getRequestSocketId()).toBe(tab.socket.id);
    expect(getRequestSocketId()).toBe(tab.socket.id);
    tab.socket.drop('transport close');
    expect(tab.ws.getRequestSocketId()).toBe(fallback);
  });
});

describe('no tab roles', () => {
  it('never opens CG_WEBSOCKET_STATE', async () => {
    useDataLayerFakeTimers();
    const opened: string[] = [];
    const tab = await openTab({ start: false });
    const Tracked = globalThis.BroadcastChannel;
    globalThis.BroadcastChannel = class extends Tracked {
      constructor(name: string) {
        super(name);
        opened.push(name);
      }
    } as typeof BroadcastChannel;
    const legacy = new Tracked('CG_WEBSOCKET_STATE');
    const received: unknown[] = [];
    legacy.onmessage = (event) => received.push(event.data);

    tab.ws.start();
    await settle(tab);
    tab.env.hide();
    tab.env.show();
    await vi.advanceTimersByTimeAsync(5_000);
    await settle(tab);

    expect(opened).not.toContain('CG_WEBSOCKET_STATE');
    expect(received).toEqual([]);
    legacy.close();
  });
});

describe('gateway instance', () => {
  it('opens no data socket on a gateway (docs/auth-identity §12), whatever the tab does', async () => {
    useDataLayerFakeTimers();
    const g = globalThis as { __CG_INSTANCE__?: unknown };
    g.__CG_INSTANCE__ = { deployment: 'prod', appUrl: 'https://app.test', gatewayTargetUrl: 'https://new.test' };
    try {
      const tab = await openTab({ deviceId: 'device-1' });
      await settle(tab);
      tab.env.hide();
      tab.env.show();
      tab.env.goOffline();
      tab.env.goOnline();
      tab.env.enterBfcache();
      tab.env.restoreFromBfcache();
      await tab.ws.login('device-2');
      await settle(tab);
      expect(fake.io!.sockets).toHaveLength(0);
      expect(tab.ws.state).toBe('disconnected');
      expect(tab.ws.live).toBe(false);
      expect(tab.lives).toEqual([]);
      expect(tab.resumes).toEqual([]);
    }
    finally {
      delete g.__CG_INSTANCE__;
    }
  });
});

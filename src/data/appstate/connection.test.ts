// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it, vi } from 'vitest';
import { installBrowserEnv } from 'test/env';
import { createFakeIo, NO_ACK, type FakeIo } from 'test/fakeSocket';
import { importAsNewTab } from 'test/modules';
import { useDataLayerFakeTimers } from 'test/timers';
import { flushMicrotasks } from 'test/deferred';

/** REFRESH_AFTER_RESTORE_DEBOUNCE_MS of connection.ts (which reads `window` at import) */
const REFRESH_AFTER_RESTORE_DEBOUNCE_MS = 1_000;

/*
 * connectionManager on top of the transport: the old app events fire on
 * live (after the socket-login ack), the HTTP device login runs once per
 * page load (reconnects only log the socket in), a restored live refreshes
 * the community/chat data, the version flag triggers the service-worker
 * update, and the shims (tabState, lastDisconnect) keep working.
 */

// stable objects: a mocked module may be served from the mock cache across
// importAsNewTab, so the tests reset their fields instead of replacing them
const fake = vi.hoisted(() => ({
  io: undefined as FakeIo | undefined,
  loginManager: {} as Record<string, any>,
  serviceWorkerManager: {} as Record<string, any>,
}));
vi.mock('socket.io-client', () => ({
  io: (...args: Parameters<FakeIo['io']>) => fake.io!.io(...args),
}));
vi.mock('data/util/device', () => ({
  signApiSecret: async (deviceId: string, secret: string) => ({ deviceId, secret, base64Signature: 'sig' }),
}));
vi.mock('data/api/user', () => ({ default: { ensureSession: async () => undefined } }));
vi.mock('data/appstate/login', () => ({ default: fake.loginManager }));
vi.mock('data/appstate/serviceWorker', () => ({ default: fake.serviceWorkerManager }));
vi.mock('data/databases/dbTracker', () => ({ default: { deleteOldIndexedDbs: async () => undefined } }));

/** Opens a tab; its first connect is accepted once the handlers are in place (unless `accept: false`). */
async function openTab(deviceId?: string, options: { accept?: boolean } = {}) {
  fake.io = createFakeIo({ autoAccept: false });
  const env = installBrowserEnv({ url: 'https://app.test/' });
  Object.assign(fake.loginManager, {
    state: 'pending',
    onStateChange: undefined,
    onError: undefined,
    autoLogin: vi.fn(async () => undefined),
    checkLoginStatus: vi.fn(async () => undefined),
    refreshAfterReconnect: vi.fn(async () => undefined),
    triggerSafeWindowReload: vi.fn(),
  });
  Object.assign(fake.serviceWorkerManager, { state: 'none', update: vi.fn(), finishSwInstallation: vi.fn() });
  const connectionModule = await importAsNewTab(() => import('data/appstate/connection'));
  expect(connectionModule.REFRESH_AFTER_RESTORE_DEBOUNCE_MS).toBe(REFRESH_AFTER_RESTORE_DEBOUNCE_MS);
  const connectionManager = connectionModule.default;
  const { default: ws } = await import('data/appstate/webSocket');
  if (deviceId) await ws.login(deviceId);
  const appEvents: string[] = [];
  for (const type of ['cliConnectionEstablished', 'cliConnectionRestored', 'cliConnectionLost'] as const) {
    connectionManager.registerClientEventHandler(type, () => appEvents.push(type));
  }
  await settle();
  expect(fake.io.sockets).toHaveLength(1);
  if (options.accept !== false) {
    fake.io.last.accept();
  }
  return { env, connectionManager, ws, appEvents, get socket() { return fake.io!.last; } };
}

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await flushMicrotasks();
    if (fake.io && fake.io.sockets.length > 0) await fake.io.last.settle();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

describe('connectionManager', () => {
  it('starts the transport once the login manager is loaded and emits established after the login ack', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab('dev-1', { accept: false });
    tab.socket.handle('login', undefined);
    tab.socket.accept();
    await settle();

    expect(tab.connectionManager.webSocketState).toBe('connecting');
    expect(tab.appEvents).toEqual([]);
    tab.socket.respond('login', 'OK');
    await settle();
    expect(tab.appEvents).toEqual(['cliConnectionEstablished']);
    expect(tab.connectionManager.webSocketState).toBe('connected');
  });

  it('runs the HTTP device login once per page load; a reconnect logs only the socket in', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab('dev-1');
    await settle();
    expect(fake.loginManager.autoLogin).toHaveBeenCalledTimes(1);

    tab.socket.drop('transport close');
    tab.socket.accept();
    await settle();
    tab.socket.drop('io server disconnect');
    // the transport reconnects by itself (FakeSocket waits for the accept)
    expect(tab.socket.active).toBe(true);
    tab.socket.accept();
    await settle();

    expect(fake.loginManager.autoLogin).toHaveBeenCalledTimes(1);
    expect(tab.socket.loginCount).toBe(3);
    expect(tab.appEvents).toEqual(['cliConnectionEstablished', 'cliConnectionRestored', 'cliConnectionRestored']);
  });

  it('refreshes community/chat data (debounced) after a restored live, not after established', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab('dev-1');
    await settle();
    await vi.advanceTimersByTimeAsync(REFRESH_AFTER_RESTORE_DEBOUNCE_MS * 2);
    expect(fake.loginManager.refreshAfterReconnect).not.toHaveBeenCalled();

    for (let i = 0; i < 2; i++) {
      tab.socket.drop('transport close');
      tab.socket.accept();
      await settle();
    }
    await vi.advanceTimersByTimeAsync(REFRESH_AFTER_RESTORE_DEBOUNCE_MS);
    expect(fake.loginManager.refreshAfterReconnect).toHaveBeenCalledTimes(1);
  });

  it('emits cliConnectionLost when the socket is closed by policy', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab('dev-1');
    await settle();
    tab.env.freeze();
    expect(tab.connectionManager.webSocketState).toBe('disconnected');
    expect(tab.appEvents).toEqual(['cliConnectionEstablished', 'cliConnectionLost']);
  });

  it('an available update triggers the service-worker update and keeps the state connected', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab('dev-1');
    await settle();
    const listener = vi.fn();
    tab.connectionManager.addListener('updateAvailableChange', listener);
    tab.socket.deliver('buildId', 'newer', Date.now());
    await settle();
    expect(fake.serviceWorkerManager.update).toHaveBeenCalledWith(true);
    expect(listener).toHaveBeenCalledWith(true);
    expect(tab.connectionManager.updateAvailable).toBe(true);
    expect(tab.connectionManager.webSocketState).toBe('connected');
  });

  it('shims: tabState is always active, lastDisconnect moves on every disconnect', async () => {
    useDataLayerFakeTimers();
    const tab = await openTab('dev-1');
    await settle();
    expect(tab.connectionManager.tabState).toBe('active');
    const before = tab.connectionManager.lastDisconnect.getTime();
    await vi.advanceTimersByTimeAsync(60_000);
    tab.socket.handle('login', () => NO_ACK);
    tab.socket.drop('transport close');
    const after = tab.connectionManager.lastDisconnect.getTime();
    // the last event before the gap, at most 30 s before the disconnect
    expect(after).toBeGreaterThan(before);
    expect(after).toBe(Date.now() - 30_000);
  });
});

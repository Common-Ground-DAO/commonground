// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserEnv } from './env';
import { createBrowserEnv, currentBrowserEnv, FakeLockManager, installBrowserEnv } from './env';
import { deferred, flushMicrotasks } from './deferred';

describe('installBrowserEnv', () => {
  it('installs window, document, navigator and the storages as globals', () => {
    const env = installBrowserEnv();
    expect(globalThis.window).toBe(env.window);
    expect(globalThis.document).toBe(env.document);
    expect(navigator.onLine).toBe(true);
    expect(window.location.href).toBe('http://localhost:3000/');
    localStorage.setItem('a', '1');
    expect(window.localStorage.getItem('a')).toBe('1');
    expect(sessionStorage.getItem('a')).toBeNull();
    expect(currentBrowserEnv()).toBe(env);
  });

  it('is torn down after each test', () => {
    // the previous test's env is gone, including its storage
    expect(currentBrowserEnv()).toBeUndefined();
    expect((globalThis as { document?: unknown }).document).toBeUndefined();
    const env = installBrowserEnv();
    expect(env.localStorage.getItem('a')).toBeNull();
  });

  it('refuses a second install', () => {
    installBrowserEnv();
    expect(() => installBrowserEnv()).toThrow(/already installed/);
  });

  it('fires visibilitychange only on a change', () => {
    const env = installBrowserEnv();
    const seen: string[] = [];
    document.addEventListener('visibilitychange', () => seen.push(document.visibilityState));
    env.hide();
    env.hide();
    env.show();
    expect(seen).toEqual(['hidden', 'visible']);
    expect(document.hidden).toBe(false);
  });

  it('runs the page lifecycle in Chrome order with persisted flags', () => {
    const env = installBrowserEnv();
    const seen: string[] = [];
    const log = (e: Event) => seen.push(`${e.type}${'persisted' in e ? `:${(e as PageTransitionEvent).persisted}` : ''}`);
    for (const type of ['pagehide', 'pageshow', 'online', 'offline']) window.addEventListener(type, log);
    for (const type of ['visibilitychange', 'freeze', 'resume']) document.addEventListener(type, log);

    env.enterBfcache();
    env.restoreFromBfcache();
    env.pagehide();
    env.goOffline();
    expect(navigator.onLine).toBe(false);
    env.goOnline();

    expect(seen).toEqual([
      'visibilitychange', 'pagehide:true', 'freeze',
      'resume', 'pageshow:true', 'visibilitychange',
      'pagehide:false', 'offline', 'online',
    ]);
  });

  it('fires storage events and resets state but keeps listeners', () => {
    const env = installBrowserEnv({ visibilityState: 'hidden', onLine: false });
    const keys: (string | null)[] = [];
    window.addEventListener('storage', e => keys.push((e as StorageEvent).key));
    env.storageEvent({ key: 'logout', newValue: '1' });
    env.localStorage.setItem('x', 'y');
    env.show();
    env.goOnline();
    env.reset();
    expect(document.visibilityState).toBe('hidden');
    expect(navigator.onLine).toBe(false);
    expect(localStorage.length).toBe(0);
    env.storageEvent({ key: null });
    expect(keys).toEqual(['logout', null]);
  });

  it('delivers BroadcastChannel messages between instances and closes them on uninstall', async () => {
    const env = installBrowserEnv();
    const a = new BroadcastChannel('cg-test');
    const b = new BroadcastChannel('cg-test');
    const got = deferred<unknown>();
    b.onmessage = e => got.resolve(e.data);
    a.postMessage({ type: 'logout' });
    expect(await got.promise).toEqual({ type: 'logout' });
    env.uninstall();
    expect(() => a.postMessage('late')).toThrow();
  });

  it('uses Node\'s real Web Locks only when asked to', async () => {
    const env = installBrowserEnv({ locks: 'real' });
    expect(env.fakeLocks).toBe(false);
    expect(() => env.closeTab()).toThrow(/real Web Locks/);
    expect(await navigator.locks.request('cg:test', async lock => lock?.name)).toBe('cg:test');
  });
});

describe('Web Locks across tabs', () => {
  it('lets two tabs contend for one lock; closeTab() releases the closed tab\'s locks', async () => {
    const tabA = installBrowserEnv();
    const tabB = createBrowserEnv();
    expect(tabA.fakeLocks).toBe(true);
    expect(navigator.locks).toBe(tabA.locks);
    const order: string[] = [];
    void tabA.locks.request('cg:login', () => {
      order.push('A holds');
      return new Promise(() => {}); // the tab dies while holding the lock
    });
    const b = tabB.locks.request('cg:login', () => order.push('B holds'));
    await flushMicrotasks();
    expect(order).toEqual(['A holds']);
    const snapshot = await tabB.locks.query();
    expect(snapshot.held).toEqual([{ name: 'cg:login', mode: 'exclusive', clientId: tabA.clientId }]);
    expect(snapshot.pending).toEqual([{ name: 'cg:login', mode: 'exclusive', clientId: tabB.clientId }]);

    tabA.closeTab();
    await b;
    expect(order).toEqual(['A holds', 'B holds']);
  });

  it('closeTab() rejects the tab\'s pending requests', async () => {
    const tabA = createBrowserEnv();
    const tabB = createBrowserEnv();
    void tabA.locks.request('l', () => new Promise(() => {}));
    const pending = tabB.locks.request('l', () => 'never');
    await flushMicrotasks();
    tabB.closeTab();
    await expect(pending).rejects.toThrow(/released/);
  });

  it('a lock left held by the previous test is free again (per-test reset)', async () => {
    const tab = createBrowserEnv();
    expect(await tab.locks.request('l', { ifAvailable: true }, lock => lock?.name ?? null)).toBe('l');
  });

  it('locks: isolated gives a tab a manager of its own', async () => {
    const tabA = createBrowserEnv({ locks: 'isolated' });
    const tabB = createBrowserEnv();
    void tabB.locks.request('l', () => new Promise(() => {}));
    await flushMicrotasks();
    expect(await tabA.locks.request('l', { ifAvailable: true }, lock => lock?.name ?? null)).toBe('l');
  });
});

describe('persistent env', () => {
  let env: BrowserEnv;
  beforeAll(() => {
    env = installBrowserEnv({ persistent: true });
  });
  afterAll(() => env.uninstall());

  it('survives the end of a test', () => {
    env.hide();
  });

  it('is still installed and reset() restores the initial state', () => {
    expect(currentBrowserEnv()).toBe(env);
    expect(document.visibilityState).toBe('hidden');
    env.reset();
    expect(document.visibilityState).toBe('visible');
  });
});

describe('createBrowserEnv', () => {
  it('builds an independent env without touching globals', () => {
    const tab = createBrowserEnv({ visibilityState: 'hidden' });
    expect(tab.document.hidden).toBe(true);
    expect((globalThis as { document?: unknown }).document).toBeUndefined();
  });
});

describe('FakeLockManager', () => {
  it('grants exclusive locks in FIFO order', async () => {
    const locks = new FakeLockManager();
    const order: string[] = [];
    const first = deferred();
    const p1 = locks.request('l', async () => { order.push('1'); await first.promise; order.push('1 done'); });
    const p2 = locks.request('l', async () => { order.push('2'); });
    await flushMicrotasks();
    expect(order).toEqual(['1']);
    expect((await locks.query()).pending).toHaveLength(1);
    first.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['1', '1 done', '2']);
  });

  it('shares shared locks, answers ifAvailable with null, honours abort and steal', async () => {
    const locks = new FakeLockManager();
    const hold = deferred();
    const s1 = locks.request('l', { mode: 'shared' }, () => hold.promise);
    const s2 = locks.request('l', { mode: 'shared' }, () => hold.promise);
    await flushMicrotasks();
    expect((await locks.query()).held).toHaveLength(2);
    expect(await locks.request('l', { ifAvailable: true }, lock => lock)).toBeNull();

    const controller = new AbortController();
    const aborted = locks.request('l', { signal: controller.signal }, () => 'never');
    controller.abort();
    await expect(aborted).rejects.toThrow();

    expect(await locks.request('l', { steal: true }, lock => lock?.mode)).toBe('exclusive');
    await expect(s1).rejects.toThrow(/stolen/);
    await expect(s2).rejects.toThrow(/stolen/);
    hold.resolve();
  });

  it('reset() rejects pending requests and frees the name', async () => {
    const locks = new FakeLockManager();
    void locks.request('l', () => new Promise(() => {}));
    const pending = locks.request('l', () => 'x');
    await flushMicrotasks();
    locks.reset();
    await expect(pending).rejects.toThrow(/reset/);
    expect(await locks.request('l', () => 'free')).toBe('free');
  });

  it('hands out client views that report their clientId', async () => {
    const locks = new FakeLockManager();
    const a = locks.client('a');
    await a.request('l', async () => {
      expect((await locks.query()).held).toEqual([{ name: 'l', mode: 'exclusive', clientId: 'a' }]);
    });
  });
});

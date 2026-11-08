// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * The gateway's replacement service worker (docker/caddy/gateway-service-worker.js,
 * docs/frontend "Service worker on a gateway"), run in a fake worker scope:
 * it takes over at once, deletes every cache, reloads only the pages the
 * previous worker controlled, answers no fetches, and shows pushes in the
 * old app's format with a click target on its own origin.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL('../docker/caddy/gateway-service-worker.js', import.meta.url)),
  'utf8',
);
const ORIGIN = 'https://app.test';

type Listener = (event: any) => void;

type FakeClient = {
  url: string;
  navigate: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
};

function client(path: string, navigate?: () => Promise<unknown>): FakeClient {
  return {
    url: `${ORIGIN}${path}`,
    navigate: vi.fn(navigate ?? (async () => null)),
    postMessage: vi.fn(),
  };
}

function load(options: { cacheNames?: string[]; controlled?: FakeClient[]; uncontrolled?: FakeClient[] } = {}) {
  const listeners = new Map<string, Listener[]>();
  const order: string[] = [];
  let claimed = false;
  const cacheNames = [...(options.cacheNames ?? [])];
  const controlled = options.controlled ?? [];
  const uncontrolled = options.uncontrolled ?? [];
  const self = {
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    skipWaiting: vi.fn(async () => undefined),
    location: { origin: ORIGIN },
    caches: {
      keys: vi.fn(async () => [...cacheNames]),
      delete: vi.fn(async (name: string) => {
        order.push(`delete ${name}`);
        const index = cacheNames.indexOf(name);
        if (index >= 0) cacheNames.splice(index, 1);
        return index >= 0;
      }),
    },
    clients: {
      // like a browser during activation: the previous worker's pages are
      // already this worker's; claim() adds the uncontrolled ones
      matchAll: vi.fn(async () => {
        order.push('matchAll');
        return claimed ? [...controlled, ...uncontrolled] : [...controlled];
      }),
      claim: vi.fn(async () => {
        order.push('claim');
        claimed = true;
      }),
      openWindow: vi.fn(async () => null),
    },
    registration: { showNotification: vi.fn(async () => undefined) },
  };
  const consoleStub = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  vm.runInNewContext(SOURCE, { self, URL, console: consoleStub });

  async function dispatch(type: string, extra: Record<string, unknown> = {}) {
    const pending: Promise<unknown>[] = [];
    const event = { ...extra, waitUntil: (promise: Promise<unknown>) => pending.push(promise) };
    for (const listener of listeners.get(type) ?? []) listener(event);
    await Promise.all(pending);
  }

  return { self, listeners, order, cacheNames, dispatch };
}

function pushData(payload: unknown) {
  return { json: () => (typeof payload === 'string' ? JSON.parse(payload) : payload) };
}

describe('gateway replacement service worker', () => {
  it('has no fetch handler: every request goes to the network', () => {
    const { listeners } = load();
    expect(listeners.has('fetch')).toBe(false);
    expect([...listeners.keys()].sort()).toEqual(['activate', 'install', 'notificationclick', 'push']);
  });

  it('takes over at once on install', async () => {
    const { self, dispatch } = load();
    await dispatch('install');
    expect(self.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('deletes every cache, claims the pages and reloads only the ones the previous worker controlled', async () => {
    const oldPage = client('/c/some-community/channel/general');
    const installedApp = client('/');
    const firstVisit = client('/notifications/');
    const { self, order, cacheNames, dispatch } = load({
      cacheNames: [`workbox-precache-v2-${ORIGIN}/`, 'cg-instance-config'],
      controlled: [oldPage, installedApp],
      uncontrolled: [firstVisit],
    });
    await dispatch('activate');

    expect(cacheNames).toEqual([]);
    expect(self.clients.claim).toHaveBeenCalledTimes(1);
    // the reload list is taken before claim(), so a page that no worker
    // controlled (e.g. the gateway page that registered this worker) never
    // reloads
    expect(order.indexOf('matchAll')).toBeLessThan(order.indexOf('claim'));
    expect(oldPage.navigate).toHaveBeenCalledWith(oldPage.url);
    expect(installedApp.navigate).toHaveBeenCalledWith(installedApp.url);
    expect(firstVisit.navigate).not.toHaveBeenCalled();
    expect(oldPage.postMessage).not.toHaveBeenCalled();
  });

  it('does not wait for the reloads: they wait for the activation to finish', async () => {
    // a navigation of a page the worker controls waits until the worker is
    // activated; awaiting it inside the activation would hold both up
    const page = client('/', () => new Promise(() => undefined));
    const { dispatch } = load({ controlled: [page] });
    const outcome = await Promise.race([
      dispatch('activate').then(() => 'activated'),
      new Promise(resolve => setTimeout(() => resolve('stuck'), 200)),
    ]);
    expect(outcome).toBe('activated');
    expect(page.navigate).toHaveBeenCalledWith(page.url);
  });

  it('reloads a page with a fragment by navigating without it (same-URL fragment navigation does not reload)', async () => {
    const page = client('/c/x/#message-1');
    const { dispatch } = load({ controlled: [page] });
    await dispatch('activate');
    expect(page.navigate).toHaveBeenCalledWith(`${ORIGIN}/c/x/`);
  });

  it('asks a page to reload itself when it cannot be navigated', async () => {
    const refused = client('/', async () => { throw new TypeError('navigate not allowed'); });
    const missing = { url: `${ORIGIN}/x`, navigate: undefined as unknown, postMessage: vi.fn() };
    const { dispatch } = load({ controlled: [refused, missing as unknown as FakeClient] });
    await dispatch('activate');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(refused.postMessage).toHaveBeenCalledWith({ action: 'reload' });
    expect(missing.postMessage).toHaveBeenCalledWith({ action: 'reload' });
  });

  it('shows a general push of the old format with its title, text and path', async () => {
    const { self, dispatch } = load();
    await dispatch('push', {
      data: pushData({
        action: 'new',
        data: {
          type: 'General',
          text: 'Continue on the new site.',
          extraData: { type: 'generalData', title: 'Common Ground moved', navUrl: '/c/some-community/' },
        },
      }),
    });
    expect(self.registration.showNotification).toHaveBeenCalledWith('Common Ground moved', {
      body: 'Continue on the new site.',
      icon: '/icons/192.png',
      data: { url: `${ORIGIN}/c/some-community/` },
    });
  });

  it('shows a fixed notice for any other push, and keeps the click on its own origin', async () => {
    for (const data of [
      null,
      { text: () => 'not json', json: () => { throw new SyntaxError('no json'); } },
      pushData({ action: 'new', data: { type: 'Mention', text: 'someone mentioned you' } }),
      pushData({ action: 'new', data: { type: 'General', text: 'x', extraData: { type: 'generalData', title: 'Moved', navUrl: 'https://elsewhere.example/' } } }),
    ]) {
      const { self, dispatch } = load();
      await dispatch('push', { data });
      const [title, options] = self.registration.showNotification.mock.calls[0] as unknown as [string, { data: { url: string } }];
      expect(typeof title).toBe('string');
      expect(title).not.toBe('');
      expect(options.data.url.startsWith(`${ORIGIN}/`)).toBe(true);
    }
  });

  it('opens the notification target on its own origin on click', async () => {
    const { self, dispatch } = load();
    const close = vi.fn();
    await dispatch('notificationclick', { notification: { close, data: { url: `${ORIGIN}/c/x/` } } });
    expect(close).toHaveBeenCalled();
    expect(self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/c/x/`);

    const other = load();
    await other.dispatch('notificationclick', { notification: { close, data: { url: 'https://elsewhere.example/' } } });
    expect(other.self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });

  it('focuses an open window and sends it to the target instead of opening another', async () => {
    const open = { ...client('/'), focus: vi.fn(async () => undefined) };
    const { self, dispatch } = load({ controlled: [open] });
    await dispatch('notificationclick', { notification: { close: vi.fn(), data: { url: `${ORIGIN}/c/x/` } } });
    expect(open.focus).toHaveBeenCalled();
    expect(open.navigate).toHaveBeenCalledWith(`${ORIGIN}/c/x/`);
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });
});

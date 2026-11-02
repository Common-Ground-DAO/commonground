// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { CDPSession, Page } from 'puppeteer';
import type { ExpectedFailure } from './harness.ts';
import { sleep, until } from './ui.ts';

/**
 * Browser conditions a flow provokes through the Chrome DevTools Protocol
 * (and browser APIs), never through the app's own objects — so the flows
 * stay valid when the app's data layer is replaced:
 *
 *   offline/online       Network.emulateNetworkConditions (+ open WebSockets closed)
 *   held responses       Fetch interception at the response stage
 *   client clock offset  Date shifted from the first script of every document on
 *   frozen/active        Page.setWebLifecycleState (what Chrome does to hidden tabs)
 *   stopped worker       ServiceWorker.stopAllWorkers (the browser stopped an idle worker)
 *
 * Findings of Chrome's own probes in the runner image (Chrome for Testing,
 * headless): emulated offline fires `offline`/`online` and fails every new
 * request and WebSocket, but leaves an open WebSocket open — a real network
 * loss does not (the OS reports the dead link, or the ping times out), so
 * setOffline() closes the page's open sockets as well. Freezing a page closes
 * its WebSockets (code 1006) and stops its timers, as on Android.
 */

/**
 * Keeps a list of the page's WebSockets (window.__e2eSockets) from the
 * first script of every document on, so setOffline() can close them.
 * Install before the page loads.
 */
export async function trackWebSockets(page: Page) {
  await page.evaluateOnNewDocument(() => {
    const Native = window.WebSocket;
    const list: WebSocket[] = [];
    (window as unknown as { __e2eSockets: WebSocket[] }).__e2eSockets = list;
    window.WebSocket = class extends Native {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        list.push(this);
      }
    } as typeof WebSocket;
  });
}

/** how many of the page's tracked WebSockets are open (or connecting) */
export async function openWebSockets(page: Page): Promise<number> {
  return page.evaluate(() => ((window as unknown as { __e2eSockets?: WebSocket[] }).__e2eSockets ?? [])
    .filter(ws => ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING).length);
}

/**
 * Takes the page offline (or back online) like a lost network: emulated
 * offline for every request, and — after a second, in which the app may
 * close its socket itself on the `offline` event — the page's sockets that
 * are still open are closed. Returns how many it had to close (0 = the app
 * closed its sockets itself). Needs trackWebSockets() for the closing part.
 */
export async function setOffline(page: Page, offline: boolean): Promise<number> {
  await page.setOfflineMode(offline);
  if (!offline) {
    return 0;
  }
  await sleep(1000);
  return page.evaluate(() => {
    let closed = 0;
    for (const ws of (window as unknown as { __e2eSockets?: WebSocket[] }).__e2eSockets ?? []) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
        closed++;
      }
    }
    return closed;
  });
}

/** the guard findings a page that is offline produces by itself (t.expectFailures) */
export function offlineFailures(session: string): ExpectedFailure[] {
  return [
    { session, kinds: ['request-failed'], text: /^net::ERR_INTERNET_DISCONNECTED /, reason: `${session} is offline` },
    { session, kinds: ['console-error'], text: /net::ERR_INTERNET_DISCONNECTED|^WebSocket connection to '\S+' failed/, reason: `${session} is offline` },
  ];
}

/** the guard findings of a socket the browser closed (freeze) and the app reopens */
export function socketDropFailures(session: string): ExpectedFailure[] {
  return [
    { session, kinds: ['console-error'], text: /^WebSocket connection to '\S+' failed|^WebSocket is already in CLOSING or CLOSED state/, reason: `${session}'s socket was dropped` },
  ];
}

export type HeldResponses = {
  /** responses held so far */
  count: number;
  urls: string[];
  stop: () => Promise<void>;
};

/**
 * Delays the responses of matching requests by `delayMs` (CDP Fetch at the
 * response stage, on a CDP session of its own): the server has processed the
 * request — its answer is a snapshot of that moment — but the page receives
 * it late, as on a slow or busy network. `urlPattern` is a Fetch pattern
 * (`*` wildcards), e.g. `*\/api/v2/Message/loadMessages*`.
 */
export async function holdResponses(page: Page, urlPattern: string, delayMs: number): Promise<HeldResponses> {
  const cdp = await page.createCDPSession();
  const held: HeldResponses = {
    count: 0,
    urls: [],
    stop: async () => {
      stopped = true;
      await cdp.send('Fetch.disable').catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    },
  };
  let stopped = false;
  cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
    try {
      if (!stopped) {
        held.count++;
        held.urls.push(request.url);
        await sleep(delayMs);
      }
    }
    finally {
      await cdp.send('Fetch.continueRequest', { requestId }).catch(() => undefined);
    }
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern, requestStage: 'Response' }] });
  return held;
}

/**
 * Shifts the page's clock (`Date`, `Date.now()`) by `offsetMs` from the
 * first script of every following document on — a client whose clock runs
 * ahead (positive) or behind of the server. performance.now() and the
 * server are unaffected. Applies from the next page load.
 */
export async function setClockOffset(page: Page, offsetMs: number) {
  await page.evaluateOnNewDocument((offset: number) => {
    const RealDate = Date;
    const realNow = RealDate.now.bind(RealDate);
    const Shifted = new Proxy(RealDate, {
      construct(target, args, newTarget) {
        return Reflect.construct(target, args.length ? args : [realNow() + offset], newTarget);
      },
      apply() {
        return new RealDate(realNow() + offset).toString();
      },
      get(target, prop, receiver) {
        if (prop === 'now') {
          return () => realNow() + offset;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    (window as unknown as { Date: DateConstructor }).Date = Shifted;
  }, offsetMs);
}

/** the page's clock minus the runner's (ms; the runner's clock is the host's, like the server's) */
export async function clockSkew(page: Page): Promise<number> {
  const before = Date.now();
  const pageNow = await page.evaluate(() => Date.now());
  const after = Date.now();
  return Math.round(pageNow - (before + after) / 2);
}

/**
 * Freezes the page (or resumes it): what Chrome does to hidden tabs on
 * Android and in energy saver — no script runs, timers stop, WebSockets are
 * closed. `frozen` fires `freeze` in the page, `active` fires `resume`.
 */
export async function setLifecycle(cdp: CDPSession, state: 'frozen' | 'active') {
  await cdp.send('Page.setWebLifecycleState', { state });
}

/**
 * Stops every running service worker of the browser (as the browser does with
 * an idle worker): the next page load or event has to start it cold. Resolves
 * once every worker version the page knows of reports `stopped` (at most
 * 5 s); returns the versions seen and their final running status.
 */
export async function stopServiceWorkers(cdp: CDPSession): Promise<{ versions: number; running: string[] }> {
  const status = new Map<string, string>();
  const onUpdate = ({ versions }: { versions: { versionId: string; runningStatus: string }[] }) => {
    for (const v of versions) {
      status.set(v.versionId, v.runningStatus);
    }
  };
  cdp.on('ServiceWorker.workerVersionUpdated', onUpdate);
  try {
    await cdp.send('ServiceWorker.enable');
    // the enable call reports the current versions
    await sleep(200);
    await cdp.send('ServiceWorker.stopAllWorkers');
    await until('every service worker to stop', async () => [...status.values()].every(s => s === 'stopped'), 5_000, 100)
      .catch(() => undefined);
    return { versions: status.size, running: [...status.values()] };
  }
  finally {
    cdp.off('ServiceWorker.workerVersionUpdated', onUpdate);
    await cdp.send('ServiceWorker.disable').catch(() => undefined);
  }
}

/**
 * A hard reload with a cold service worker: stops the workers, then reloads
 * bypassing the HTTP cache (Page.reload ignoreCache — the worker still
 * controls the load and has to start up for it). Resolves when the new
 * document's DOM is loaded.
 */
export async function coldServiceWorkerReload(page: Page, cdp: CDPSession) {
  const stopped = await stopServiceWorkers(cdp);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    cdp.send('Page.reload', { ignoreCache: true }),
  ]);
  return stopped;
}

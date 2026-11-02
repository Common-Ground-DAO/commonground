// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { afterEach, describe, expect, it } from 'vitest';
import { installBrowserEnv } from 'test/env';
import { deferred } from 'test/deferred';
import {
  LEGACY_WEBSOCKET_STATE_CHANNEL,
  type LegacyCompatAnswer,
  type LegacyTabToWorkerMessage,
} from 'data/appstate/transport';
import { installLegacyTabCompat, legacyTabCompatAnswer } from './serviceWorkerLegacyTabs';

const roleRequest = (tabId: string): LegacyTabToWorkerMessage => ({
  type: 'TabToWorker',
  tabId,
  tabState: 'unknown',
  visible: true,
});

/** Everything an old page may put on the channel besides a role request. */
const ignoredMessages: unknown[] = [
  // heartbeats of an old page, with and without the active tab's state
  { type: 'TabToWorker', tabId: 'tab-a', tabState: 'active', visible: true, socketState: 'connected', lastEventTime: 1, lastDisconnect: 1 },
  { type: 'TabToWorker', tabId: 'tab-a', tabState: 'active-throttled' },
  { type: 'TabToWorker', tabId: 'tab-a', tabState: 'passive', visible: false },
  { type: 'TabToWorker', tabId: 'tab-a', tabState: 'passive-throttled' },
  { type: 'TabToWorker', tabId: 'tab-a', tabState: 'tabClosed', socketState: 'disconnected', lastDisconnect: 1 },
  // worker -> tab messages (another worker of the old build may post them)
  { type: 'WorkerToTab', tabId: 'tab-a', tabState: 'unknown' },
  { type: 'WorkerToTab', tabId: 'tab-a', tabState: 'active', socketState: 'connected' },
  // malformed
  { type: 'TabToWorker', tabState: 'unknown' },
  { type: 'TabToWorker', tabId: '', tabState: 'unknown' },
  { type: 'TabToWorker', tabId: 42, tabState: 'unknown' },
  { type: 'STOP_TAB_HANDLING' },
  { type: 'CHANNEL_VISITED', channelId: 'c1' },
  'anonymous',
  null,
  undefined,
  42,
];

describe('legacyTabCompatAnswer', () => {
  it('answers a role request with exactly { type, tabId, tabState: "active" }', () => {
    const answer = legacyTabCompatAnswer({
      ...roleRequest('tab-a'),
      socketState: 'connected',
      lastEventTime: 123,
      lastDisconnect: 456,
    });
    const expected: LegacyCompatAnswer = { type: 'WorkerToTab', tabId: 'tab-a', tabState: 'active' };
    // toStrictEqual: no socketState / lastEventTime / lastDisconnect, nothing undefined either
    expect(answer).toStrictEqual(expected);
    expect(Object.keys(answer!).sort()).toEqual(['tabId', 'tabState', 'type']);
  });

  it.each(ignoredMessages.map(m => [JSON.stringify(m) ?? String(m), m]))('ignores %s', (_label, message) => {
    expect(legacyTabCompatAnswer(message)).toBeNull();
  });
});

describe('installLegacyTabCompat', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  /** An old page on the legacy channel; collects every message it receives. */
  function oldPage() {
    const channel = new BroadcastChannel(LEGACY_WEBSOCKET_STATE_CHANNEL);
    const received: unknown[] = [];
    let waiter: { tabId: string; done: ReturnType<typeof deferred<void>> } | undefined;
    channel.onmessage = (event: MessageEvent<unknown>) => {
      received.push(event.data);
      if (waiter && (event.data as { tabId?: unknown } | null)?.tabId === waiter.tabId) {
        waiter.done.resolve();
      }
    };
    return {
      channel,
      received,
      post: (message: unknown) => channel.postMessage(message),
      /** resolves once an answer for `tabId` arrived */
      answerFor(tabId: string) {
        waiter = { tabId, done: deferred<void>() };
        return waiter.done.promise;
      },
    };
  }

  it('answers an old page\'s role request on the legacy channel and nothing else', async () => {
    installBrowserEnv();
    uninstall = installLegacyTabCompat();
    const page = oldPage();

    const answered = page.answerFor('sentinel');
    for (const message of ignoredMessages) {
      page.post(message);
    }
    page.post(roleRequest('tab-a'));
    page.post(roleRequest('sentinel'));
    await answered;

    // Messages from one sender arrive in order, so an answer to any of the
    // ignored messages would have arrived before the sentinel's.
    expect(page.received).toStrictEqual([
      { type: 'WorkerToTab', tabId: 'tab-a', tabState: 'active' },
      { type: 'WorkerToTab', tabId: 'sentinel', tabState: 'active' },
    ]);
  });

  it('answers every request again (an old page re-asks after it lost its role)', async () => {
    installBrowserEnv();
    uninstall = installLegacyTabCompat();
    const page = oldPage();

    page.post(roleRequest('tab-a'));
    const second = page.answerFor('tab-b');
    page.post(roleRequest('tab-a'));
    page.post(roleRequest('tab-b'));
    await second;
    expect(page.received).toHaveLength(3);
  });

  it('does not answer while shouldAnswer() is false (a waiting worker)', async () => {
    installBrowserEnv();
    let active = false;
    const asked = deferred<void>();
    uninstall = installLegacyTabCompat({
      shouldAnswer: () => {
        asked.resolve();
        return active;
      },
    });
    const page = oldPage();

    page.post(roleRequest('tab-a'));
    await asked.promise; // the worker saw the request and declined
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(page.received).toStrictEqual([]);

    active = true;
    const answered = page.answerFor('tab-a');
    page.post(roleRequest('tab-a'));
    await answered;
    expect(page.received).toStrictEqual([{ type: 'WorkerToTab', tabId: 'tab-a', tabState: 'active' }]);
  });

  it('stops answering once uninstalled', async () => {
    installBrowserEnv();
    const stop = installLegacyTabCompat();
    stop();
    const page = oldPage();
    page.post(roleRequest('tab-a'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(page.received).toStrictEqual([]);
  });
});

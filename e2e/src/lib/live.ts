// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { Page } from 'puppeteer';
import { CONFIRMED_MESSAGE_CONTENT, connectionState, EDITOR } from './app.ts';
import { trackWebSockets } from './cdp.ts';
import type { ExpectedFailure } from './harness.ts';
import { assert, describe, sleep, until } from './ui.ts';
import { EVAL_TIMEOUT_MS, within } from './within.ts';

/**
 * What a person sees of the app's live state, read from the DOM and the
 * public API only (the chat-sync flows must outlive the data layer they
 * test): the connection indicator, the messages of a list in visual order,
 * a channel's unread dot, the notifications badge, and the server's view
 * through the same API routes the app calls.
 */

/** the connection indicator must be "connected" within this time after a (re)load, reconnect or resume */
export const CONNECT_TIMEOUT_MS = 12_000;

/**
 * Installs, for every following document of the page: a record of the
 * connection indicator's states (with whether it was shown) and the
 * WebSocket list for setOffline(). Call before the page loads the app.
 */
export async function prepareLivePage(page: Page) {
  await trackWebSockets(page);
  await page.evaluateOnNewDocument(() => {
    type Entry = { ms: number; state: string; shown: boolean };
    const w = window as unknown as { __e2eIndicatorLog: Entry[] };
    w.__e2eIndicatorLog = [];
    const watch = () => {
      const el = document.getElementById('cg-connection-indicator');
      if (!el) {
        return false;
      }
      const record = () => {
        const state = Array.from(el.classList).find(c => c.startsWith('cg-connection-indicator-'))?.slice('cg-connection-indicator-'.length) ?? '?';
        const shown = getComputedStyle(el).opacity !== '0';
        const last = w.__e2eIndicatorLog[w.__e2eIndicatorLog.length - 1];
        if (!last || last.state !== state || last.shown !== shown) {
          w.__e2eIndicatorLog.push({ ms: Math.round(performance.now()), state, shown });
        }
      };
      record();
      new MutationObserver(record).observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
      // opacity transitions do not change attributes: sample as well
      setInterval(record, 250);
      return true;
    };
    const poll = setInterval(() => {
      if (watch()) {
        clearInterval(poll);
      }
    }, 50);
  });
}

export type IndicatorEntry = { ms: number; state: string; shown: boolean };

/** the indicator states of the current document (prepareLivePage), from `sinceMs` (performance.now of the page) on */
export async function indicatorLog(page: Page, sinceMs = 0): Promise<IndicatorEntry[]> {
  const log = await within(page.evaluate(() => (window as unknown as { __e2eIndicatorLog?: IndicatorEntry[] }).__e2eIndicatorLog ?? []), EVAL_TIMEOUT_MS, 'indicator log')
    .catch(() => [] as IndicatorEntry[]);
  return log.filter(entry => entry.ms >= sinceMs);
}

/** the page's performance.now(), to mark a point in indicatorLog() */
export async function pageNow(page: Page): Promise<number> {
  return within(page.evaluate(() => Math.round(performance.now())), EVAL_TIMEOUT_MS, 'performance.now');
}

/**
 * The tab is live: the connection indicator reaches "connected" within
 * `timeout` (the app's own "Connected"/"Disconnected" indicator, which every
 * tab shows — an inactive tab included) and was not shown as
 * "Disconnected" since `sinceMs` (pageNow). Returns the ms it took.
 */
export async function assertConnected(page: Page, who: string, options: { timeout?: number; sinceMs?: number } = {}): Promise<number> {
  const { timeout = CONNECT_TIMEOUT_MS, sinceMs } = options;
  const started = Date.now();
  await until(`${who}: the connection indicator to show "connected"`, async () => (await connectionState(page)) === 'connected', timeout, 100)
    .catch(async () => {
      const state = await connectionState(page).catch(() => '?');
      const log = (await indicatorLog(page)).map(e => `${e.ms}ms:${e.state}${e.shown ? '' : '(hidden)'}`).slice(-8).join(' ');
      throw new Error(`${who}: not connected within ${timeout / 1000} s — the connection indicator is "${state}"${state === 'disconnected' ? ' (shows "Disconnected")' : state === 'hidden' ? ' (never connected since the load)' : ''}; log: ${log}`);
    });
  if (sinceMs !== undefined) {
    const shown = (await indicatorLog(page, sinceMs)).filter(e => e.state === 'disconnected' && e.shown);
    assert(shown.length === 0, `${who}: the connection indicator showed "Disconnected" at ${shown.map(e => `${e.ms}ms`).join(', ')}`);
  }
  return Date.now() - started;
}

export type ShownMessage = {
  text: string;
  confirmed: boolean;
  top: number;
  edited: boolean;
  /** some of it lies inside the list's scroll container and the window — what the user sees without scrolling */
  inView: boolean;
};

/**
 * The messages a list shows, in visual order (top to bottom): every
 * `.message-item` under `scope` (default: the page), with its text, whether
 * the server confirmed it (`CONFIRMED_MESSAGE_CONTENT`), the "edited" marker and
 * whether it is in view (inside its nearest scrolling ancestor's box and the
 * window).
 */
export async function shownMessages(page: Page, scope = 'body'): Promise<ShownMessage[]> {
  return within(page.evaluate((sel: string, confirmedContent: string) => {
    const root = document.querySelector(sel);
    if (!root) {
      return [];
    }
    const scroller = (el: HTMLElement) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const overflow = getComputedStyle(p).overflowY;
        if ((overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') && p.scrollHeight > p.clientHeight) {
          return p;
        }
      }
      return null;
    };
    return Array.from(root.querySelectorAll<HTMLElement>('.message-item'))
      .map(item => {
        const rect = item.getBoundingClientRect();
        const box = scroller(item)?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
        const top = Math.max(box.top, 0);
        const bottom = Math.min(box.bottom, window.innerHeight);
        return {
          text: (item.querySelector<HTMLElement>('.message-item-message')?.innerText ?? '').trim(),
          confirmed: !!item.querySelector(confirmedContent),
          top: Math.round(rect.top),
          edited: !!item.querySelector('.message-item-date-container.edited'),
          inView: rect.height > 0 && rect.bottom > top + 1 && rect.top < bottom - 1,
        };
      })
      .sort((a, b) => a.top - b.top);
  }, scope, CONFIRMED_MESSAGE_CONTENT), EVAL_TIMEOUT_MS, 'the message list');
}

/**
 * Waits until the list shows every one of `texts` (substring match,
 * confirmed messages only), and — with `inOrder` — in this order from top
 * to bottom. No scrolling, no reload: what the list shows by itself; unless
 * `inView` is false, the lowest of them must also be in view (inside the
 * list's scroll container), so a list that does not follow new messages to
 * the bottom fails. Each of `edited` (texts of `texts`) must also carry the
 * "edited" marker.
 */
export async function waitMessagesShown(page: Page, texts: string[], options: { scope?: string; timeout?: number; inOrder?: boolean; inView?: boolean; edited?: string[]; who?: string } = {}) {
  const { scope = 'body', timeout = 15_000, inOrder = false, inView = true, edited = [], who = 'page' } = options;
  const unmarked = (shown: ShownMessage[]) => edited.filter(text => !shown.some(m => m.confirmed && m.text.includes(text) && m.edited));
  let last: ShownMessage[] = [];
  try {
    return await until(`${who}: ${texts.length} message(s) shown`, async () => {
      last = await shownMessages(page, scope);
      const positions = texts.map(text => last.findIndex(m => m.confirmed && m.text.includes(text)));
      if (positions.some(p => p < 0)) {
        return null;
      }
      if (inOrder && positions.some((p, i) => i > 0 && p < positions[i - 1])) {
        return null;
      }
      if (inView && !last[Math.max(...positions)].inView) {
        return null;
      }
      if (unmarked(last).length > 0) {
        return null;
      }
      return last;
    }, timeout, 200);
  }
  catch {
    const positions = texts.map(text => last.findIndex(m => m.confirmed && m.text.includes(text)));
    const missing = texts.filter((_, i) => positions[i] < 0);
    const lowest = missing.length ? undefined : last[Math.max(...positions)];
    const reason = missing.length
      ? `${missing.length} of ${texts.length} message(s) not shown: ${missing.map(m => JSON.stringify(m.slice(0, 60))).join(', ')}`
      : inOrder && positions.some((p, i) => i > 0 && p < positions[i - 1])
        ? 'the messages are shown out of order'
        : lowest && inView && !lowest.inView ? `the newest one is in the list but not in view (the list did not scroll to it): ${JSON.stringify(lowest?.text.slice(0, 60))}`
          : unmarked(last).length ? `without the "edited" marker: ${unmarked(last).map(m => JSON.stringify(m.slice(0, 60))).join(', ')}`
            : 'the list did not answer';
    throw new Error(`${who}: after ${timeout / 1000} s ${reason}` +
      ` — the list shows ${last.length} message(s): ${last.slice(-8).map(m => JSON.stringify(m.text.slice(0, 40))).join(', ')}`);
  }
}

/**
 * The message stays shown for `ms` (e.g. a late server page must not remove
 * a message that arrived live).
 */
export async function assertMessageStays(page: Page, text: string, ms: number, options: { scope?: string; who?: string } = {}) {
  const { scope = 'body', who = 'page' } = options;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const shown = await shownMessages(page, scope);
    assert(shown.some(m => m.text.includes(text)), `${who}: the message ${JSON.stringify(text.slice(0, 60))} disappeared from the list (it shows ${shown.length} message(s))`);
    await sleep(250);
  }
}

/** the channel's unread dot in the community's channel list: true/false, null when the channel is not listed */
export async function channelUnread(page: Page, channelTitle: string): Promise<boolean | null> {
  return within(page.evaluate((title: string) => {
    const item = Array.from(document.querySelectorAll<HTMLElement>('.text-channel-item-info')).find(el => el.getAttribute('title') === title);
    return item ? item.classList.contains('item-unread') : null;
  }, channelTitle), EVAL_TIMEOUT_MS, 'the channel list');
}

export async function waitChannelUnread(page: Page, channelTitle: string, unread: boolean, timeout = 10_000, who = 'page') {
  await until(`${who}: the unread dot of "${channelTitle}" to be ${unread ? 'shown' : 'cleared'}`, async () => (await channelUnread(page, channelTitle)) === unread, timeout, 200)
    .catch(async () => {
      const now = await channelUnread(page, channelTitle);
      throw new Error(`${who}: the unread dot of "${channelTitle}" is ${now === null ? 'not in the channel list' : now ? 'still shown' : 'not shown'} after ${timeout / 1000} s (expected ${unread ? 'shown' : 'cleared'})`);
    });
}

/**
 * The notifications badge of the main menu (the count on "Notifications"):
 * 0 when no badge is shown, 10 for "9+", null when the menu has no
 * notifications entry (logged out, or not rendered).
 */
export async function notificationBadge(page: Page): Promise<number | null> {
  return within(page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll<HTMLElement>('.menu-expanded .expanded-menu-button'));
    // expanded: labelled; collapsed (inside a community): Explore, Stake, Chats, Notifications
    const button = buttons.find(b => b.innerText.trim().startsWith('Notifications')) ??
      (document.querySelector('.menu-expanded.collapsed') ? buttons[3] : undefined);
    if (!button) {
      return null;
    }
    const count = button.querySelector('.notification-count')?.textContent?.trim();
    if (!count) {
      return 0;
    }
    return count === '9+' ? 10 : Number(count);
  }), EVAL_TIMEOUT_MS, 'the notifications badge');
}

/**
 * Calls the app's API from the page like the app does (same origin, the
 * session cookie, JSON) and returns `data` of an OK response. The response
 * is not seen by the app; use it for the server's view of the state.
 */
export class ApiCallError extends Error {
  http: number;
  constructor(message: string, http: number) {
    super(message);
    this.http = http;
  }
}

export async function apiCall<T>(page: Page, route: string, body?: unknown): Promise<T> {
  const result = await within(page.evaluate(async (path: string, json: string | null) => {
    const response = await fetch(`/api/v2/${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: json ?? undefined,
    });
    return { http: response.status, body: await response.text() };
  }, route, body === undefined ? null : JSON.stringify(body)), 20_000, route);
  let parsed: { status?: string; data?: T; error?: string };
  try {
    parsed = JSON.parse(result.body);
  }
  catch {
    throw new ApiCallError(`${route}: HTTP ${result.http}, not JSON`, result.http);
  }
  if (parsed.status !== 'OK') {
    throw new ApiCallError(`${route}: ${parsed.status} ${parsed.error ?? ''} (HTTP ${result.http})`, result.http);
  }
  return parsed.data as T;
}

export type ServerChannelState = {
  channelId: string;
  lastRead: string | null;
  unread: number;
  lastMessageDate: string | null;
  /** the route that answered */
  source: 'Message/getSyncState' | 'Community/getCommunityDetailView';
};

/** the origins whose server has no Message/getSyncState (it answered 404) */
const noSyncState = new Set<string>();
const originOf = (page: Page) => new URL(page.url()).origin;

/**
 * The guard finding the first getSyncState probe of a server without it
 * causes (Chrome logs the 404): pass to t.expectFailures around the first
 * serverChannelState() of a flow.
 */
export function syncStateProbeFailures(session: string): ExpectedFailure[] {
  return [{ session, kinds: ['console-error'], text: /^Failed to load resource: the server responded with a status of 404 \(\)$/, reason: 'probing Message/getSyncState on a server without it' }];
}

/**
 * The server's read state of a channel for the logged-in user, as the app
 * loads it: Message/getSyncState (read-only; the chat-sync client's source)
 * when the server has it, else Community/getCommunityDetailView (which is
 * also where the channel id comes from).
 */
export async function serverChannelState(page: Page, communityPath: string, channelTitle: string, knownChannelId?: string): Promise<ServerChannelState> {
  let channelId = knownChannelId;
  let detail: ServerChannelState | undefined;
  if (!channelId || noSyncState.has(originOf(page))) {
    const url = /^\/c\/([^/]+)\//.exec(communityPath)?.[1];
    assert(url, `not a community path: ${communityPath}`);
    const community = await apiCall<{ channels?: { channelId: string; title: string; lastRead: string | null; unread: number | string; lastMessageDate: string | null }[] }>(page, 'Community/getCommunityDetailView', { url });
    const channel = community.channels?.find(c => c.title === channelTitle);
    assert(channel, `the server lists no channel "${channelTitle}" in ${communityPath}`);
    channelId = channel.channelId;
    detail = { channelId, lastRead: channel.lastRead, unread: Number(channel.unread), lastMessageDate: channel.lastMessageDate, source: 'Community/getCommunityDetailView' };
  }
  if (!noSyncState.has(originOf(page))) {
    try {
      const state = await apiCall<{ channels: { channelId: string; lastRead: string | null; unread: number; lastMessageDate: string | null }[] }>(page, 'Message/getSyncState', { channelIds: [channelId] });
      const channel = state.channels.find(c => c.channelId === channelId);
      assert(channel, `Message/getSyncState has no channel ${channelId} ("${channelTitle}")`);
      return { channelId, lastRead: channel.lastRead, unread: Number(channel.unread), lastMessageDate: channel.lastMessageDate, source: 'Message/getSyncState' };
    }
    catch (e) {
      if (!(e instanceof ApiCallError && e.http === 404)) {
        throw e;
      }
      noSyncState.add(originOf(page));
    }
  }
  return detail ?? serverChannelState(page, communityPath, channelTitle);
}

/** the server's unread notification count (Notification/getUnreadCount, as the app loads it) */
export async function serverNotificationCount(page: Page): Promise<number> {
  return Number(await apiCall<number | string>(page, 'Notification/getUnreadCount'));
}

/**
 * Types a mention of `name` into the composer of the open channel, as a
 * person does: "@" and the name, then Tab picks the highlighted suggestion.
 * The caller types the rest of the message and sends it.
 */
export async function typeMention(page: Page, name: string) {
  const editor = await page.waitForSelector(EDITOR, { visible: true });
  await editor!.click();
  await page.keyboard.type(`@${name}`, { delay: 20 });
  await page.waitForFunction((full: string) => Array.from(document.querySelectorAll<HTMLElement>('.mentionSuggestion.selected-mention'))
    .some(el => el.innerText.replace(/\s+/g, '').includes(full)), { timeout: 15_000, polling: 200 }, name)
    .catch(describe(`the mention suggestion for @${name} (highlighted)`, 15_000));
  await page.keyboard.press('Tab');
  await sleep(300);
}

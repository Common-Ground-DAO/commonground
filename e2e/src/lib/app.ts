// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { ElementHandle, Page } from 'puppeteer';
import { waitLoginSettled, type FlowContext } from './harness.ts';
import { writeTestPng } from './images.ts';
import { clickText, describe, fill, findByText, hasText, sleep, until, waitText } from './ui.ts';
import { EVAL_TIMEOUT_MS, within } from './within.ts';

/**
 * App-level helpers shared by the flows: readiness, the connection
 * indicator, the user menu, communities, channels and chat messages.
 */

/**
 * The app shell finished loading (the preview overlay of index.html is gone)
 * and — unless `settleLogin` is false — the device login of this page load
 * is done (see waitLoginSettled; only the reload flow acts before that).
 */
export async function waitAppReady(page: Page, options: { timeout?: number; settleLogin?: boolean; tab?: boolean } = {}) {
  const { timeout = 30_000, settleLogin = true, tab = false } = options;
  await page.waitForFunction(() => {
    const preview = document.getElementById('cg-preview');
    const indicator = document.getElementById('cg-connection-indicator');
    return !!indicator && (!preview || getComputedStyle(preview).opacity === '0' || getComputedStyle(preview).display === 'none' || getComputedStyle(preview).visibility === 'hidden');
  }, { timeout, polling: 200 }).catch(describe('the app shell to finish loading', timeout));
  if (settleLogin) {
    // a further tab of a logged-in browser (t.tab) may not log in itself
    await waitLoginSettled(page, 1000, 20_000, { optionalLogin: tab });
  }
}

/**
 * The connection indicator's state: `cg-connection-indicator-<state>` on
 * #cg-connection-indicator (ConnectionStatusIndicator) — "connected",
 * "connecting", "disconnected", "offline", ... It stays in the DOM when
 * hidden, so the class is the signal, not the text.
 */
export async function connectionState(page: Page): Promise<string> {
  return within(page.evaluate(() => {
    const el = document.getElementById('cg-connection-indicator');
    const cls = Array.from(el?.classList ?? []).find(c => c.startsWith('cg-connection-indicator-'));
    return cls ? cls.slice('cg-connection-indicator-'.length) : 'missing';
  }), EVAL_TIMEOUT_MS, 'the connection indicator');
}

/**
 * Goes to an in-app path the way a user clicking a link does: a client-side
 * route change (history.pushState + popstate, which react-router follows)
 * when the app is already loaded, a page load otherwise. Flows thereby load
 * the page about once per session, like a person using the app — page loads
 * (and their device login) are what the reload flow tests.
 */
export async function navigate(t: FlowContext, page: Page, path: string) {
  const loaded = page.url().startsWith(t.origin) && await page.evaluate(() => !!document.getElementById('cg-connection-indicator')).catch(() => false);
  if (!loaded) {
    await page.goto(t.url(path), { waitUntil: 'domcontentloaded' });
    await waitAppReady(page);
    return;
  }
  await page.evaluate((target: string) => {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }, path);
  await page.waitForFunction((target: string) => `${window.location.pathname}${window.location.search}` === target, { timeout: 10_000 }, path);
  await sleep(300);
}

/** opens the user widget popover (desktop sidebar, bottom left) on its home page */
export async function openUserMenu(page: Page) {
  if (await findByText(page, 'Sign out', { timeout: 500 }).catch(() => null)) {
    return;
  }
  const trigger = await page.waitForSelector('#user-settings-root .user-widget-content', { visible: true });
  await trigger!.click();
  await findByText(page, 'Sign out', { timeout: 10_000 });
  // the popover grows with a transition: let it settle before clicking in it
  await sleep(800);
}

export async function closeUserMenu(page: Page) {
  // open on any of its pages (closing resets it to its home page)
  if (await page.$('.user-setting-modal-content-top-container')) {
    const trigger = await page.waitForSelector('#user-settings-root .user-widget-content', { visible: true });
    await trigger!.click();
    await sleep(500);
  }
}

export async function logout(t: FlowContext, page: Page) {
  await openUserMenu(page);
  await clickText(page, 'Sign out');
  // the confirmation modal (LogOffModal)
  await clickText(page, 'Log out', { selector: 'button' });
  await until('the app to be logged out', async () => page.evaluate(() => {
    const raw = localStorage.getItem('CG_CURRENT_USER');
    return !raw || raw === 'null';
  }), 20_000);
}

export type Community = { title: string; path: string };

/** creates a community through the UI ("Create a community" in the sidebar) */
export async function createCommunity(t: FlowContext, page: Page, title = t.unique('comm')): Promise<Community> {
  await clickText(page, 'Create a community');
  await page.waitForSelector('input[placeholder="Make it catchy"]', { visible: true });
  await fill(page, 'input[placeholder="Make it catchy"]', title);
  await fill(page, 'input[placeholder="For the community tile, 50 character limit, be brief!"]', 'Created by the e2e suite');
  const logo = writeTestPng(`${t.outDir}/fixtures`, `logo-${title}`, 128, 128, 1);
  const inputs = await page.$$('input[type=file]');
  // banner, sidebar cover, logo: the logo is required
  await (inputs[inputs.length - 1] as ElementHandle<HTMLInputElement>).uploadFile(logo);
  // the client-side image pre-check runs before the preview appears
  await page.waitForFunction(() => {
    const fields = document.querySelectorAll<HTMLElement>('.image-upload-field-image');
    return fields.length > 0 && fields[fields.length - 1].style.backgroundImage.includes('blob:');
  }, { timeout: 60_000 });
  await clickText(page, 'Create a community', { within: '.btnList' });
  await page.waitForFunction(() => /^\/c\/[^/]+\/$/.test(window.location.pathname), { timeout: 30_000 });
  const path = new URL(page.url()).pathname;
  await waitText(page, title);
  return { title, path };
}

/** creates a text channel in the "General" area (community settings → Channels) */
export async function createChannel(t: FlowContext, page: Page, community: Community, title: string): Promise<string> {
  const slug = title.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  await navigate(t, page, `${community.path}?modal=areas-channels`);
  await waitText(page, 'Areas & Channels');
  await clickText(page, 'General', { selector: '.area-item-inner span.panel-item-text, .area-item-inner' });
  await clickText(page, /New Channel$/, { selector: 'button' });
  await page.waitForSelector('input[placeholder="What should the channel be called?"]', { visible: true });
  await fill(page, 'input[placeholder="What should the channel be called?"]', title);
  await fill(page, 'input[placeholder="Navigation URL for this channel"]', slug);
  await fill(page, 'textarea[placeholder="What is this channel about?"]', 'e2e test channel');
  await clickText(page, 'Save changes', { selector: 'button' });
  await waitText(page, 'Channel created');
  return `${community.path}channel/${slug}/`;
}

/** joins the community shown at `path` as the current (logged-in) user */
export async function joinCommunity(t: FlowContext, page: Page, community: Community) {
  await navigate(t, page, community.path);
  await clickText(page, /^(\+\s*)?Join Community$/, { selector: 'button' });
  // "Welcome to <title>" → Done (some communities ask questions first)
  const done = await findByText(page, 'Done', { selector: 'button', timeout: 15_000 }).catch(() => null);
  if (done) {
    await done.click();
  }
  await until('membership', async () => !(await hasText(page, 'Join Community')), 15_000);
}

export const EDITOR = '.message-field-input[contenteditable=true]';

/** sends a chat message from the composer of the open channel */
export async function sendMessage(page: Page, text: string) {
  const editor = await page.waitForSelector(EDITOR, { visible: true });
  await editor!.click();
  await page.keyboard.type(text, { delay: 3 });
  await page.keyboard.press('Enter');
  return waitMessageConfirmed(page, text);
}

/** the message with this text is shown and confirmed by the server; returns its element id */
export async function waitMessageConfirmed(page: Page, text: string, timeout = 20_000): Promise<string> {
  const handle = await page.waitForFunction((needle: string) => {
    for (const item of Array.from(document.querySelectorAll<HTMLElement>('.message-item'))) {
      const body = item.querySelector<HTMLElement>('.message-item-message');
      if (body?.innerText.includes(needle) && item.querySelector('.message-item-content[data-timestamp]')) {
        return item.id || 'unknown';
      }
    }
    return null;
  }, { timeout, polling: 100 }, text);
  return (await handle.jsonValue()) as string;
}

export async function openChannel(t: FlowContext, page: Page, channelPath: string) {
  await navigate(t, page, channelPath);
  await page.waitForSelector(EDITOR, { visible: true, timeout: 30_000 });
  await sleep(300);
}

/**
 * Edits the own message containing `text` in the open channel: the hover
 * tooltip's edit button, then `suffix` appended in the composer (it is
 * prefilled with the message) and sent. Resolves when the sender's list
 * shows the edited text.
 */
export async function editMessage(page: Page, text: string, suffix: string) {
  const id = await waitMessageConfirmed(page, text, 10_000);
  const item = await page.waitForSelector(`.message-item[id="${id}"]`, { visible: true });
  await item!.hover();
  await page.waitForSelector('#tooltip-root .message-tooltip', { visible: true, timeout: 10_000 });
  // own message: emoji list, emoji picker | reply | edit | delete | pin
  const edit = await page.evaluateHandle(() => {
    const tooltip = document.querySelector('#tooltip-root .message-tooltip')!;
    const children = Array.from(tooltip.children);
    const separators = children.filter(el => el.classList.contains('cg-separator-vertical'));
    const afterSecond = children.indexOf(separators[1]) + 1;
    return children[afterSecond]?.tagName === 'BUTTON' ? children[afterSecond] : null;
  });
  const button = edit.asElement() as ElementHandle<Element> | null;
  if (!button) {
    throw new Error('no edit button in the message tooltip');
  }
  await button.click();
  await page.waitForSelector('.message-item.editing', { timeout: 10_000 });
  const editor = await page.waitForSelector(EDITOR, { visible: true });
  await editor!.click();
  await page.keyboard.press('End');
  await page.keyboard.type(suffix, { delay: 3 });
  await page.keyboard.press('Enter');
  await page.waitForFunction((msgId: string, edited: string) => {
    const el = document.getElementById(msgId);
    return !!el && !el.classList.contains('editing') && !!(el.querySelector('.message-item-message') as HTMLElement | null)?.innerText.includes(edited);
  }, { timeout: 10_000 }, id, `${text}${suffix}`);
}

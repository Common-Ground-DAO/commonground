// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { Page } from 'puppeteer';
import type { FlowContext, Session } from './harness.ts';
import { waitAppReady } from './app.ts';
import { assert, until } from './ui.ts';

/**
 * Several tabs of one user (t.tab) and which of them is visible.
 *
 * Tabs of one window take turns: bringToFront makes a tab the visible one
 * and every other tab of that window hidden — `document.visibilityState`,
 * `visibilitychange`, `document.hasFocus()` behave as in a desktop browser.
 * Background timers keep running at full speed (src/main.ts disables
 * throttling, so the second user's page is not slowed down); what the app
 * decides on visibility, it decides as in a real browser. Tabs opened with
 * `{ window: true }` sit in a window of their own: both windows' front tabs
 * are visible at the same time (split view).
 */

export async function visibility(page: Page): Promise<DocumentVisibilityState> {
  return page.evaluate(() => document.visibilityState);
}

/** brings the tab to the front of its window and waits until it is visible */
export async function showTab(tab: Session) {
  await tab.page.bringToFront();
  await until(`${tab.name} to be visible`, async () => (await visibility(tab.page)) === 'visible', 5_000, 100);
}

/** asserts the tab's visibility (that the harness did what the flow relies on) */
export async function expectVisibility(tab: Session, expected: DocumentVisibilityState) {
  const actual = await until(`${tab.name} to be ${expected}`, async () => {
    const v = await visibility(tab.page);
    return v === expected ? v : null;
  }, 5_000, 100).catch(async () => visibility(tab.page));
  assert(actual === expected, `${tab.name} is ${actual}, expected ${expected}`);
}

/**
 * Loads the app at `path` in a tab (a page load, like opening a link in a
 * new tab) and waits until it is ready; a further tab of a logged-in browser
 * need not run a device login of its own.
 */
export async function openTab(t: FlowContext, tab: Session, path: string) {
  await tab.page.goto(t.url(path), { waitUntil: 'domcontentloaded' });
  await waitAppReady(tab.page, { tab: !!tab.parent });
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { Page } from 'puppeteer';
import type { Flow } from '../lib/harness.ts';
import { navigate, openChannel, waitAppReady, waitMessageConfirmed } from '../lib/app.ts';
import { liveTab, ownerAndMember } from '../lib/chatsync.ts';
import { assertConnected, notificationBadge, serverNotificationCount, typeMention } from '../lib/live.ts';
import { openTab, showTab } from '../lib/tabs.ts';
import { assert, sleep, until } from '../lib/ui.ts';

/** how long a badge value must hold to count as settled (a double count shows up within it) */
const HOLD_MS = 3_000;

/**
 * E5 (e2e/README.md "The chat-sync flows"): the notifications badge.
 * A mentions B twice: the badge goes up by one per mention, exactly once.
 * B opens one of the two notifications: the badge goes down by one, once
 * (not to zero). After a reload the badge equals the server's count
 * (Notification/getUnreadCount, as the app loads it). B has a second tab
 * open in the background the whole time (on the home page): its badge
 * follows every change too — the opened notification included, which only
 * the first tab marked read.
 */
export const csNotifications: Flow = {
  id: 'cs-notifications',
  title: 'E5 notifications: a mention increments the badge once, opening it decrements once, after reload badge = server count; a second tab follows',
  async run(t) {
    const { owner, member, memberAccount, channels } = await ownerAndMember(t, { owner: 'mentioner', member: 'mentioned', channels: ['mentions'] });

    /** the badge reaches `expected` and holds it for HOLD_MS */
    const badgeSettlesAt = async (page: Page, expected: number, what: string, timeout = 15_000) => {
      let last: number | null = null;
      await until(`${what}: the badge to show ${expected}`, async () => {
        last = await notificationBadge(page);
        return last === expected;
      }, timeout, 200).catch(() => {
        throw new Error(`${what}: the notifications badge shows ${last === null ? 'nothing (no menu entry)' : last} after ${timeout / 1000} s, expected ${expected}`);
      });
      const deadline = Date.now() + HOLD_MS;
      while (Date.now() < deadline) {
        last = await notificationBadge(page);
        assert(last === expected, `${what}: the notifications badge went from ${expected} to ${last}`);
        await sleep(200);
      }
    };

    let base = 0;
    await t.step('member on the notifications page: the badge shows the server count', async () => {
      await navigate(t, member.page, '/notifications');
      await assertConnected(member.page, 'member');
      base = await serverNotificationCount(member.page);
      t.metric('serverCountAtStart', base);
      await badgeSettlesAt(member.page, base, 'at start');
    });

    const tab2 = await liveTab(t, member, 'tab2');
    /** both tabs of the member reach `expected` and hold it */
    const bothSettleAt = async (expected: number, what: string) => {
      await Promise.all([
        badgeSettlesAt(member.page, expected, what),
        badgeSettlesAt(tab2.page, expected, `${what} (second tab)`),
      ]);
    };
    await t.step('member opens a second tab (home page), which stays in the background', async () => {
      await openTab(t, tab2, '/');
      await assertConnected(tab2.page, 'second tab');
      await showTab(member);
      await bothSettleAt(base, 'second tab at start');
    });

    const mentions = [`ping one ${t.unique('m')}`, `ping two ${t.unique('m')}`];
    const mention = async (text: string) => {
      await typeMention(owner.page, memberAccount.name);
      await owner.page.keyboard.type(` ${text}`, { delay: 3 });
      await owner.page.keyboard.press('Enter');
      await waitMessageConfirmed(owner.page, text);
    };

    await t.step('owner mentions the member: the badge goes up by one, once (both tabs)', async () => {
      await openChannel(t, owner.page, channels.mentions);
      await mention(mentions[0]);
      await bothSettleAt(base + 1, 'first mention');
    });

    await t.step('a second mention: up by one again (both tabs)', async () => {
      await mention(mentions[1]);
      await bothSettleAt(base + 2, 'second mention');
      const server = await serverNotificationCount(member.page);
      assert(server === base + 2, `the server counts ${server} unread notifications, expected ${base + 2}`);
    });

    await t.step('member opens the first notification: the badge goes down by one, once (both tabs)', async () => {
      const item = await member.page.waitForFunction((needle: string) => Array.from(document.querySelectorAll<HTMLElement>('.notificationMessage'))
        .find(el => el.innerText.includes(needle)) ?? null, { timeout: 15_000, polling: 200 }, mentions[0]);
      const unread = await (item as import('puppeteer').JSHandle<Element>).evaluate(el => (el as HTMLElement).classList.contains('unread'));
      assert(unread, 'the notification of the first mention is not shown as unread');
      await (item as import('puppeteer').JSHandle<Element>).evaluate(el => (el as HTMLElement).click());
      await bothSettleAt(base + 1, 'after opening one');
      const server = await until('the server to count the notification read', async () => {
        const n = await serverNotificationCount(member.page);
        return n === base + 1 ? n : null;
      }, 10_000, 500).catch(async () => serverNotificationCount(member.page));
      assert(server === base + 1, `the server counts ${server} unread notifications after opening one, expected ${base + 1}`);
    });

    await t.step('after a reload of the first tab both badges equal the server count', async () => {
      await member.page.reload({ waitUntil: 'domcontentloaded' });
      await waitAppReady(member.page);
      await assertConnected(member.page, 'member', { sinceMs: 0 });
      const server = await serverNotificationCount(member.page);
      t.metric('serverCountAfterReload', server);
      await bothSettleAt(server, 'after reload');
    });
  },
};

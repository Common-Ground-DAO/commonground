// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { Page } from 'puppeteer';
import type { Flow } from '../lib/harness.ts';
import { signUp } from '../lib/account.ts';
import { createChannel, createCommunity, EDITOR, joinCommunity, navigate, openChannel, sendMessage, waitMessageConfirmed } from '../lib/app.ts';
import { assert, sleep } from '../lib/ui.ts';

/** the message element whose body contains `text` */
async function messageId(page: Page, text: string) {
  return waitMessageConfirmed(page, text, 10_000);
}

/** opens the hover tooltip of a message */
async function hoverMessage(page: Page, id: string) {
  const item = await page.waitForSelector(`.message-item[id="${id}"]`, { visible: true });
  await item!.hover();
  await page.waitForSelector('#tooltip-root .message-tooltip', { visible: true, timeout: 10_000 });
}

/**
 * Community + channel + real-time chat between two users: the owner creates
 * a community and a channel, a second user joins; messages, a reaction and
 * an edit show up in the other browser over the websocket without a reload.
 */
export const communityChat: Flow = {
  id: 'community-chat',
  title: 'Community + channel, real-time messages between two users, reaction, edit',
  async run(t) {
    const owner = await t.session('owner');
    const member = await t.session('member');

    const { community, channel } = await t.step('owner: sign up, create community and channel', async () => {
      await signUp(t, owner, 'password', 'chatowner');
      const c = await createCommunity(t, owner.page);
      const ch = await createChannel(t, owner.page, c, 'e2e-chat');
      return { community: c, channel: ch };
    });

    await t.step('member: sign up and join the community', async () => {
      await signUp(t, member, 'password', 'chatmember');
      await joinCommunity(t, member.page, community);
    });

    await t.step('both open the channel', async () => {
      await openChannel(t, owner.page, channel);
      await openChannel(t, member.page, channel);
      // let both websockets subscribe
      await sleep(1000);
    });

    const first = `hello from the owner ${t.unique('m')}`;
    await t.step('owner sends, member receives in real time', async () => {
      const started = Date.now();
      await sendMessage(owner.page, first);
      await waitMessageConfirmed(member.page, first, 10_000);
      t.metric('deliveryMs', Date.now() - started);
    });

    const reply = `hi back from the member ${t.unique('m')}`;
    await t.step('member replies, owner receives in real time', async () => {
      await sendMessage(member.page, reply);
      await waitMessageConfirmed(owner.page, reply, 10_000);
    });

    await t.step('owner reacts 👍 to the reply, member sees the reaction', async () => {
      const id = await messageId(owner.page, reply);
      await hoverMessage(owner.page, id);
      const thumbs = await owner.page.waitForFunction(() => {
        return Array.from(document.querySelectorAll('#tooltip-root .message-tooltip .emoji-featured-list span.emoji')).find(el => el.textContent === '👍') ?? null;
      });
      await (thumbs.asElement() as import('puppeteer').ElementHandle<Element>).click();
      for (const page of [owner.page, member.page]) {
        await page.waitForFunction((msgId: string) => {
          const item = document.getElementById(msgId);
          return Array.from(item?.querySelectorAll('.reactions-display .emoji-reaction-item') ?? []).some(el =>
            el.querySelector('.emoji')?.textContent === '👍' && el.querySelector('.reaction-count')?.textContent?.trim() === '1');
        }, { timeout: 10_000 }, id);
      }
    });

    const edited = `${first} (edited)`;
    await t.step('owner edits the first message, member sees the edit', async () => {
      const id = await messageId(owner.page, first);
      await hoverMessage(owner.page, id);
      // own message: emoji list, emoji picker | reply | edit | delete | pin
      const edit = await owner.page.evaluateHandle(() => {
        const tooltip = document.querySelector('#tooltip-root .message-tooltip')!;
        const children = Array.from(tooltip.children);
        const separators = children.filter(el => el.classList.contains('cg-separator-vertical'));
        const afterSecond = children.indexOf(separators[1]) + 1;
        return children[afterSecond]?.tagName === 'BUTTON' ? children[afterSecond] : null;
      });
      const button = edit.asElement() as import('puppeteer').ElementHandle<Element> | null;
      assert(button, 'no edit button in the message tooltip');
      await button.click();
      await owner.page.waitForSelector('.message-item.editing', { timeout: 10_000 });
      const editor = await owner.page.waitForSelector(EDITOR, { visible: true });
      await editor!.click();
      // the composer is prefilled with the message: append to it
      await owner.page.keyboard.press('End');
      await owner.page.keyboard.type(' (edited)', { delay: 3 });
      await owner.page.keyboard.press('Enter');
      const shows = (page: Page, marker: boolean) => page.waitForFunction((msgId: string, text: string, withMarker: boolean) => {
        const item = document.getElementById(msgId);
        return !!item && !!(item.querySelector('.message-item-message') as HTMLElement | null)?.innerText.includes(text) &&
          (!withMarker || !!item.querySelector('.message-item-date-container.edited'));
      }, { timeout: 10_000 }, id, edited, marker);
      await shows(owner.page, true);
      await shows(member.page, false);
      // the "edited" marker (pencil + second time) in the other browser
      const markerLive = await shows(member.page, true).then(() => true, () => false);
      if (!markerLive) {
        await navigate(t, member.page, community.path);
        await openChannel(t, member.page, channel);
        const afterReopen = await shows(member.page, true).then(() => true, () => false);
        t.note(`FINDING: the edited message reached the member in real time, but its "edited" marker ${afterReopen ? 'only appears after reopening the channel' : 'does not appear there at all (not even after reopening the channel)'} (soft check, not failed)`);
      }
    });
  },
};

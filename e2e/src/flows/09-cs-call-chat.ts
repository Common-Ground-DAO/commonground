// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { JSHandle } from 'puppeteer';
import type { Flow } from '../lib/harness.ts';
import { instanceInfo } from '../lib/account.ts';
import { EDITOR, navigate, sendMessage } from '../lib/app.ts';
import { clockSkew, holdResponses, setClockOffset } from '../lib/cdp.ts';
import { ownerAndMember } from '../lib/chatsync.ts';
import { assertConnected, assertMessageStays, waitMessagesShown } from '../lib/live.ts';
import { assert, clickText, fill, sleep, until } from '../lib/ui.ts';

const CLOCK_OFFSET_MS = 2_000;
const LOAD_DELAY_MS = 2_500;

/**
 * E1 (docs/todo/ROADMAP_chat-sync.md, Acceptance): the first message of a
 * call chat reaches a member who opens the call while it is posted.
 *
 * B's clock runs 2 s ahead of the server and B's `loadMessages` responses
 * arrive 2.5 s late: the call chat's first page — computed by the server
 * before A's message existed, so empty — reaches B after the message came
 * in live. B must see the message without a reload, and keep seeing it once
 * the late page is applied.
 */
export const csCallChat: Flow = {
  id: 'cs-call-chat',
  title: 'E1 call chat: the first message reaches a member who opens the call meanwhile (clock +2 s, late loadMessages)',
  async run(t) {
    const { owner, member, community } = await ownerAndMember(t, {
      owner: 'caller',
      member: 'joiner',
      beforeMemberLoad: async s => setClockOffset(s.page, CLOCK_OFFSET_MS),
    });
    if ((await instanceInfo(owner.page)).features?.calls === false) {
      t.skip('calls are disabled on this instance (features.calls = false)');
    }

    await t.step(`member's clock runs ${CLOCK_OFFSET_MS / 1000} s ahead`, async () => {
      const skew = await clockSkew(member.page);
      t.metric('memberClockSkewMs', skew);
      assert(Math.abs(skew - CLOCK_OFFSET_MS) < 500, `the member's clock is off by ${skew} ms, expected about ${CLOCK_OFFSET_MS}`);
    });

    await t.step('owner starts a call (its chat is open)', async () => {
      await navigate(t, owner.page, community.path);
      await clickText(owner.page, 'Start Call');
      await fill(owner.page, 'input[placeholder="e.g. Daily Standup"]', 'e2e call chat');
      await clickText(owner.page, 'Start call', { selector: 'button' });
      await owner.page.waitForFunction(() => /\/call\/[^/]+\/?$/.test(window.location.pathname), { timeout: 30_000 });
      await owner.page.waitForSelector(`.call-chat ${EDITOR}`, { visible: true, timeout: 30_000 });
    });

    const first = `first in the call ${t.unique('m')}`;
    const held = await holdResponses(member.page, '*/api/v2/Message/loadMessages*', LOAD_DELAY_MS);
    try {
      await t.step(`member opens the call while the owner posts (member's loadMessages ${LOAD_DELAY_MS / 1000} s late)`, async () => {
        await navigate(t, member.page, community.path);
        const loads: number[] = [];
        const onRequest = (request: import('puppeteer').HTTPRequest) => {
          if (request.url().includes('/api/v2/Message/loadMessages')) {
            loads.push(Date.now());
          }
        };
        member.page.on('request', onRequest);
        try {
          const item = await member.page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>('.call-item')).find(el => el.innerText.includes('e2e call chat')) ?? null, { timeout: 20_000 });
          const clickedAt = Date.now();
          await (item as JSHandle<Element>).evaluate(el => (el as HTMLElement).click());
          await member.page.waitForFunction(() => /\/call\/[^/]+\/?$/.test(window.location.pathname), { timeout: 20_000 });
          // the call chat asks for its first page — the answer will come late
          await until('the call chat to load its messages', async () => loads.some(at => at >= clickedAt), 15_000, 50);
        }
        finally {
          member.page.off('request', onRequest);
        }
        // the owner posts at once
        await sendMessage(owner.page, first);
        await clickText(member.page, /^(Join call|Join now)$/, { selector: 'button', timeout: 30_000 });
        t.metric('heldLoadMessages', held.count);
      });

      await t.step('member sees the first message without a reload', async () => {
        await waitMessagesShown(member.page, [first], { scope: '.call-chat', timeout: 15_000, who: 'member' });
      });

      await t.step('it stays after the late first page is applied', async () => {
        // every held response is out after LOAD_DELAY_MS; give the app a moment to apply it
        await sleep(LOAD_DELAY_MS + 500);
        await assertMessageStays(member.page, first, 3_000, { scope: '.call-chat', who: 'member' });
      });
    }
    finally {
      await held.stop();
    }

    await t.step('a second message arrives live', async () => {
      const second = `second in the call ${t.unique('m')}`;
      await sendMessage(owner.page, second);
      await waitMessagesShown(member.page, [first, second], { scope: '.call-chat', timeout: 10_000, inOrder: true, who: 'member' });
    });

    await t.step('member stays connected', async () => {
      await assertConnected(member.page, 'member', { sinceMs: 0 });
    });
  },
};

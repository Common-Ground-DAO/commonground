// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { HTTPRequest, JSHandle } from 'puppeteer';
import type { Flow, Session } from '../lib/harness.ts';
import { instanceInfo, signUp } from '../lib/account.ts';
import { EDITOR, joinCommunity, navigate, sendMessage } from '../lib/app.ts';
import { clockSkew, holdResponses, setClockOffset, type HeldResponses } from '../lib/cdp.ts';
import { ownerAndMember } from '../lib/chatsync.ts';
import { assertConnected, assertMessageStays, prepareLivePage, waitMessagesShown } from '../lib/live.ts';
import { assert, clickText, fill, sleep, until } from '../lib/ui.ts';

const CLOCK_OFFSET_MS = 2_000;
const LOAD_DELAY_MS = 2_500;
/** the reads a message list loads its window with: the old client's page route and the chat-sync catch-up */
const MESSAGE_READ = /\/api\/v2\/Message\/(loadMessages|getChanges)\b/;
const MESSAGE_READ_PATTERNS = ['*/api/v2/Message/loadMessages*', '*/api/v2/Message/getChanges*'];

/**
 * E1 (e2e/README.md "The chat-sync flows"): the first message of a
 * call chat reaches a member who opens the call while it is posted.
 *
 * Two variants, each with a member of its own and a fresh call (the first
 * message must land in an empty chat):
 *   plain  no clock skew, no added latency — a red here is not caused by
 *          the conditions below
 *   skew   B's clock runs 2 s ahead of the server and B's message reads
 *          (loadMessages / getChanges) arrive 2.5 s late: the call chat's
 *          first page — computed by the server before A's message existed,
 *          so empty — reaches B after the message came in live
 * B must see the message without a reload and keep seeing it once the
 * (late) first page is applied; a second message arrives live.
 */
export const csCallChat: Flow = {
  id: 'cs-call-chat',
  title: 'E1 call chat: the first message reaches a member who opens the call meanwhile (plain; clock +2 s and late reads)',
  timeoutMs: config => Math.max(config.flowTimeoutMs, 360_000),
  async run(t) {
    const { owner, member: plainMember, community } = await ownerAndMember(t, { owner: 'caller', member: 'joiner' });
    if ((await instanceInfo(owner.page)).features?.calls === false) {
      t.skip('calls are disabled on this instance (features.calls = false)');
    }
    const skewMember = await t.session('skewjoiner');
    await prepareLivePage(skewMember.page);
    await setClockOffset(skewMember.page, CLOCK_OFFSET_MS);
    await t.step('setup: a second member with a clock 2 s ahead joins', async () => {
      await signUp(t, skewMember, 'password', 'skewjoiner');
      await joinCommunity(t, skewMember.page, community);
      const skew = await clockSkew(skewMember.page);
      t.metric('skewMemberClockSkewMs', skew);
      assert(Math.abs(skew - CLOCK_OFFSET_MS) < 500, `the member's clock is off by ${skew} ms, expected about ${CLOCK_OFFSET_MS}`);
    });

    const failed: string[] = [];
    const variant = async (name: 'plain' | 'skew', member: Session) => {
      const title = `e2e call ${name}`;
      await t.step(`${name}: owner starts a call (its chat is open)`, async () => {
        await navigate(t, owner.page, community.path);
        await clickText(owner.page, 'Start Call');
        await fill(owner.page, 'input[placeholder="e.g. Daily Standup"]', title);
        await clickText(owner.page, 'Start call', { selector: 'button' });
        await owner.page.waitForFunction(() => /\/call\/[^/]+\/?$/.test(window.location.pathname), { timeout: 30_000 });
        await owner.page.waitForSelector(`.call-chat ${EDITOR}`, { visible: true, timeout: 30_000 });
      });

      const first = `first in the ${name} call ${t.unique('m')}`;
      let held: HeldResponses | undefined;
      try {
        if (name === 'skew') {
          held = await holdResponses(member.page, MESSAGE_READ_PATTERNS, LOAD_DELAY_MS);
        }
        await t.step(`${name}: member opens the call while the owner posts${held ? ` (member's message reads ${LOAD_DELAY_MS / 1000} s late)` : ''}`, async () => {
          await navigate(t, member.page, community.path);
          const reads: number[] = [];
          const onRequest = (request: HTTPRequest) => {
            if (MESSAGE_READ.test(request.url())) {
              reads.push(Date.now());
            }
          };
          member.page.on('request', onRequest);
          try {
            const item = await member.page.waitForFunction((needle: string) => Array.from(document.querySelectorAll<HTMLElement>('.call-item')).find(el => el.innerText.includes(needle)) ?? null, { timeout: 20_000 }, title);
            const clickedAt = Date.now();
            await (item as JSHandle<Element>).evaluate(el => (el as HTMLElement).click());
            await member.page.waitForFunction(() => /\/call\/[^/]+\/?$/.test(window.location.pathname), { timeout: 20_000 });
            // the call chat asks for its first page
            await until('the call chat to load its messages', async () => reads.some(at => at >= clickedAt), 15_000, 50);
          }
          finally {
            member.page.off('request', onRequest);
          }
          // the owner posts at once
          await sendMessage(owner.page, first);
          await clickText(member.page, /^(Join call|Join now)$/, { selector: 'button', timeout: 30_000 });
          if (held) {
            t.metric('heldMessageReads', { count: held.count, urls: held.urls.map(u => new URL(u).pathname) });
          }
        });

        await t.step(`${name}: member sees the first message without a reload`, async () => {
          await waitMessagesShown(member.page, [first], { scope: '.call-chat', timeout: 15_000, who: `${name} member` });
        });

        await t.step(`${name}: it stays after the (late) first page is applied`, async () => {
          await sleep((held ? LOAD_DELAY_MS : 0) + 500);
          await assertMessageStays(member.page, first, 3_000, { scope: '.call-chat', who: `${name} member` });
        });
      }
      finally {
        await held?.stop();
      }

      await t.step(`${name}: a second message arrives live; member connected`, async () => {
        const second = `second in the ${name} call ${t.unique('m')}`;
        await sendMessage(owner.page, second);
        await waitMessagesShown(member.page, [first, second], { scope: '.call-chat', timeout: 10_000, inOrder: true, who: `${name} member` });
        await assertConnected(member.page, `${name} member`, { sinceMs: 0 });
      });
    };

    for (const [name, member] of [['plain', plainMember], ['skew', skewMember]] as const) {
      await variant(name, member).catch((e: unknown) => {
        failed.push(`${name}: ${(e as Error).message.split('\n')[0]}`);
      });
      await t.step(`${name}: owner and member leave the call`, async () => {
        for (const page of [member.page, owner.page]) {
          const leave = await page.$('button.btnFinal.call-actions-button-size');
          await leave?.click();
        }
        await navigate(t, owner.page, community.path);
        await navigate(t, member.page, community.path);
        await sleep(1_000);
      }).catch(() => undefined);
    }

    t.metric('failedVariants', failed);
    await t.step('both variants passed', async () => {
      assert(failed.length === 0, `${failed.length} of 2 variant(s) failed — ${failed.join(' | ')}`);
    });
  },
};

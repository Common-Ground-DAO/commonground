// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { Flow, Session } from '../lib/harness.ts';
import { editMessage, openChannel, sendMessage, waitAppReady } from '../lib/app.ts';
import { coldServiceWorkerReload, setLifecycle, socketDropFailures, swControlled } from '../lib/cdp.ts';
import { liveTab, ownerAndMember } from '../lib/chatsync.ts';
import { assertConnected, CONNECT_TIMEOUT_MS, pageNow, waitMessagesShown } from '../lib/live.ts';
import { expectVisibility, openTab, showTab } from '../lib/tabs.ts';
import { assert, sleep } from '../lib/ui.ts';

/**
 * E8 (docs/todo/ROADMAP_chat-sync.md, Acceptance), independent parts:
 *  - split view: B has the channel open in two windows side by side (both
 *    visible); A posts; both show it live, without any interaction;
 *  - frozen tab: B's tab is hidden behind another tab and frozen (CDP
 *    Page.setWebLifecycleState, what Chrome does to hidden tabs on Android:
 *    no script runs, the socket is closed); A posts two messages and edits
 *    one; the tab is resumed and brought to the front: it reconnects and
 *    catches up — the edit included;
 *  - cold service worker: the service worker is stopped (the guards'
 *    worker sessions detached first) and the tab reloaded, twice: a plain
 *    reload (the worker controls the load and starts cold) and a hard
 *    reload (Page.reload ignoreCache: an uncontrolled page with a cold
 *    worker). Each must be connected within 12 s of the reload (a tab that
 *    never connects shows nothing for 10 s, then "Disconnected": both fail).
 */
export const csSplitFrozen: Flow = {
  id: 'cs-split-frozen',
  title: 'E8 split view (two visible tabs live), frozen tab resumed catches up, reloads with a stopped service worker connect',
  // setup ~40 s, the parts ~20–60 s each, more when they fail on their timeouts
  timeoutMs: config => Math.max(config.flowTimeoutMs, 420_000),
  async run(t) {
    const { owner, member, channels } = await ownerAndMember(t, { owner: 'sender', member: 'splitview', channels: ['split'] });
    const channel = channels.split;
    let window2: Session | undefined;
    // the parts are independent: each gets its verdict, the flow fails at the end if any failed
    const failed: string[] = [];
    const part = async (name: string, fn: () => Promise<void>) => {
      await fn().catch((e: unknown) => {
        failed.push(`${name}: ${(e as Error).message.split('\n')[0]}`);
      });
    };
    const all: string[] = [];

    await part('split view', async () => {
      await t.step('split view: member opens the channel in two windows side by side', async () => {
        await openChannel(t, owner.page, channel);
        await openChannel(t, member.page, channel);
        window2 = await liveTab(t, member, 'window2', { window: true });
        await openTab(t, window2, channel);
        await expectVisibility(member, 'visible');
        await expectVisibility(window2, 'visible');
        await assertConnected(member.page, 'window 1');
        await assertConnected(window2.page, 'window 2');
      });
      await t.step('split view: owner posts twice, both visible windows show it live', async () => {
        for (let i = 1; i <= 2; i++) {
          all.push(`split view ${i} ${t.unique('m')}`);
          await sendMessage(owner.page, all[all.length - 1]);
        }
        await waitMessagesShown(member.page, all, { timeout: 10_000, inOrder: true, who: 'window 1' });
        await waitMessagesShown(window2!.page, all, { timeout: 10_000, inOrder: true, who: 'window 2' });
        await assertConnected(member.page, 'window 1', { sinceMs: 0 });
        await assertConnected(window2!.page, 'window 2', { sinceMs: 0 });
      });
    });

    await part('frozen tab', async () => {
      await t.step('frozen tab: close the second window; another tab hides the channel tab', async () => {
        await window2?.page.close();
        if (!all.length) {
          all.push(`before freezing ${t.unique('m')}`);
          await sendMessage(owner.page, all[0]);
        }
        const other = await liveTab(t, member, 'other');
        await openTab(t, other, '/');
        await expectVisibility(member, 'hidden');
      });
      const suffix = ' (edited while frozen)';
      const frozenPosts = [`while frozen 1 ${t.unique('m')}`, `while frozen 2 ${t.unique('m')}`];
      // one step: nothing may evaluate in the frozen page (the step's own checks would hang)
      await t.expectFailures(socketDropFailures(member.name), async () => {
        await t.step('frozen tab: freeze it; owner posts and edits; resume it and bring it to the front', async () => {
          await setLifecycle(member.cdp, 'frozen');
          try {
            await sleep(1_000);
            for (const text of frozenPosts) {
              await sendMessage(owner.page, text);
            }
            await editMessage(owner.page, all[0], suffix);
            all[0] = `${all[0]}${suffix}`;
            all.push(...frozenPosts);
            await sleep(2_000);
          }
          finally {
            await setLifecycle(member.cdp, 'active');
          }
          await showTab(member);
          const resumedAt = await pageNow(member.page);
          t.metric('reconnectAfterResumeMs', await assertConnected(member.page, 'resumed tab', { sinceMs: resumedAt }));
        });
      }, 3_000);
      await t.step('frozen tab: it catches up — new messages and the edit, in order', async () => {
        await waitMessagesShown(member.page, all, { timeout: 15_000, inOrder: true, who: 'resumed tab' });
      });
    });

    for (const how of ['plain', 'ignore-cache'] as const) {
      const what = how === 'plain' ? 'plain reload' : 'hard reload (uncontrolled page)';
      await part(`cold service worker, ${what}`, async () => {
        await t.step(`cold service worker: ${what} with the worker stopped, connected within 12 s`, async () => {
          await showTab(member);
          const cold = await coldServiceWorkerReload(t, member, how);
          t.metric(`coldReload.${how}.workers`, cold);
          t.metric(`coldReload.${how}.controlled`, await swControlled(member.page).catch(() => null));
          await waitAppReady(member.page, { settleLogin: false });
          const left = Math.max(1_000, CONNECT_TIMEOUT_MS - (Date.now() - cold.reloadAt));
          await assertConnected(member.page, `tab after the cold ${what}`, { timeout: left, sinceMs: 0 });
          t.metric(`coldReload.${how}.connectedMs`, Date.now() - cold.reloadAt);
          await waitMessagesShown(member.page, all, { timeout: 15_000, inOrder: true, who: `tab after the cold ${what}` });
        });
      });
    }

    t.metric('failedParts', failed);
    await t.step('every part passed', async () => {
      assert(failed.length === 0, `${failed.length} of 4 part(s) failed — ${failed.join(' | ')}`);
    });
  },
};

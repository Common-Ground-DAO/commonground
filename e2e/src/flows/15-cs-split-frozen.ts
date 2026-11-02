// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { Flow, Session } from '../lib/harness.ts';
import { editMessage, openChannel, sendMessage, waitAppReady } from '../lib/app.ts';
import { coldServiceWorkerReload, setLifecycle, socketDropFailures } from '../lib/cdp.ts';
import { liveTab, ownerAndMember } from '../lib/chatsync.ts';
import { assertConnected, CONNECT_TIMEOUT_MS, pageNow, waitMessagesShown } from '../lib/live.ts';
import { expectVisibility, openTab, showTab } from '../lib/tabs.ts';
import { sleep } from '../lib/ui.ts';

/**
 * E8 (docs/todo/ROADMAP_chat-sync.md, Acceptance), three parts:
 *  - split view: B has the channel open in two windows side by side (both
 *    visible); A posts; both show it live, without any interaction;
 *  - frozen tab: B's tab is hidden behind another tab and frozen (CDP
 *    Page.setWebLifecycleState, what Chrome does to hidden tabs on Android:
 *    no script runs, the socket is closed); A posts two messages and edits
 *    one; the tab is resumed and brought to the front: it reconnects and
 *    catches up — the edit included;
 *  - cold service worker: the service worker is stopped and the tab hard-
 *    reloaded (Page.reload ignoreCache): it must be connected within 12 s
 *    (a tab that never connects shows nothing for 10 s, then
 *    "Disconnected": both fail).
 */
export const csSplitFrozen: Flow = {
  id: 'cs-split-frozen',
  title: 'E8 split view (two visible tabs live), frozen tab resumed catches up, hard reload with a stopped service worker connects',
  async run(t) {
    const { owner, member, channels } = await ownerAndMember(t, { owner: 'sender', member: 'splitview', channels: ['split'] });
    const channel = channels.split;
    let window2!: Session;

    await t.step('member opens the channel in two windows side by side', async () => {
      await openChannel(t, owner.page, channel);
      await openChannel(t, member.page, channel);
      window2 = await liveTab(t, member, 'window2', { window: true });
      await openTab(t, window2, channel);
      await expectVisibility(member, 'visible');
      await expectVisibility(window2, 'visible');
      await assertConnected(member.page, 'window 1');
      await assertConnected(window2.page, 'window 2');
    });

    const all: string[] = [];
    await t.step('owner posts twice: both visible windows show it live', async () => {
      for (let i = 1; i <= 2; i++) {
        all.push(`split view ${i} ${t.unique('m')}`);
        await sendMessage(owner.page, all[all.length - 1]);
      }
      await waitMessagesShown(member.page, all, { timeout: 10_000, inOrder: true, who: 'window 1' });
      await waitMessagesShown(window2.page, all, { timeout: 10_000, inOrder: true, who: 'window 2' });
      await assertConnected(member.page, 'window 1', { sinceMs: 0 });
      await assertConnected(window2.page, 'window 2', { sinceMs: 0 });
    });

    let other!: Session;
    await t.step('close the second window; another tab hides the channel tab', async () => {
      await window2.page.close();
      other = await liveTab(t, member, 'other');
      await openTab(t, other, '/');
      await expectVisibility(member, 'hidden');
    });

    const suffix = ' (edited while frozen)';
    const frozenPosts = [`while frozen 1 ${t.unique('m')}`, `while frozen 2 ${t.unique('m')}`];
    let resumedAt = 0;
    // one step: nothing may evaluate in the frozen page (the step's own checks would hang)
    await t.expectFailures(socketDropFailures(member.name), async () => {
      await t.step('freeze the hidden channel tab; owner posts and edits; resume it and bring it to the front', async () => {
        await setLifecycle(member.cdp, 'frozen');
        try {
          await sleep(1_000);
          for (const text of frozenPosts) {
            await sendMessage(owner.page, text);
          }
          await editMessage(owner.page, all[0], suffix);
          await sleep(2_000);
        }
        finally {
          await setLifecycle(member.cdp, 'active');
        }
        await showTab(member);
        resumedAt = await pageNow(member.page);
        t.metric('reconnectAfterResumeMs', await assertConnected(member.page, 'resumed tab', { sinceMs: resumedAt }));
      });
    }, 3_000);
    all[0] = `${all[0]}${suffix}`;
    all.push(...frozenPosts);

    await t.step('the resumed tab catches up: new messages and the edit, in order', async () => {
      await waitMessagesShown(member.page, all, { timeout: 15_000, inOrder: true, who: 'resumed tab' });
    });

    await t.step('hard reload with a stopped service worker: connected within 12 s', async () => {
      const started = Date.now();
      const workers = await coldServiceWorkerReload(member.page, member.cdp);
      t.metric('stoppedServiceWorkers', workers);
      await waitAppReady(member.page, { settleLogin: false });
      const left = Math.max(1_000, CONNECT_TIMEOUT_MS - (Date.now() - started));
      await assertConnected(member.page, 'tab after the cold reload', { timeout: left, sinceMs: 0 });
      t.metric('coldReloadConnectedMs', Date.now() - started);
      await waitMessagesShown(member.page, all, { timeout: 15_000, inOrder: true, who: 'tab after the cold reload' });
    });
  },
};

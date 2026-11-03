// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { Flow, Session } from '../lib/harness.ts';
import { openChannel, sendMessage, waitAppReady } from '../lib/app.ts';
import { liveTab, ownerAndMember } from '../lib/chatsync.ts';
import { assertConnected, shownMessages, waitMessagesShown } from '../lib/live.ts';
import { expectVisibility, openTab, showTab } from '../lib/tabs.ts';
import { assert } from '../lib/ui.ts';

/**
 * E4 (e2e/README.md "The chat-sync flows"): two tabs of B in the
 * same channel, one in front. A posts; B switches tabs; B writes from the
 * second tab; both tabs are reloaded. Every tab, whenever it is in front,
 * shows every message (its own tab's and the other tab's included), in
 * order, and is connected; no tab ends up with an empty channel.
 */
export const csMultiTab: Flow = {
  id: 'cs-multi-tab',
  title: 'E4 multi-tab: two tabs of one user, posts, tab switches, reload of both; both consistent, no empty channel',
  async run(t) {
    const { owner, member, channels } = await ownerAndMember(t, { owner: 'writer', member: 'twotabs', channels: ['tabs'] });
    const channel = channels.tabs;
    let tab2!: Session;

    await t.step('member opens the channel in two tabs, tab 1 in front', async () => {
      await openChannel(t, owner.page, channel);
      await openChannel(t, member.page, channel);
      tab2 = await liveTab(t, member, 'tab2');
      await openTab(t, tab2, channel);
      await showTab(member);
      await expectVisibility(tab2, 'hidden');
      await assertConnected(member.page, 'tab 1');
      await assertConnected(tab2.page, 'tab 2');
    });

    const all: string[] = [];
    await t.step('owner posts; tab 1 (in front) shows it', async () => {
      all.push(`to both tabs 1 ${t.unique('m')}`);
      await sendMessage(owner.page, all[0]);
      await waitMessagesShown(member.page, all, { timeout: 10_000, who: 'tab 1' });
    });

    await t.step('switch to tab 2: it shows it too', async () => {
      await showTab(tab2);
      await expectVisibility(member, 'hidden');
      await assertConnected(tab2.page, 'tab 2');
      await waitMessagesShown(tab2.page, all, { timeout: 10_000, who: 'tab 2' });
    });

    await t.step('owner posts while tab 2 is in front; member answers from tab 2', async () => {
      all.push(`to both tabs 2 ${t.unique('m')}`);
      await sendMessage(owner.page, all[1]);
      await waitMessagesShown(tab2.page, all, { timeout: 10_000, inOrder: true, who: 'tab 2' });
      all.push(`from tab 2 ${t.unique('m')}`);
      await sendMessage(tab2.page, all[2]);
      await waitMessagesShown(owner.page, all, { timeout: 10_000, inOrder: true, who: 'owner' });
    });

    await t.step('switch to tab 1: everything is there, in order', async () => {
      await showTab(member);
      await assertConnected(member.page, 'tab 1');
      await waitMessagesShown(member.page, all, { timeout: 10_000, inOrder: true, who: 'tab 1' });
    });

    const reloadAndCheck = async (tab: Session, who: string) => {
      await showTab(tab);
      await tab.page.reload({ waitUntil: 'domcontentloaded' });
      await waitAppReady(tab.page, { tab: !!tab.parent });
      await assertConnected(tab.page, who, { sinceMs: 0 });
      await waitMessagesShown(tab.page, all, { timeout: 15_000, inOrder: true, who });
    };

    await t.step('reload tab 1, then tab 2: both show the whole channel', async () => {
      await reloadAndCheck(member, 'tab 1 after reload');
      await reloadAndCheck(tab2, 'tab 2 after reload');
    });

    await t.step('after the reloads: a new message reaches the tab in front, the other catches up when shown', async () => {
      all.push(`after the reloads ${t.unique('m')}`);
      await sendMessage(owner.page, all[3]);
      await waitMessagesShown(tab2.page, all, { timeout: 10_000, inOrder: true, who: 'tab 2' });
      await showTab(member);
      await assertConnected(member.page, 'tab 1');
      await waitMessagesShown(member.page, all, { timeout: 10_000, inOrder: true, who: 'tab 1' });
      for (const [tab, who] of [[member, 'tab 1'], [tab2, 'tab 2']] as const) {
        const shown = await shownMessages(tab.page);
        assert(shown.length >= all.length, `${who} shows ${shown.length} message(s), expected at least ${all.length}`);
      }
    });
  },
};

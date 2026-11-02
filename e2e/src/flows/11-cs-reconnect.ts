// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { Flow } from '../lib/harness.ts';
import { connectionState, editMessage, openChannel, sendMessage } from '../lib/app.ts';
import { offlineFailures, setOffline } from '../lib/cdp.ts';
import { ownerAndMember } from '../lib/chatsync.ts';
import { assertConnected, pageNow, waitMessagesShown } from '../lib/live.ts';
import { sleep, until } from '../lib/ui.ts';

/**
 * E3 (docs/todo/ROADMAP_chat-sync.md, Acceptance): reconnect. B has the
 * channel open and goes offline; meanwhile A posts three messages and
 * edits an older one. Back online, B's open list shows all of it in order —
 * the edit included — without scrolling or a reload, and a message A posts
 * after the reconnect arrives live as well.
 */
export const csReconnect: Flow = {
  id: 'cs-reconnect',
  title: 'E3 reconnect: offline while 3 messages and an edit are posted; back online all of it shows in order',
  async run(t) {
    const { owner, member, channels } = await ownerAndMember(t, { owner: 'online', member: 'offline', channels: ['reconnect'] });
    const channel = channels.reconnect;

    const older = `older ${t.unique('m')}`;
    await t.step('both in the channel; the member sees a first message', async () => {
      await openChannel(t, owner.page, channel);
      await openChannel(t, member.page, channel);
      await assertConnected(member.page, 'member');
      await sendMessage(owner.page, older);
      await waitMessagesShown(member.page, [older], { timeout: 10_000, who: 'member' });
    });

    const posted = [`while offline 1 ${t.unique('m')}`, `while offline 2 ${t.unique('m')}`, `while offline 3 ${t.unique('m')}`];
    const suffix = ' (edited while offline)';
    let onlineAt = 0;
    await t.expectFailures(offlineFailures(member.name), async () => {
      await t.step('member goes offline', async () => {
        const closed = await setOffline(member.page, true);
        t.note(closed ? `the app left ${closed} socket(s) open on "offline"; closed them` : 'the app closed its socket on "offline" itself');
        const state = await until('the indicator to show offline', async () => (await connectionState(member.page)) === 'offline', 10_000, 200)
          .then(() => 'offline', async () => connectionState(member.page));
        t.metric('indicatorWhileOffline', state);
      });

      await t.step('owner posts three messages and edits the older one', async () => {
        for (const text of posted) {
          await sendMessage(owner.page, text);
        }
        await editMessage(owner.page, older, suffix);
        await sleep(1_000);
      });

      await t.step('member comes back online and reconnects', async () => {
        onlineAt = await pageNow(member.page);
        await setOffline(member.page, false);
        t.metric('reconnectMs', await assertConnected(member.page, 'member', { sinceMs: onlineAt }));
      });
    }, 3_000);

    await t.step('member sees all of it, in order, without scrolling or a reload', async () => {
      await waitMessagesShown(member.page, [`${older}${suffix}`, ...posted], { inOrder: true, timeout: 20_000, who: 'member' });
    });

    await t.step('a message after the reconnect arrives live', async () => {
      const after = `after the reconnect ${t.unique('m')}`;
      await sendMessage(owner.page, after);
      await waitMessagesShown(member.page, [...posted, after], { inOrder: true, timeout: 10_000, who: 'member' });
      await assertConnected(member.page, 'member', { sinceMs: onlineAt });
    });
  },
};

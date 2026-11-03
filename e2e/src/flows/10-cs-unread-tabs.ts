// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { HTTPRequest, HTTPResponse, Page } from 'puppeteer';
import type { Flow, Session } from '../lib/harness.ts';
import { openChannel, sendMessage, waitAppReady } from '../lib/app.ts';
import { liveTab, ownerAndMember } from '../lib/chatsync.ts';
import { assertConnected, channelUnread, serverChannelState, syncStateProbeFailures, waitChannelUnread, waitMessagesShown } from '../lib/live.ts';
import { expectVisibility, openTab, showTab } from '../lib/tabs.ts';
import { assert, sleep, until } from '../lib/ui.ts';

const READ = 'read-here';
const OTHER = 'elsewhere';

/**
 * E2 (e2e/README.md "The chat-sync flows"): unread across tabs.
 * B has two tabs; tab 2 is in the background. A posts in a channel B is not
 * in: tab 1 shows the unread dot. B reads the channel in tab 1, reloads: the
 * dot stays cleared — in tab 1 and, once in front, in tab 2, also after
 * reloading that one — and the server's `lastRead` (as the app loads it:
 * Message/getSyncState, or Community/getCommunityDetailView on servers
 * without it) never moves backwards, nor does any lastRead a tab sends.
 */
export const csUnreadTabs: Flow = {
  id: 'cs-unread-tabs',
  title: 'E2 unread across tabs: read in tab 1 with tab 2 in the background, reload; stays cleared, server lastRead never regresses',
  async run(t) {
    const { owner, member, community, channels } = await ownerAndMember(t, { owner: 'poster', member: 'reader', channels: [READ, OTHER] });
    let tab2!: Session;

    // every lastRead the server reported for READ, in order: [where, ISO]
    const serverReads: [string, string][] = [];
    // every lastRead B's tabs sent for READ (setChannelLastRead), in order: [tab, ISO]
    const sent: [string, string][] = [];
    // the first read of the server's state also finds out whether it has Message/getSyncState
    const readChannelId = await t.expectFailures(syncStateProbeFailures(member.name), () =>
      t.step(`the server's read state of "${READ}"`, async () => (await serverChannelState(member.page, community.path, READ)).channelId), 500);
    const record = (where: string, lastRead: string | null | undefined) => {
      if (lastRead) {
        serverReads.push([where, lastRead]);
      }
    };
    /** fails when a value in `list` is older than one before it */
    const assertMonotonic = (list: [string, string][], what: string) => {
      let newest: [string, string] | undefined;
      for (const entry of list) {
        assert(!newest || Date.parse(entry[1]) >= Date.parse(newest[1]),
          `${what} of "${READ}" went back from ${newest?.[1]} (${newest?.[0]}) to ${entry[1]} (${entry[0]})`);
        if (!newest || Date.parse(entry[1]) > Date.parse(newest[1])) {
          newest = entry;
        }
      }
    };
    /** the server never reported an older lastRead, and no tab ever sent an older one than was sent before */
    const assertNeverRegressed = () => {
      assertMonotonic(serverReads, "the server's lastRead");
      assertMonotonic(sent, 'a lastRead the member\'s tabs sent (setChannelLastRead)');
    };
    const serverState = async (page: Page, where: string) => {
      const state = await serverChannelState(page, community.path, READ, readChannelId);
      t.metric('serverStateSource', state.source);
      record(where, state.lastRead);
      assertNeverRegressed();
      return state;
    };
    // what B's tabs send for READ and what the server answers (newer servers echo the stored lastRead)
    const watchLastRead = (s: Session) => {
      s.page.on('request', (request: HTTPRequest) => {
        if (!request.url().includes('/api/v2/Message/setChannelLastRead')) {
          return;
        }
        try {
          const body = JSON.parse(request.postData() ?? '{}') as { access?: { channelId?: string }; lastRead?: string };
          if (body.access?.channelId === readChannelId && body.lastRead) {
            sent.push([s.name, body.lastRead]);
          }
        }
        catch {
          // not JSON
        }
      });
      s.page.on('response', async (response: HTTPResponse) => {
        if (!response.url().includes('/api/v2/Message/setChannelLastRead')) {
          return;
        }
        try {
          const body = JSON.parse(response.request().postData() ?? '{}') as { access?: { channelId?: string } };
          const result = JSON.parse(await response.text()) as { status?: string; data?: { lastRead?: string } };
          if (body.access?.channelId === readChannelId && result.status === 'OK') {
            record(`setChannelLastRead answer to ${s.name}`, result.data?.lastRead);
          }
        }
        catch {
          // no body
        }
      });
    };
    watchLastRead(member);

    await t.step(`member: tab 1 in "${OTHER}", tab 2 open in the background`, async () => {
      await openChannel(t, member.page, channels[OTHER]);
      tab2 = await liveTab(t, member, 'tab2');
      watchLastRead(tab2);
      await openTab(t, tab2, channels[OTHER]);
      await showTab(member);
      await expectVisibility(tab2, 'hidden');
      await assertConnected(member.page, 'tab 1');
      await assertConnected(tab2.page, 'tab 2');
    });

    const messages = [`unread one ${t.unique('m')}`, `unread two ${t.unique('m')}`];
    await t.step(`owner posts two messages in "${READ}"; tab 1 shows the unread dot`, async () => {
      await openChannel(t, owner.page, channels[READ]);
      for (const text of messages) {
        await sendMessage(owner.page, text);
      }
      await waitChannelUnread(member.page, READ, true, 15_000, 'tab 1');
      const state = await serverState(member.page, 'before reading');
      t.metric('serverBeforeReading', state);
      assert(state.unread >= 2, `the server counts ${state.unread} unread message(s) in "${READ}", expected at least 2`);
    });

    await t.step(`member reads "${READ}" in tab 1: the dot clears, the server marks it read`, async () => {
      await openChannel(t, member.page, channels[READ]);
      await waitMessagesShown(member.page, messages, { timeout: 15_000, who: 'tab 1' });
      await waitChannelUnread(member.page, READ, false, 10_000, 'tab 1');
      const state = await until('the server to mark the channel read', async () => {
        const s = await serverState(member.page, 'after reading');
        return s.unread === 0 && s.lastRead && s.lastMessageDate && Date.parse(s.lastRead) >= Date.parse(s.lastMessageDate) ? s : null;
      }, 15_000, 500).catch(async () => {
        const s = await serverChannelState(member.page, community.path, READ);
        throw new Error(`the server still counts ${s.unread} unread in "${READ}" (lastRead ${s.lastRead}, lastMessageDate ${s.lastMessageDate}) 15 s after the member read it`);
      });
      t.metric('serverAfterReading', state);
    });

    /** the dot stays cleared for `ms` and the server still counts the channel read */
    const staysRead = async (page: Page, who: string, where: string, ms = 5_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const unread = await channelUnread(page, READ);
        assert(unread !== null, `${who}: "${READ}" is not in the channel list (${where})`);
        assert(unread === false, `${who}: the unread dot of "${READ}" is back (${where})`);
        await sleep(300);
      }
      const s = await serverState(page, where);
      assert(s.unread === 0, `the server counts ${s.unread} unread in "${READ}" again (${where}, lastRead ${s.lastRead})`);
    };

    await t.step('reload tab 1: the dot stays cleared', async () => {
      await member.page.reload({ waitUntil: 'domcontentloaded' });
      await waitAppReady(member.page);
      await assertConnected(member.page, 'tab 1', { sinceMs: 0 });
      await waitChannelUnread(member.page, READ, false, 10_000, 'tab 1 after reload');
      await staysRead(member.page, 'tab 1', 'after reloading tab 1');
    });

    await t.step('tab 2 comes to the front: no dot there either', async () => {
      await showTab(tab2);
      await expectVisibility(member, 'hidden');
      await assertConnected(tab2.page, 'tab 2');
      await waitChannelUnread(tab2.page, READ, false, 10_000, 'tab 2');
      await staysRead(tab2.page, 'tab 2', 'tab 2 in front');
    });

    await t.step('reload tab 2: the dot stays cleared', async () => {
      await tab2.page.reload({ waitUntil: 'domcontentloaded' });
      await waitAppReady(tab2.page, { tab: true });
      await assertConnected(tab2.page, 'tab 2', { sinceMs: 0 });
      await waitChannelUnread(tab2.page, READ, false, 10_000, 'tab 2 after reload');
      await staysRead(tab2.page, 'tab 2', 'after reloading tab 2');
    });

    await t.step('back to tab 1: still cleared', async () => {
      await showTab(member);
      await assertConnected(member.page, 'tab 1');
      await staysRead(member.page, 'tab 1', 'tab 1 in front again', 3_000);
    });

    t.metric('serverLastReadHistory', serverReads);
    t.metric('setChannelLastReadSent', sent);
    await t.step('neither the server lastRead nor a tab\'s sent lastRead ever moved backwards', async () => {
      assertNeverRegressed();
    });
  },
};

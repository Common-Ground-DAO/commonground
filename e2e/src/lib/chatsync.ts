// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { FlowContext, Session } from './harness.ts';
import { signUp, type Account } from './account.ts';
import { createChannel, createCommunity, joinCommunity, navigate, type Community } from './app.ts';
import { prepareLivePage } from './live.ts';

/**
 * The common setup of the chat-sync flows (src/flows/09-…15-cs-*.ts,
 * e2e/README.md "The chat-sync flows"): an owner A with a community
 * and its channels, a member B who joined it. Both pages are prepared for
 * the live checks (connection indicator log, WebSocket list) before their
 * first load; `beforeMemberLoad` runs on B's page before B's first load
 * (e.g. a clock offset).
 */

export type OwnerAndMember = {
  owner: Session;
  member: Session;
  ownerAccount: Account;
  memberAccount: Account;
  community: Community;
  /** channel title → channel path */
  channels: Record<string, string>;
};

export async function ownerAndMember(t: FlowContext, options: {
  owner?: string;
  member?: string;
  channels?: string[];
  beforeMemberLoad?: (member: Session) => Promise<void>;
} = {}): Promise<OwnerAndMember> {
  const owner = await t.session(options.owner ?? 'owner');
  const member = await t.session(options.member ?? 'member');
  await prepareLivePage(owner.page);
  await prepareLivePage(member.page);
  await options.beforeMemberLoad?.(member);
  return t.step('setup: owner signs up and creates a community, member signs up and joins', async () => {
    const ownerAccount = await signUp(t, owner, 'password', options.owner ?? 'csowner');
    const community = await createCommunity(t, owner.page);
    const channels: Record<string, string> = {};
    for (const title of options.channels ?? []) {
      // from the community page each time: the channel settings stay on the
      // created channel's form otherwise
      await navigate(t, owner.page, community.path);
      channels[title] = await createChannel(t, owner.page, community, title);
    }
    const memberAccount = await signUp(t, member, 'password', options.member ?? 'csmember');
    await joinCommunity(t, member.page, community);
    return { owner, member, ownerAccount, memberAccount, community, channels };
  });
}

/** a tab of the member prepared like the member's first page (live checks) */
export async function liveTab(t: FlowContext, session: Session, name: string, options: { window?: boolean } = {}): Promise<Session> {
  const tab = await t.tab(session, name, options);
  await prepareLivePage(tab.page);
  return tab;
}

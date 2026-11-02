// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The memberlist service learns of a new channel from its batched
 * `channelrolepermissionchange` events. An event that arrives before the
 * community's roles were processed must be retried, not dropped — otherwise
 * the channel never gets a member list and `getChannelMemberList` has nothing
 * to answer with.
 */

import { decideChannelEvent, findAdminRoleId, MAX_CHANNEL_EVENT_DEFERRALS } from '../util/memberListChannelEvents';
import { channelMemberListOrEmpty, emptyChannelMemberList } from '../common/memberLists';
import { convertBinaryMemberListToUuid } from '../util/memberListHelpers';
import { PredefinedRole, RoleType } from '../common/enums';

const roles = new Map<string, { title: string; roleType: Common.RoleType }>([
  ['public', { title: PredefinedRole.Public, roleType: RoleType.PREDEFINED }],
  ['member', { title: PredefinedRole.Member, roleType: RoleType.PREDEFINED }],
  ['admin', { title: PredefinedRole.Admin, roleType: RoleType.PREDEFINED }],
  ['custom-admin', { title: PredefinedRole.Admin, roleType: RoleType.CUSTOM_MANUAL_ASSIGN }],
]);

describe('findAdminRoleId', () => {
  it('finds the predefined Admin role only', () => {
    expect(findAdminRoleId(roles)).toBe('admin');
    expect(findAdminRoleId(new Map([...roles].filter(([id]) => id !== 'admin')))).toBeUndefined();
    expect(findAdminRoleId(undefined)).toBeUndefined();
  });
});

describe('decideChannelEvent', () => {
  const base = { channelKnown: false, communityRoles: roles, communityHasDeferredEvent: false, deferrals: 0 };

  it('creates an unknown channel once the Admin role is known', () => {
    expect(decideChannelEvent(base)).toEqual({ action: 'create', adminRoleId: 'admin' });
  });

  it('applies events of a known channel', () => {
    expect(decideChannelEvent({ ...base, channelKnown: true })).toEqual({ action: 'apply' });
    expect(decideChannelEvent({ ...base, channelKnown: true, communityRoles: undefined })).toEqual({ action: 'apply' });
  });

  it('defers a new channel whose community roles are not processed yet', () => {
    expect(decideChannelEvent({ ...base, communityRoles: undefined })).toEqual({ action: 'defer' });
    expect(decideChannelEvent({ ...base, communityRoles: new Map() })).toEqual({ action: 'defer' });
  });

  it('keeps the order: later events of a community with a deferred event are deferred too', () => {
    expect(decideChannelEvent({ ...base, communityHasDeferredEvent: true })).toEqual({ action: 'defer' });
    expect(decideChannelEvent({ ...base, channelKnown: true, communityHasDeferredEvent: true })).toEqual({ action: 'defer' });
  });

  it('gives up after the deferral limit', () => {
    const limit = MAX_CHANNEL_EVENT_DEFERRALS;
    expect(decideChannelEvent({ ...base, communityRoles: undefined, deferrals: limit - 1 })).toEqual({ action: 'defer' });
    expect(decideChannelEvent({ ...base, communityRoles: undefined, deferrals: limit })).toEqual({ action: 'drop' });
    expect(decideChannelEvent({ ...base, communityHasDeferredEvent: true, deferrals: limit })).toEqual({ action: 'drop' });
  });

  it('a deferred event is applied in a later batch once the roles arrived', () => {
    // batch 1: roles unknown → deferred; batch 2: rolechange processed earlier in the batch
    expect(decideChannelEvent({ ...base, communityRoles: undefined })).toEqual({ action: 'defer' });
    expect(decideChannelEvent({ ...base, deferrals: 1 })).toEqual({ action: 'create', adminRoleId: 'admin' });
  });
});

describe('getChannelMemberList answer for an unknown channel', () => {
  it('is an empty member list, never an empty body', () => {
    for (const body of ['', null, undefined]) {
      expect(convertBinaryMemberListToUuid(channelMemberListOrEmpty(body))).toEqual(emptyChannelMemberList());
    }
  });

  it('passes a real list through', () => {
    const list = { ...emptyChannelMemberList(), count: 1, writerCount: 1, writer: [['x', []]] } as Models.Community.ChannelMemberList;
    expect(channelMemberListOrEmpty(list)).toBe(list);
  });
});

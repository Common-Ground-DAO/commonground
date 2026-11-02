// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { PredefinedRole, RoleType } from '../common/enums';

/**
 * How a `channelrolepermissionchange` event is handled by the memberlist
 * service. Kept apart from `memberlist.ts` (which starts the service on
 * import) so the decision can be tested.
 *
 * A channel the service does not know yet needs its community's Admin role.
 * If the community's roles have not been processed yet, the event is deferred
 * to the next batch instead of being dropped, so the channel is not lost;
 * once one event of a community is deferred, the later ones of that community
 * in the same batch are deferred too, so they keep their order.
 */

/** batches (one per second) an event may be deferred before it is dropped */
export const MAX_CHANNEL_EVENT_DEFERRALS = 60;

export type ChannelEventDecision =
  | { action: 'apply' }
  | { action: 'create'; adminRoleId: string }
  | { action: 'defer' }
  | { action: 'drop' };

export function findAdminRoleId(
  roles: ReadonlyMap<string, { title: string; roleType: Common.RoleType }> | undefined,
): string | undefined {
  for (const [roleId, roleData] of roles || []) {
    if (roleData.roleType === RoleType.PREDEFINED && roleData.title === PredefinedRole.Admin) {
      return roleId;
    }
  }
  return undefined;
}

export function decideChannelEvent(options: {
  /** the service already has role permissions for this channel */
  channelKnown: boolean;
  communityRoles: ReadonlyMap<string, { title: string; roleType: Common.RoleType }> | undefined;
  /** an earlier event of the same community was deferred in this batch */
  communityHasDeferredEvent: boolean;
  /** how often this event has been deferred already */
  deferrals: number;
}): ChannelEventDecision {
  const { channelKnown, communityRoles, communityHasDeferredEvent, deferrals } = options;
  const giveUp = deferrals >= MAX_CHANNEL_EVENT_DEFERRALS;
  if (communityHasDeferredEvent) {
    return giveUp ? { action: 'drop' } : { action: 'defer' };
  }
  if (channelKnown) {
    return { action: 'apply' };
  }
  const adminRoleId = findAdminRoleId(communityRoles);
  if (adminRoleId !== undefined) {
    return { action: 'create', adminRoleId };
  }
  return giveUp ? { action: 'drop' } : { action: 'defer' };
}

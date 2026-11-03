// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { isMemberListRefusal } from './channelMemberListPolling';

/**
 * The server tells a user's roles in a community to the signed-in user
 * themself and to the members of that community only; anyone else would get
 * a refusal, so there is nothing to ask for.
 */
export function mayLoadUserCommunityRoleIds(options: {
  ownUserId?: string;
  userId: string;
  isCommunityMember: boolean;
}): boolean {
  const { ownUserId, userId, isCommunityMember } = options;
  return !!ownUserId && (ownUserId === userId || isCommunityMember);
}

/**
 * A refusal (NOT_ALLOWED / LOGIN_REQUIRED) means the roles are not shown to
 * this caller, which is not worth a warning; other failures are.
 */
export function shouldWarnAboutRoleIdsError(error: unknown): boolean {
  return !isMemberListRefusal(error);
}

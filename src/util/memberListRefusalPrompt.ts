// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import errors from 'common/errors';
import { ApiRequestError } from 'data/api/apiError';

/**
 * What the member management view shows instead of a refused member list:
 * - `join`: a join prompt (visitors start the login from it)
 * - `pending`: the join request still waits for approval
 * - `banned`: the user is banned from the community right now
 * - `login`: a signed-in user's session was not accepted (LOGIN_REQUIRED)
 */
export type MemberListRefusalPrompt = 'join' | 'pending' | 'banned' | 'login';

export function memberListRefusalPrompt(options: {
  error: unknown;
  isLoggedIn: boolean;
  community: {
    myApplicationStatus?: string;
    blockState?: { state: string | null; until: string | null } | null;
  };
  now?: number;
}): MemberListRefusalPrompt {
  const { error, isLoggedIn, community, now = Date.now() } = options;
  const { blockState } = community;
  if (blockState?.state === 'BANNED' && (blockState.until === null || new Date(blockState.until).getTime() > now)) {
    return 'banned';
  }
  if (community.myApplicationStatus === 'PENDING') {
    return 'pending';
  }
  if (isLoggedIn && error instanceof ApiRequestError && error.message === errors.server.LOGIN_REQUIRED) {
    return 'login';
  }
  return 'join';
}

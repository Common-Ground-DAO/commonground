// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it } from 'vitest';
import errors from 'common/errors';
import { ApiRequestError } from 'data/api/apiError';
import { mayLoadUserCommunityRoleIds, shouldWarnAboutRoleIdsError } from './userCommunityRoleIds';

const ME = 'me';
const OTHER = 'other';

describe('mayLoadUserCommunityRoleIds', () => {
  it('loads the own roles, member or not', () => {
    expect(mayLoadUserCommunityRoleIds({ ownUserId: ME, userId: ME, isCommunityMember: false })).toBe(true);
    expect(mayLoadUserCommunityRoleIds({ ownUserId: ME, userId: ME, isCommunityMember: true })).toBe(true);
  });

  it('loads the roles of another user for a member of the community', () => {
    expect(mayLoadUserCommunityRoleIds({ ownUserId: ME, userId: OTHER, isCommunityMember: true })).toBe(true);
  });

  it('does not ask for another user\'s roles outside the community', () => {
    expect(mayLoadUserCommunityRoleIds({ ownUserId: ME, userId: OTHER, isCommunityMember: false })).toBe(false);
  });

  it('does not ask for a visitor', () => {
    expect(mayLoadUserCommunityRoleIds({ ownUserId: undefined, userId: OTHER, isCommunityMember: false })).toBe(false);
  });
});

describe('shouldWarnAboutRoleIdsError', () => {
  it('stays quiet about a refusal', () => {
    expect(shouldWarnAboutRoleIdsError(new ApiRequestError(errors.server.NOT_ALLOWED))).toBe(false);
    expect(shouldWarnAboutRoleIdsError(new ApiRequestError(errors.server.LOGIN_REQUIRED))).toBe(false);
  });

  it('warns about other failures', () => {
    expect(shouldWarnAboutRoleIdsError(new ApiRequestError(errors.server.UNKNOWN))).toBe(true);
    expect(shouldWarnAboutRoleIdsError(new Error('network'))).toBe(true);
  });
});

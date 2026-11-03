// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The titles of the predefined roles (Admin, Member, Public) are reserved:
 * `/Community/createRole` and `/Community/updateRole` refuse them for a
 * custom role, in any letter case and with surrounding spaces.
 */

import validators from '../validators';

const COMMUNITY = '00000000-0000-4000-8000-0000000000c1';
const ROLE = '00000000-0000-4000-8000-0000000000a1';

const createRole = (title: string) => ({
  communityId: COMMUNITY,
  title,
  type: 'CUSTOM_MANUAL_ASSIGN',
  assignmentRules: null,
  permissions: [],
  description: null,
  imageId: null,
});

describe('role title validation', () => {
  const reserved = ['Admin', 'admin', 'Member', 'MEMBER', 'Public', 'public', ' Public ', 'pUbLiC'];

  it.each(reserved)('createRole refuses "%s"', (title) => {
    expect(validators.API.Community.createRole.validate(createRole(title)).error).toBeDefined();
  });

  it.each(reserved)('updateRole refuses "%s"', (title) => {
    expect(validators.API.Community.updateRole.validate({ id: ROLE, communityId: COMMUNITY, title }).error).toBeDefined();
  });

  it.each(['Moderators', 'Publicists', 'Members+', 'Public Speakers'])('accepts "%s"', (title) => {
    expect(validators.API.Community.createRole.validate(createRole(title)).error).toBeUndefined();
    expect(validators.API.Community.updateRole.validate({ id: ROLE, communityId: COMMUNITY, title }).error).toBeUndefined();
  });

  it('updateRole without a title (a predefined role\'s permissions) still passes', () => {
    expect(validators.API.Community.updateRole.validate({ id: ROLE, communityId: COMMUNITY, permissions: [] }).error).toBeUndefined();
  });
});

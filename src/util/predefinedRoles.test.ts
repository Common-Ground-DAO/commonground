// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it } from 'vitest';
import { PredefinedRole } from 'common/enums';
import { isPredefinedRole, isPredefinedRolePermission, isPublicRole, isPublicRolePermission } from './predefinedRoles';

describe('predefined roles', () => {
  it('a role is the predefined one by type and title', () => {
    expect(isPublicRole({ title: 'Public', type: 'PREDEFINED' })).toBe(true);
    expect(isPublicRole({ title: 'Public', type: 'CUSTOM_MANUAL_ASSIGN' })).toBe(false);
    expect(isPublicRole({ title: 'Member', type: 'PREDEFINED' })).toBe(false);
    expect(isPredefinedRole({ title: 'Member', type: 'PREDEFINED' }, PredefinedRole.Member)).toBe(true);
    expect(isPredefinedRole({ title: 'Member', type: 'CUSTOM_AUTO_ASSIGN' }, PredefinedRole.Member)).toBe(false);
  });

  it('a permission entry by roleType where it has one, by title where it has none', () => {
    expect(isPublicRolePermission({ roleTitle: 'Public', roleType: 'PREDEFINED' })).toBe(true);
    expect(isPublicRolePermission({ roleTitle: 'Public', roleType: 'CUSTOM_MANUAL_ASSIGN' })).toBe(false);
    expect(isPublicRolePermission({ roleTitle: 'Public' })).toBe(true);
    expect(isPredefinedRolePermission({ roleTitle: 'Member', roleType: 'CUSTOM_MANUAL_ASSIGN' }, PredefinedRole.Member)).toBe(false);
  });
});


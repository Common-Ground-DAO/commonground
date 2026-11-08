// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, it, expect, vi, afterEach } from 'vitest';
import { channelHasCustomPermissions, permissionTypeToChannelPermissions } from './EditChannelForm.helpers';

const roles = [
  { id: 'r-public', title: 'Public', type: 'PREDEFINED' },
  { id: 'r-member', title: 'Member', type: 'PREDEFINED' },
  { id: 'r-admin', title: 'Admin', type: 'PREDEFINED' },
  { id: 'r-custom-public', title: 'Public', type: 'CUSTOM_MANUAL_ASSIGN' },
] as unknown as Models.Community.Role[];

const defaults = [
  { roleId: 'r-public', roleTitle: 'Public', permissions: ['CHANNEL_EXISTS', 'CHANNEL_READ'] },
  { roleId: 'r-member', roleTitle: 'Member', permissions: ['CHANNEL_EXISTS', 'CHANNEL_READ', 'CHANNEL_WRITE'] },
] as Models.Community.CommunityChannelPermission[];

afterEach(() => vi.restoreAllMocks());

describe('channelHasCustomPermissions', () => {
  it('treats the presets without an Admin entry as not custom, and logs nothing', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(channelHasCustomPermissions(defaults)).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });

  it('detects a changed Member permission', () => {
    const changed = [defaults[0], { ...defaults[1], permissions: ['CHANNEL_EXISTS', 'CHANNEL_READ'] }] as Models.Community.CommunityChannelPermission[];
    expect(channelHasCustomPermissions(changed)).toBe(true);
  });

  it('detects a missing Public or Member entry', () => {
    expect(channelHasCustomPermissions([defaults[1]])).toBe(true);
    expect(channelHasCustomPermissions([defaults[0]])).toBe(true);
  });

  it('still compares an Admin entry when one is present', () => {
    const withAdmin = [...defaults, { roleId: 'r-admin', roleTitle: 'Admin', permissions: ['CHANNEL_EXISTS'] }] as Models.Community.CommunityChannelPermission[];
    expect(channelHasCustomPermissions(withAdmin)).toBe(true);
  });
});

describe('permissionTypeToChannelPermissions', () => {
  it('returns the defaults for a new channel with preset toggles, without logging', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = permissionTypeToChannelPermissions(roles, { 'r-public': 'read', 'r-member': 'full' }, defaults);
    expect(result).toBe(defaults);
    expect(error).not.toHaveBeenCalled();
  });

  it('returns the custom permissions and drops "none"', () => {
    const result = permissionTypeToChannelPermissions(roles, { 'r-public': 'none', 'r-member': 'moderate' }, defaults);
    expect(result).toEqual([
      { roleId: 'r-member', roleTitle: 'Member', roleType: 'PREDEFINED', permissions: ['CHANNEL_EXISTS', 'CHANNEL_READ', 'CHANNEL_WRITE', 'CHANNEL_MODERATE'] },
    ]);
  });

  it('gives each entry the role\'s type, so a custom role with a predefined title is not taken for it', () => {
    const result = permissionTypeToChannelPermissions(roles, { 'r-public': 'none', 'r-custom-public': 'read', 'r-member': 'full' }, defaults);
    expect(result).toEqual([
      { roleId: 'r-custom-public', roleTitle: 'Public', roleType: 'CUSTOM_MANUAL_ASSIGN', permissions: ['CHANNEL_EXISTS', 'CHANNEL_READ'] },
      { roleId: 'r-member', roleTitle: 'Member', roleType: 'PREDEFINED', permissions: ['CHANNEL_EXISTS', 'CHANNEL_READ', 'CHANNEL_WRITE'] },
    ]);
    // the predefined Public role has no entry: the list differs from the presets
    expect(channelHasCustomPermissions(result)).toBe(true);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it } from 'vitest';
import { transferIdentityText } from './transferIdentity';

const userId = '0a1b2c3d-0000-4000-8000-000000000001';

describe('transferIdentityText', () => {
  it('shows the unique handle of the account', () => {
    expect(transferIdentityText({ userId, username: 'someone', identity: { type: 'cg', handle: 'someone' } })).toBe('@someone');
    expect(transferIdentityText({ userId, username: null, identity: { type: 'twitter', handle: 'someone_x' } })).toBe('X @someone_x');
    expect(transferIdentityText({ userId, username: null, identity: { type: 'farcaster', handle: 'someone.eth' } })).toBe('Farcaster @someone.eth');
    const address = '0x' + 'ab'.repeat(20);
    expect(transferIdentityText({ userId, username: null, identity: { type: 'lukso', handle: address } })).toBe(`Universal Profile ${address}`);
  });

  it('falls back to the cg name of an older answer, then to the start of the id', () => {
    expect(transferIdentityText({ userId, username: 'someone', identity: undefined as never })).toBe('@someone');
    expect(transferIdentityText({ userId, username: null, identity: null })).toBe('Account 0a1b2c3d');
  });
});

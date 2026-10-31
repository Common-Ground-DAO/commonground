// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { parseStakingConfig } from '../util/stakingConfig';

const CONTRACT = '0x' + 'a'.repeat(40);
const TOKEN = '0x' + 'B'.repeat(40);

describe('parseStakingConfig', () => {
  it('is off without chain or addresses', () => {
    expect(parseStakingConfig({})).toBeNull();
    // what the compose files pass for variables missing from the env file
    expect(parseStakingConfig({
      STAKING_CHAIN: '',
      STAKING_TOKEN_ADDRESS: '',
      STAKING_CONTRACT_ADDRESS: '',
      STAKING_BASE_RATE: '',
      STAKING_MIN_LOCK_DAYS: '',
      STAKING_MAX_LOCK_DAYS: '',
    })).toBeNull();
  });

  it('applies the defaults when the numbers are unset', () => {
    expect(parseStakingConfig({
      STAKING_CHAIN: 'eth',
      STAKING_TOKEN_ADDRESS: TOKEN,
      STAKING_CONTRACT_ADDRESS: CONTRACT,
    })).toEqual({
      chain: 'eth',
      tokenAddress: TOKEN.toLowerCase(),
      contractAddress: CONTRACT,
      baseRate: 0.012,
      minLockDays: 7,
      maxLockDays: 730,
    });
  });

  it('treats empty and blank numbers like unset ones', () => {
    expect(parseStakingConfig({
      STAKING_CHAIN: 'eth',
      STAKING_TOKEN_ADDRESS: TOKEN,
      STAKING_CONTRACT_ADDRESS: CONTRACT,
      STAKING_BASE_RATE: '',
      STAKING_MIN_LOCK_DAYS: ' ',
      STAKING_MAX_LOCK_DAYS: '',
    })).toMatchObject({ baseRate: 0.012, minLockDays: 7, maxLockDays: 730 });
  });

  it('uses explicit numbers', () => {
    expect(parseStakingConfig({
      STAKING_CHAIN: 'eth',
      STAKING_TOKEN_ADDRESS: TOKEN,
      STAKING_CONTRACT_ADDRESS: CONTRACT,
      STAKING_BASE_RATE: '0.5',
      STAKING_MIN_LOCK_DAYS: '1',
      STAKING_MAX_LOCK_DAYS: '30',
    })).toMatchObject({ baseRate: 0.5, minLockDays: 1, maxLockDays: 30 });
  });

  it('rejects invalid values', () => {
    const base = { STAKING_CHAIN: 'eth', STAKING_TOKEN_ADDRESS: TOKEN, STAKING_CONTRACT_ADDRESS: CONTRACT };
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseStakingConfig({ ...base, STAKING_CONTRACT_ADDRESS: '0x1234' })).toBeNull();
    expect(parseStakingConfig({ ...base, STAKING_BASE_RATE: 'abc' })).toBeNull();
    expect(parseStakingConfig({ ...base, STAKING_MIN_LOCK_DAYS: '10', STAKING_MAX_LOCK_DAYS: '5' })).toBeNull();
    error.mockRestore();
  });
});

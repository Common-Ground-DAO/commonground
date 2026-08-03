// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Staking configuration (docs/staking/README.md §3). The feature is off
 * unless both STAKING_CHAIN and STAKING_CONTRACT_ADDRESS are configured —
 * graceful degradation like every other optional service.
 */

export type StakingConfig = {
  chain: Models.Contract.ChainIdentifier;
  tokenAddress: Common.Address;
  contractAddress: Common.Address;
  /** Spark per CG per 365 days (roadmap §3). */
  baseRate: number;
  minLockDays: number;
  maxLockDays: number;
};

function parseConfig(): StakingConfig | null {
  const chain = process.env.STAKING_CHAIN;
  const contractAddress = process.env.STAKING_CONTRACT_ADDRESS?.toLowerCase();
  const tokenAddress = process.env.STAKING_TOKEN_ADDRESS?.toLowerCase();
  if (!chain || !contractAddress || !tokenAddress) {
    return null;
  }
  if (!/^0x[0-9a-f]{40}$/.test(contractAddress) || !/^0x[0-9a-f]{40}$/.test(tokenAddress)) {
    console.error('Staking config ignored: STAKING_CONTRACT_ADDRESS / STAKING_TOKEN_ADDRESS is not a valid address');
    return null;
  }
  const baseRate = Number(process.env.STAKING_BASE_RATE ?? '0.012');
  const minLockDays = Number(process.env.STAKING_MIN_LOCK_DAYS ?? '7');
  const maxLockDays = Number(process.env.STAKING_MAX_LOCK_DAYS ?? '730');
  if (
    !Number.isFinite(baseRate) || baseRate <= 0 ||
    !Number.isInteger(minLockDays) || minLockDays < 1 ||
    !Number.isInteger(maxLockDays) || maxLockDays < minLockDays
  ) {
    console.error('Staking config ignored: invalid STAKING_BASE_RATE / STAKING_MIN_LOCK_DAYS / STAKING_MAX_LOCK_DAYS');
    return null;
  }
  return {
    chain: chain as Models.Contract.ChainIdentifier,
    tokenAddress: tokenAddress as Common.Address,
    contractAddress: contractAddress as Common.Address,
    baseRate,
    minLockDays,
    maxLockDays,
  };
}

const stakingConfig = parseConfig();

export function getStakingConfig(): StakingConfig | null {
  return stakingConfig;
}

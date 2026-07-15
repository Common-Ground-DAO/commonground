// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Client-side mirror of the staking Spark formula
 * (docs/ROADMAP-staking.md §3). Cosmetic preview only — the accrual job's
 * exact SQL arithmetic is authoritative.
 *
 *   total(A, d) = A_tokens × rate × (d/Y) × (1 + d/Y)
 */

const YEAR_SECONDS = 365 * 86400;

/** Total Spark a stake earns over its full lock. Preview only. */
export function previewTotalSpark(tokenAmount: number, lockDays: number, baseRate: number): number {
  if (!(tokenAmount > 0) || !(lockDays > 0) || !(baseRate > 0)) return 0;
  const d = lockDays * 86400;
  return Math.floor(tokenAmount * baseRate * (d / YEAR_SECONDS) * (1 + d / YEAR_SECONDS));
}

export const stakingContractAbi = [
  {
    type: 'function',
    name: 'stake',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'lockSeconds', type: 'uint64' },
    ],
    outputs: [{ name: 'positionId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'unstake',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'positionId', type: 'uint256' }],
    outputs: [],
  },
] as const;

export const erc20MinimalAbi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

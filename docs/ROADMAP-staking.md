# Roadmap: CG Token Staking → Spark

Status: **locked** (planned 2026-07-15 with product owner; rates remain tunable
config to the end). Reviewer for all slices: the planning agent, against this
document. Implementation follows the same slice/PR discipline as
`ROADMAP-bot-accounts.md`.

## 1. What we're building

Users time-lock (stake) their CG tokens onchain for a freely chosen duration.
While tokens are locked, the user earns **Spark** (the platform currency,
stored as `users.pointBalance`, ledgered in `point_transactions`) via a daily
drip. Unstaking is only possible after the lock expires — **no early exit**.
The token page (`/token/`) Stake tab (currently "coming soon", the only
visible tab since PR #25) becomes the product surface.

Explicitly out of scope: onchain reward tokens, transferable positions,
early-exit penalties, boosting existing Spark purchases, governance.

## 2. Locked decisions

1. **Chain/token**: Ethereum mainnet, CG token
   `0xddeb1a370a88c5bcb6ec10191c03f8ec1d2bd6fa`. Verify decimals and transfer
   semantics against the deployed contract before finalizing the Solidity
   (assume standard ERC-20; abort to review if it is fee-on-transfer or
   rebasing).
2. **Freeform lock duration**, bounded by config (default 7–730 days).
3. **No early unstake.** The contract has no path to withdraw before
   `unlockAt`. Communicate this loudly in the UI.
4. **Daily drip** accrual, server-side only. Nothing about Spark exists
   onchain.
5. **Instance-configurable** (self-host story): chain, token address,
   contract address, base rate, min/max duration all come from env/instance
   config. Unset ⇒ Stake tab keeps the "coming soon" state (graceful
   degradation, like every other optional service).
6. **Deployment**: product owner funds a deployer wallet; deployment details
   are settled when Slice 1 is accepted (see §8).

## 3. Economics (tunable, defaults locked)

Spark's purchase anchor: 1 USD ⇒ 1,000 Spark (`pointsBought`, ×1000), bulk
bonuses +10%/+20% at 50k/100k. Reference prices: Supporter-1 1,000/mo,
Supporter-2 5,000/mo, URL change 5,000, Community Basic 6,999/mo.

**Total Spark for a position** of `A` CG locked `d` days:

```
spark(A, d) = A × BASE_RATE × (d / 365) × (1 + d / 365)
```

- `BASE_RATE` default **0.012 Spark per CG per 365 days**.
- The `(1 + d/365)` boost makes commitment super-linear: 1-year lock earns 2×
  pro-rata, 730-day lock 3× (cap via max duration).
- Daily drip = `spark(A, d) / d`, rounded down per day; the final day pays the
  remainder so the total is exact.

Calibration against the real holder distribution (governance vote 2025-12):
168k CG × 1y ≈ 4.0k Spark; 1M CG (median voter) × 1y = 24k Spark (2× a year
of Supporter-1); 2.5M × 1y = 60k (year of Supporter-2); 11.2M (largest) × 1y ≈
269k (~$269 equivalent). Full-cohort worst case ≈ $925/year equivalent —
acceptable emission; `BASE_RATE` is the single tuning knob.

Spark accrues **only while the staking wallet is linked to a CG account**
(`wallets` mapping, as for premium payments). Unlinked positions accrue
nothing; accrual starts at link time, not retroactively (prevents farming
from anonymous wallets, keeps the incentive to connect).

## 4. Onchain contract (Slice 1)

`contracts/contracts/CgStaking.sol`, next to `TokenSale.sol`, same hardhat
project/tooling.

- Immutable constructor params: `token` (IERC20), `minLockSeconds`,
  `maxLockSeconds`.
- `stake(uint256 amount, uint32 lockSeconds)` → `transferFrom` in, append
  position `{owner, amount, unlockAt}` to a per-owner array, emit
  `Staked(owner, positionId, amount, unlockAt)`.
- `unstake(uint256 positionId)` → require owner + `block.timestamp >=
  unlockAt` + not already unstaked; transfer back; emit
  `Unstaked(owner, positionId, amount)`.
- View helpers: `positionsOf(owner)`.
- **No owner/admin functions, no pause, no upgradeability, no rescue path.**
  Non-custodial by construction; the platform never controls user funds. If a
  circuit breaker is ever wanted, it must not touch withdrawal.
- ReentrancyGuard + checks-effects-interactions; SafeERC20; storage-minimal
  (mainnet gas). No loops over unbounded arrays in state-changing paths.
- Hardhat tests: stake/unstake happy path, early-unstake revert, double
  unstake revert, bounds enforcement, multiple concurrent positions, event
  shapes, ERC20 failure paths.

## 5. Backend (Slices 2–3)

### 5.1 Indexing (Slice 2)

- Register the staking contract as a watched contract in the existing onchain
  listener (`srv/onchain/`, GenericConnector) on `STAKING_CHAIN`. The `eth`
  listener already runs against a keyless RPC; no new infrastructure.
- New table `staking_positions`: `id` (chain+contract+positionId unique),
  `userId` (nullable — resolved via `walletHelper.getWalletOwnerId`, backfilled
  when a wallet links), `walletAddress`, `chain`, `contractAddress`,
  `positionId`, `amount` (numeric, token base units), `lockSeconds`,
  `stakedAt`, `unlockAt`, `unstakedAt` (nullable), `stakeTxHash`,
  `unstakeTxHash`, timestamps.
- Idempotency: unique on `(chain, txHash, logIndex)` for processed logs;
  reorg safety via the chain's existing `SAFE_BLOCK_DELAY`.
- Wallet-link backfill: when a wallet is linked to a user, claim its unlinked
  positions (`userId IS NULL`).

### 5.2 Accrual job (Slice 3)

- New job-runner job (daily, like `onlineStatusCheck` patterns): for each
  active position (`unstakedAt IS NULL`, `userId IS NOT NULL`, day within
  `[stakedAt, min(unlockAt, now))`), credit the daily drip.
- Ledger: `point_transactions` with a new `Models.Premium.TransactionData`
  variant `type: 'staking-accrual'` carrying `{ chain, contractAddress,
  positionId, day }`. **Idempotent per (position, day)** — enforce with a
  `staking_accruals` bookkeeping table or a unique expression index on the
  ledger data; a rerun or crashed run must never double-credit.
- Catch-up semantics: the job processes all missed days since the last
  credited day (bounded by position start), so downtime never loses accrual.
- Emits the existing `cliUserOwnData` pointBalance event so open clients see
  the balance move.

## 6. Frontend (Slice 4)

Stake tab replaces "coming soon" when staking is configured
(`window.__CG_INSTANCE__` exposes the staking config like other capability
flags):

- Wallet connect via existing infra; show CG balance (`balanceOf` read via the
  chain's public RPC from the client, as other flows do), approve + stake form:
  amount, duration slider/input (7–730 d) with **live total-Spark preview**
  using the exact backend formula, and an unmissable "locked until <date>, no
  early withdrawal" statement.
- Positions list: amount, staked/unlock dates, countdown, Spark earned so far
  / total, Unstake button once mature (or "wallet not linked — link to earn"
  callout).
- Spark balance from existing `pointBalance` displays.
- New API endpoints (session-auth): `Staking/getPositions` (own),
  `Staking/getConfig` (rates/bounds for the preview; also drives the tab
  visibility).

## 7. Configuration

Env (server) + instance-config injection (client), following the selfhost
pattern (`docker/selfhost/init.sh` documents defaults; compose files plumb
them):

```
STAKING_CHAIN=eth
STAKING_TOKEN_ADDRESS=0xddeb1a370a88c5bcb6ec10191c03f8ec1d2bd6fa
STAKING_CONTRACT_ADDRESS=            # empty until deployed ⇒ feature off
STAKING_BASE_RATE=0.012              # Spark per CG per 365d
STAKING_MIN_LOCK_DAYS=7
STAKING_MAX_LOCK_DAYS=730
```

Client must never trust its own math for accrual — the preview is cosmetic;
the job is authoritative.

## 8. Delivery slices — one branch + PR each, in order

Every PR includes a verification section with what was actually run.

### Slice 1 — Contract + tests (`feature/staking-contract`)
CgStaking.sol, full hardhat test suite, deployment script (constructor params
from env), README note in `contracts/`. Verification: `hardhat test` green;
gas report for stake/unstake included in the PR. **Deployment itself is a
separate step with the product owner (funded wallet) after review.**

### Slice 2 — Indexing (`feature/staking-indexing`)
Watched-contract integration, `staking_positions` + migration, wallet-link
backfill. Verification: hardhat-chain integration test of the listener
(pattern exists for premium events); live verification on the reference
instance can only follow contract deployment.

### Slice 3 — Accrual (`feature/staking-accrual`)
Daily job, ledger type, idempotency, catch-up. Verification: unit tests over
the drip math (incl. rounding remainder + catch-up + double-run safety);
manual run against seeded positions.

### Slice 4 — Stake tab (`feature/staking-ui`)
Full UI per §6. Verification: production build; live click-through on the
reference instance (testnet/hardhat config acceptable until mainnet deploy).

### Slice 5 — Docs + selfhost (`feature/staking-docs`)
SELFHOST.md section, init.sh defaults, compose plumbing, user-facing copy.

## 9. Working agreements

Same as bot-accounts: one PR per slice onto `develop`, reviewer verifies
against this document, verification claims spot-checked, rates and copy may
change without re-planning — architecture changes require updating this
document first. The reference instance (cg.mogged.eu) is the live test bed;
its deploys follow the worktree build procedure.

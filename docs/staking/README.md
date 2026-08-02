# Staking

> Status: verified against commit a3c3f7608, 2026-08-01.

CG token **staking** lets users time-lock their CG tokens on-chain for a freely
chosen duration and earn **Spark** (the platform currency, stored as
`users.pointBalance` and ledgered in `point_transactions`) while the tokens are
locked. Locks cannot be withdrawn early. Everything about Spark lives off-chain:
the contract only holds and returns tokens, and the backend indexes its events
to drive a server-side accrual job.

The feature is **optional and instance-configurable**. When it is not configured
the Stake tab keeps its "coming soon" state, exactly like every other optional
service.

---

## Table of Contents

1. [End-to-end architecture](#end-to-end-architecture)
2. [The CgStaking contract](#the-cgstaking-contract)
3. [Configuration](#configuration)
4. [Event indexing](#event-indexing)
5. [Data model: `staking_positions`](#data-model-staking_positions)
6. [Spark economics and accrual](#spark-economics-and-accrual)
7. [Claims sync (wallet linking)](#claims-sync-wallet-linking)
8. [API routes](#api-routes)
9. [Stake tab (frontend)](#stake-tab-frontend)
10. [Zero-Spark guard](#zero-spark-guard)

---

## End-to-end architecture

```
 Wallet (wagmi/RainbowKit)
     │  approve + stake(amount, lockSeconds)
     ▼
 CgStaking.sol ──emits──> Staked / Unstaked events
     │                         │
     │                         │ polled by the onchain microservice
     │                         ▼
     │                    srv/onchain/generic.ts  (GenericConnector)
     │                         │ recordStaked / recordUnstaked (idempotent)
     │                         ▼
     │                    staking_positions  (Postgres)
     │                         │
     │        every 6h  ┌──────┴───────────────┐
     │                  ▼                       ▼
     │         stakingAccrual job        Staking/getPositions API
     │         (pro-rata Spark →         (own positions, live totals)
     │          point_transactions        ▲
     │          + users.pointBalance)     │
     ▼                                     │
 Stake tab (src/views/TokenSale/StakeTab) ┘
```

Component map:

| Concern | Location |
| --- | --- |
| Contract | `contracts/staking/src/CgStaking.sol` (Foundry project) |
| Audit response | `contracts/staking/AUDIT-NOTES.md` |
| Config parsing | `srv/util/stakingConfig.ts` |
| Event indexing | `srv/onchain/generic.ts` |
| Repository (SQL) | `srv/repositories/staking.ts` |
| Entity / migrations | `srv/entities/staking-positions.ts`, `srv/migrations/1784170800000-*`, `1784180000000-*` |
| Accrual job | `srv/jobs/stakingAccrual.ts` (scheduled in `srv/jobs.ts`) |
| API routes | `srv/api/staking.ts` (mounted at `/Staking`) |
| Client API | `src/data/api/staking.ts`, types `src/common/types/api/staking.d.ts` |
| Shared formula/ABI | `src/common/staking.ts` |
| UI | `src/views/TokenSale/StakeTab/` |
| Roadmap (source of design decisions) | `docs/ROADMAP-staking.md` |

---

## The CgStaking contract

`CgStaking.sol` is a self-contained Foundry project (`forge-std` and the used
subset of OpenZeppelin v5 are vendored under `lib/`, no submodules). It is
non-custodial time-lock staking for a single ERC-20 token, deployed on Ethereum
mainnet against the CG token.

### Interface

| Function | Behavior |
| --- | --- |
| `constructor(IERC20 token, uint64 minLockSeconds, uint64 maxLockSeconds)` | All three are `immutable`. Reverts `InvalidConstruction` on zero token, zero min, or `min > max`. |
| `stake(uint256 amount, uint64 lockSeconds) → uint256 positionId` | Pulls `amount` via `transferFrom` (prior approval required), appends a `Position`, emits `Staked`. `nonReentrant`. |
| `unstake(uint256 positionId)` | Transfers a matured position back in full, zeroes it, emits `Unstaked`. `nonReentrant`. |
| `positionsOf(address) → Position[]` | All positions ever created by an owner (view). |
| `positionCountOf(address) → uint256` | Count of positions (view). |
| `positionOf(address, uint256) → Position` | Single position (view). |

`Position` packs into one storage slot: `uint128 amount` (0 after unstake),
`uint64 unlockAt`, `uint64 stakedAt`. Positions are per-owner **append-only
arrays**; the position id is the array index. Unstaked positions keep their
history with `amount = 0`.

Events:

```solidity
event Staked(address indexed owner, uint256 indexed positionId,
             uint256 amount, uint64 stakedAt, uint64 unlockAt);
event Unstaked(address indexed owner, uint256 indexed positionId, uint256 amount);
```

### Design properties

- **No admin, no pause, no upgrade path, no rescue/sweep.** The contract can only
  ever return exactly what was staked to the wallet that staked it. This is a
  deliberate non-custodial guarantee — the platform never controls user funds.
- **No early exit.** `unstake` reverts `PositionStillLocked` until
  `block.timestamp >= unlockAt`.
- **Exact received-amount check.** `stake` reads the vault balance before and
  after the `transferFrom` and reverts `UnsupportedTokenBehavior` if the delta
  is not exactly `amount`. This rejects fee-on-transfer / rebasing-on-transfer
  tokens at stake time so internal accounting cannot drift from the true balance
  (relevant for self-hosted instances pointing at arbitrary tokens).
- **ReentrancyGuard + checks-effects-interactions** throughout; `SafeERC20` for
  all token movements. `unstake` zeroes `amount` before transferring.
- **Bounds:** `amount` must be non-zero and `<= type(uint128).max`; `lockSeconds`
  must be within `[minLockSeconds, maxLockSeconds]`.
- `stakedAt` is stored purely so the `Staked` event carries it for the off-chain
  indexer; no on-chain branch reads it (existence is decided by array bounds and
  `amount != 0`).

### Reward accrual is off-chain

Nothing about Spark exists on-chain. Reward math is driven entirely by indexing
the `Staked`/`Unstaked` events (see [accrual](#spark-economics-and-accrual)).

### Tests and deployment

- `test/CgStaking.t.sol` — unit + fuzz suites (happy path, early-unstake revert,
  double-unstake revert, bounds, concurrent positions, event shapes, ERC-20
  failure paths).
- `test/CgStakingFork.t.sol` — mainnet-fork round-trip against the real CG token
  (`test_fork_realCgTokenStakeUnstakeRoundTrip`, `..._realCgTokenEarlyUnstakeReverts`).
- `script/DeployCgStaking.s.sol` takes constructor params from env
  (`STAKING_TOKEN_ADDRESS`, `STAKING_MIN_LOCK_DAYS`, `STAKING_MAX_LOCK_DAYS`).
  Bounds are immutable — changing them means deploying a new instance; old
  positions remain withdrawable from the old one forever.

Commands: `forge build`, `forge test`, `forge test --gas-report`, and
`ETH_RPC_URL=… forge test --match-contract Fork -vv` for the fork suite.

### Audit response

`contracts/staking/AUDIT-NOTES.md` records the disposition of a third-party
security review (2026-07-16, 5 findings + 7 informational). Highlights that are
useful for maintainers:

- The contract source is kept **byte-identical to the deploy-time source** on
  purpose: editing even a NatSpec comment changes the solc metadata hash and
  would downgrade Etherscan/Blockscout verification from *full* to *partial*
  match. Documentation corrections therefore live in the notes file, not in the
  source. The file records `sha256(src/CgStaking.sol)`.
- Two of the highest-rated findings are conditional on the staked token being
  able to change the vault's balance outside vault-initiated transfers (rebase,
  admin fee, blacklist, pause, upgrade). The notes include an on-chain
  verification table showing the CG token has none of these capabilities (no
  EIP-1967 proxy slots, no owner/pause/blacklist/mint/upgrade selectors, fixed
  supply). The `stake`-time exact-received-amount check plus these token
  properties are what make the "no admin, ever" design safe for this token.
- The notes carry a **redeploy checklist** for any future deployment against a
  different token or chain (add an unstake-time solvency re-check, a constructor
  sanity cap on `maxLockSeconds`, re-run the token verification, confirm the
  target chain supports `PUSH0`).

The notes also clarify that the header NatSpec's "accounting can never drift"
guarantee is **stake-time-only** — the check proves solvency at each stake, and
nothing re-proves it at unstake time. For the CG token this makes no difference.

---

## Configuration

Parsed once at startup by `srv/util/stakingConfig.ts`. Staking is **off** unless
`STAKING_CHAIN`, `STAKING_CONTRACT_ADDRESS`, and `STAKING_TOKEN_ADDRESS` are all
set; addresses must match `^0x[0-9a-f]{40}$` (lower-cased on read). Invalid
numeric params disable the feature with a logged error.

| Env var | Default | Meaning |
| --- | --- | --- |
| `STAKING_CHAIN` | — (required) | Chain identifier the contract is watched on (e.g. `eth`). |
| `STAKING_CONTRACT_ADDRESS` | — (required) | Deployed `CgStaking` address. Empty ⇒ feature off. |
| `STAKING_TOKEN_ADDRESS` | — (required) | The staked ERC-20 (CG token). |
| `STAKING_BASE_RATE` | `0.012` | Spark per CG per 365 days. Must be finite and `> 0`. |
| `STAKING_MIN_LOCK_DAYS` | `7` | Integer `>= 1`. |
| `STAKING_MAX_LOCK_DAYS` | `730` | Integer `>= minLockDays`. |

The base rate and bounds are surfaced to the client via `Staking/getConfig` so
the preview math and duration slider mirror the server. `getConfig` returning
`null` is what keeps the Stake tab in its "coming soon" state.

---

## Event indexing

Handled inside the existing onchain microservice's `GenericConnector`
(`srv/onchain/generic.ts`), not as a new service. On setup, if a staking config
exists whose `chain` matches the connector's chain, the connector records the
staking contract address as a watched address.

Key points:

- The staking address is matched **outside** the normal `contractListeners` map,
  so contract-type detection re-binding a listener can never displace the staking
  watch (`generic.ts:200-206`).
- Logs are decoded with a local `ethers.Interface` for the two events. Logs from
  the watched address that don't match the ABI are ignored.
- Decoded events are buffered and flushed once per log batch via
  `flushStakingEvents()`, **in log order**, so a `Staked` is always recorded
  before an `Unstaked` of the same position within one batch.
- `flushStakingEvents()` must complete **before** the chain's `lastBlock`
  cursor advances. A failure breaks the batch loop; the same block range is
  re-fetched next interval and the events re-delivered. Because the repository
  writes are idempotent (see below), re-delivery is safe and nothing is lost.
  There is no re-buffering on failure — the batch retry already re-delivers, and
  unshifting would double-buffer.
- Reorg safety uses the chain's existing `SAFE_BLOCK_DELAY` (2 blocks for `eth`);
  logs are only processed once that far behind the head.

### Idempotency model

The onchain listener has **at-least-once** delivery; the repository turns that
into **exactly-once effects**:

- `recordStaked` inserts with `ON CONFLICT ON CONSTRAINT
  UQ_staking_positions_stake_log DO NOTHING` — the `(chain, stakeTxHash,
  stakeLogIndex)` unique constraint dedupes replays.
- `recordUnstaked` is an `UPDATE … WHERE unstakedAt IS NULL`, so re-processing
  the same `Unstaked` is a no-op; unknown positions match nothing and are
  ignored.

> A fix landed in `1374a5e3f` for a parameter-type deduction bug: `recordStaked`
> reused the same `$3` placeholder against both a `varchar` column and a `text`
> comparison, which Postgres rejected. Both usage sites now cast explicitly
> (`$3::varchar` / `$3::text`). The bug was self-healing (the batch loop retried
> and the event was re-delivered, nothing lost) but wedged the eth batch cursor
> until fixed.

---

## Data model: `staking_positions`

Defined by `srv/entities/staking-positions.ts`, created in migration
`1784170800000-addStakingPositions.ts`. Rows are created by the indexer from
`Staked` events and **never deleted**; unstaking sets `unstakedAt`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid (PK) | |
| `chain` | varchar(64) | |
| `contractAddress` | varchar(50) | lower-cased |
| `walletAddress` | varchar(50) | staking owner, lower-cased |
| `positionId` | bigint | per-owner on-chain index |
| `userId` | uuid, nullable | resolved from the wallet mapping; `NULL` = unclaimed. FK to `users` `ON DELETE SET NULL`. |
| `amount` | numeric(39,0) | token base units (uint128 as string); `CHECK (amount > 0)` |
| `stakedAt` / `unlockAt` | timestamptz(3) | from the event |
| `unstakedAt` | timestamptz(3), nullable | set on `Unstaked` |
| `stakeTxHash` / `stakeLogIndex` | varchar(80) / integer | dedupe key |
| `unstakeTxHash` | varchar(80), nullable | |
| `accruedThroughDay` | date, nullable | last UTC day the accrual job credited |
| `accruedSpark` | bigint, default 0 | running total credited for this position |
| `createdAt` / `updatedAt` | timestamptz(3) | |

Uniqueness:

- `(chain, contractAddress, walletAddress, positionId)` — on-chain identity.
- `(chain, stakeTxHash, stakeLogIndex)` — processed-log dedupe.

Partial indexes: `idx_staking_positions_userId` (`WHERE userId IS NOT NULL`),
`idx_staking_positions_unclaimed_wallet` (`WHERE userId IS NULL`, for
wallet-link backfill), `idx_staking_positions_accrual_scan`
(`(accruedThroughDay) WHERE userId IS NOT NULL`).

### Runtime grants

Migration `1784180000000-grantStakingPositions.ts` adds `GRANT ALL … TO writer`
and `GRANT SELECT … TO reader`. The table was originally created without these
grants, so every query failed with `permission denied` until this migration —
the app connects as the least-privileged `writer`/`reader` roles, not the table
owner, so new tables need explicit grants.

---

## Spark economics and accrual

**Total Spark for a position** of `A` CG locked `d` days (all defaults tunable
via config, `docs/ROADMAP-staking.md` §3):

```
spark(A, d) = A × BASE_RATE × (d / 365) × (1 + d / 365)
```

- `BASE_RATE` default 0.012 Spark per CG per 365 days.
- The `(1 + d/365)` factor makes commitment super-linear: a 1-year lock earns
  2× pro-rata, a 730-day lock ~3× (capped by the max duration).

Accrual is implemented as a **continuous pro-rata target**, not a per-day loop.
Each claimed position's credited Spark equals, at any time `t`:

```
target(t) = floor( total(A, d) × min(t − stakedAt, d) / d )
```

Matured positions (`now >= unlockAt`) get the exact `floor(total)` directly — the
pro-rata ratio can floor one Spark short of it through sub-millisecond timestamp
residue otherwise. The whole expression is a SQL fragment
(`targetSparkSql` in `srv/repositories/staking.ts`) evaluated with Postgres exact
`numeric` arithmetic (token amounts are 18-decimal base units).

### The accrual job

`srv/jobs/stakingAccrual.ts` runs as a worker, scheduled in `srv/jobs.ts` at
`17 */6 * * *` (every 6 hours). If staking is not configured it exits
immediately. It calls `stakingHelper.runAccrual(config)`, which is **one atomic
SQL statement**:

1. Select claimed positions (`userId IS NOT NULL`) `FOR UPDATE … SKIP LOCKED`
   and compute each one's `targetSpark`.
2. Keep only rows where `targetSpark > accruedSpark`; `delta = target − accrued`.
3. Update `accruedSpark = target`, `accruedThroughDay = today (UTC)`.
4. Insert one `point_transactions` ledger row per position (`type:
   'staking-accrual'`, with chain/contract/positionId/periodEnd).
5. Bump `users.pointBalance` by the per-user sum of deltas, returning the
   updated users.

The job then emits a `cliUserOwnData` event to each credited user so their live
balance updates.

### Idempotency of accrual

- **Absolutely idempotent:** a rerun computes `delta = 0` and writes nothing,
  because the target is a function of *elapsed time*, not of job executions.
- **Self-catching-up:** after downtime the next run credits the full elapsed
  target in one go — cadence is cosmetic, totals are exact regardless.
- **Concurrency-safe:** `FOR UPDATE … SKIP LOCKED` makes a concurrent run a
  no-op on already-locked rows.
- **Crash-safe:** ledger insert, position update, and balance bump are the same
  statement, so they commit or roll back together.

Only positions with a `userId` accrue Spark. A matured position keeps its
`userId` after unstake, but its target is capped at `total`, so no further Spark
accrues once fully credited.

### Client preview vs. authoritative server

`src/common/staking.ts` exports `previewTotalSpark(...)`, a client-side mirror of
`spark(A, d)`. It is explicitly **cosmetic** — the accrual job's exact SQL is
authoritative. The client must never trust its own math for what is actually
credited; the preview only drives the UI (total-Spark readout, the duration
slider's reward curve, and the zero-Spark check).

---

## Claims sync (wallet linking)

Positions are indexed against a `walletAddress`. Whether a position earns Spark
depends on that wallet being **linked** to a CG account (the same `wallets`
mapping used for premium payments). `stakingHelper.syncClaimsForUser(userId)`
reconciles ownership and is called (best-effort, errors logged not thrown) after
a wallet is linked (`createWallet`) and after a wallet is deleted
(`deleteWallet`) in `srv/repositories/wallets.ts`.

Two updates run:

1. **Claim:** unclaimed positions (`userId IS NULL`) whose `walletAddress`
   matches one of the user's live wallets get `userId` set.
2. **Unclaim:** positions currently owned by the user whose wallet is no longer
   linked get `userId = NULL` (they stop accruing).

**Accrual is never retroactive.** On claim, `accruedSpark` is raised to
`GREATEST(accruedSpark, target(now))` *without crediting the difference to any
balance* — it only moves the baseline forward. From then on the accrual job pays
out growth from claim time onward, never the Spark a position "would have"
earned while its wallet was unlinked. This is the anti-farming property: staking
from an anonymous wallet and linking later yields nothing for the unlinked
period, preserving the incentive to link.

At indexing time the same principle applies: `recordStaked` resolves `userId`
from the wallet mapping right away, so a position staked from an already-linked
wallet is claimed and accrues from `stakedAt`.

---

## API routes

Mounted at `/Staking` (`srv/api.ts`), both session-authenticated POST routes
(`srv/api/staking.ts`). Login is required; a missing session throws
`LOGIN_REQUIRED`.

| Route | Request | Response | Notes |
| --- | --- | --- | --- |
| `/Staking/getConfig` | — | `{ config: Config \| null }` | Returns `chain`, token/contract addresses, `baseRate`, `minLockDays`, `maxLockDays`, or `null` when staking is unconfigured (drives tab visibility + preview). |
| `/Staking/getPositions` | — | `PositionView[]` | The caller's positions across all their linked wallets, newest first. |

`PositionView` (`src/common/types/api/staking.d.ts`) carries `amount` (base-unit
string), `stakedAt`/`unlockAt`/`unstakedAt`, `accruedSpark` (credited so far),
and `totalSpark` (the full-lock total). `totalSpark` is computed live in the
`getPositions` SQL from the same formula, so the UI can show
"earned so far / total" without trusting client math.

---

## Stake tab (frontend)

`src/views/TokenSale/StakeTab/`. The tab is the product surface of the token page
(`/token/`) — since the Phase-2 slimming (2026-08-01) it is the *only* content of
that page; the Get/Earn tabs were removed together with the token sale.

- **`StakeTab.tsx`** — main flow. On mount it loads config, positions, and the
  user's wallets in parallel. Anonymous visitors and unconfigured instances get
  the `comingSoon` element; while config is loading it shows skeletons.
  - Wallet connection uses the existing wagmi v1 + RainbowKit infra. On-chain
    reads (`balanceOf`, `allowance`) go through the chain's public RPC.
  - The primary action is a state machine: connect → switch network → check
    allowance → approve CG → stake. Staking calls `stake(amountWei,
    lockDays × 86400)` with the ABI from `src/common/staking.ts`.
  - After a successful stake/unstake it re-loads server state on a delay
    (~45 s) to give the indexer time to catch up, with a snackbar explaining the
    position appears "once the chain is indexed".
  - Positions render as `PositionRow`s showing amount, staked→unlock dates,
    countdown, `accrued / total Spark`, and an Unstake button once matured (only
    enabled when the connected wallet matches the position's wallet).
  - An unmissable "locked until the unlock date, no early withdrawal" warning is
    always shown, and a callout appears if the connected wallet is not linked to
    the CG account ("earns no Spark until you link it — and linking is never
    retroactive").
- **`LockDurationSlider.tsx`** — duration picker with a Recharts reward curve
  visualizing the super-linear `(1 + d/365)` boost while dragging.
- **`WalletOverview.tsx`** — per-wallet CG balance overview.

---

## Zero-Spark guard

Because Spark is floored to an integer, a small position can round to a lifetime
total of 0 Spark (e.g. 1 CG for a year → 0.024 → 0). To stop users time-locking
tokens for nothing, `StakeTab.tsx` computes `previewTotalSpark(...)` for the
entered amount and selected duration; when it is `0` it disables the stake button
and shows the smallest amount that would earn at least 1 Spark at that duration.

This is a **client-side UX guard** built on the cosmetic preview formula; the
authoritative Spark math remains the server's accrual SQL. The preview and the
server share the exact same formula (`src/common/staking.ts`), so the guard's
threshold matches what the server would actually credit.

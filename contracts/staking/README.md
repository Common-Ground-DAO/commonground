# CgStaking

Non-custodial time-lock staking for the CG token, per
[`docs/ROADMAP-staking.md`](../../docs/ROADMAP-staking.md). Users lock tokens
for a freely chosen duration (bounds fixed at deployment); positions cannot be
withdrawn early. There is **no admin, no pause, no upgrade path, and no rescue
function** — the contract can only ever return exactly what was staked to the
wallet that staked it. Spark accrual is fully offchain, driven by the
`Staked`/`Unstaked` events.

This is a self-contained [Foundry](https://getfoundry.sh) project.
Dependencies (`forge-std`, the used subset of OpenZeppelin v5) are vendored
under `lib/` — no submodules, no install step.

## Commands

```sh
forge build
forge test                    # unit + fuzz suites
ETH_RPC_URL=https://eth.drpc.org forge test --match-contract Fork -vv
                              # mainnet-fork verification against the real CG token
forge test --gas-report
```

## Design notes

- `stake(amount, lockSeconds)` requires a prior ERC-20 approval and rejects
  fee-on-transfer / rebasing tokens via an exact received-amount check, so
  internal accounting can never drift from the true balance (relevant for
  self-hosted instances pointing at arbitrary tokens).
- Positions are per-owner append-only arrays; ids are array indexes. Unstaked
  positions keep their history with `amount = 0`.
- Amounts are stored as `uint128` (ample for 18-decimal tokens), timestamps as
  `uint64`, so a position packs into a single storage slot.
- ReentrancyGuard + checks-effects-interactions throughout.

## Deployment

Deployment is a separately gated step (funded deployer wallet — see roadmap
§8, Slice 1):

```sh
STAKING_TOKEN_ADDRESS=0xDdeb1a370A88c5bcB6ec10191C03F8eC1d2Bd6fA \
STAKING_MIN_LOCK_DAYS=7 STAKING_MAX_LOCK_DAYS=730 \
forge script script/DeployCgStaking.s.sol \
  --rpc-url "$ETH_RPC_URL" --private-key "$DEPLOYER_KEY" --broadcast
```

Constructor parameters are immutable; changing bounds means deploying a new
instance (old positions remain withdrawable from the old one forever).

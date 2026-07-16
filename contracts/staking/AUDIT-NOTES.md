# CgStaking — third-party audit response notes

**Date:** 2026-07-16
**Contract:** `src/CgStaking.sol`, deployed on Ethereum mainnet at
[`0xEb7608f12081C8ca0b4A27979F41F5159f410F00`](https://etherscan.io/address/0xEb7608f12081C8ca0b4A27979F41F5159f410F00)
**Staked token:** Common Ground (CG),
[`0xDdeb1a370A88c5bcB6ec10191C03F8eC1d2Bd6fA`](https://etherscan.io/address/0xDdeb1a370A88c5bcB6ec10191C03F8eC1d2Bd6fA)
**Deployment parameters:** `minLockSeconds = 604800` (7 days), `maxLockSeconds = 63072000` (2 years)

A third-party security review of `CgStaking.sol` (AI-orchestrated multi-agent
pipeline, 143-line single-file scope) was received on 2026-07-16. It reported
5 findings and 7 informational items, and confirmed the core invariants
(no cross-owner access path, no reentrancy bypass, checks-effects-interactions
in `unstake`, no boundary off-by-ones). This document records our disposition
of each finding, the on-chain verification that resolves the conditional ones,
and the constraints that keep this file — rather than the contract source —
as the place for clarifications.

## Why the contract source is not being amended

The contract is deployed, immutable, and has no admin or upgrade path (by
design). Two of the audit's suggestions are wording fixes to NatSpec comments.
Editing comments does not change the compiled runtime code, but it does change
the solc metadata hash appended to the bytecode, which would downgrade
Etherscan/Blockscout source verification from *full match* to *partial match*.
`src/CgStaking.sol` is therefore kept byte-identical to the deploy-time source
permanently:

```
sha256(src/CgStaking.sol) = 4bb56c5d00f3f6e1c3f2c4d66b5b99987f9918f17807b20c949e41a94edb7f00
```

(The audit report pinned a different SHA-256 for its pasted copy of the source;
the discrepancy is whitespace normalization from the paste. Its line count and
every cited line number — L27, L59, L75, L89–91, L107, L113–119 — match this
file exactly.)

Documentation corrections the audit asked for live here instead:

- **NatSpec overpromise (contract header):** the "accounting can never drift
  from the actual balance" guarantee is *stake-time-only*. The exact-received-
  amount check in `stake()` proves solvency at the instant of each stake;
  nothing re-proves it at unstake time. For the CG token this makes no
  difference (see the token verification below), but the comment is stronger
  than what the code enforces in general.
- **`stakedAt` sentinel comment (Position struct):** the comment says `0`
  marks a never-created position, but no on-chain branch reads `stakedAt`;
  position existence is decided by array bounds and `amount != 0`. `stakedAt`
  exists solely so the `Staked` event carries it for the off-chain indexer.

## Token verification (resolves findings 1 and 5)

The two highest-rated findings are conditional on the staked token being able
to change the vault's balance outside of transfers the vault itself initiates
(rebase, admin fee toggle, blacklist, pause, upgrade). We verified on-chain
(2026-07-16) that the CG token has none of these capabilities:

| Check | Method | Result |
| --- | --- | --- |
| Upgradeable proxy | EIP-1967 implementation slot `0x360894a1…382bbc` | zero — not a proxy |
| Proxy admin | EIP-1967 admin slot `0xb5312768…5d6103` | zero |
| Owner / admin role | `owner()` (`0x8da5cb5b`), `transferOwnership` (`0xf2fde38b`) selectors in runtime bytecode | absent |
| Pausable | `pause` (`0x8456cb59`), `unpause` (`0x3f4ba83a`) selectors | absent |
| Blacklist | `addBlackList` (`0xf9f92be4`), `isBlacklisted` (`0xfe575a87`) selectors | absent |
| Mintable | `mint` (`0x40c10f19`) selector | absent |
| Upgrade function | `upgradeTo` (`0x3659cfe6`) selector | absent |
| Supply mechanics | `burn` (`0x42966c68`), `burnFrom` (`0x79cc6790`) selectors | **present** (holder-initiated only, see below) |
| Supply | `totalSupply()` | fixed 4.9e28 (49B CG) |

The only non-transfer balance mechanics are ERC20Burnable-style `burn`
(burns `msg.sender`'s own balance) and `burnFrom` (requires an allowance from
the balance holder). The vault never calls `burn` and never grants any
allowance, so **the vault's CG balance can only change through transfers the
vault itself initiates** — exactly the invariant `stake()`'s
exact-received-amount check enforces. Standard transfer semantics (exact
amounts, no fee, no hooks) were additionally confirmed by the mainnet-fork
tests in `test/CgStakingFork.t.sol`.

Selector-scan caveat: absence of a public selector is strong but not absolute
proof of absence of a mechanism. Combined with the empty EIP-1967 slots, the
fixed supply, and fork-test behavior, we consider the conclusion sound.

## Disposition of findings

| # | Finding (audit severity/confidence) | Disposition |
| --- | --- | --- |
| 1 | Stake-time-only solvency check; post-stake token behavior change creates a first-come-first-served unstake race (High / 90) | **Not applicable to this deployment.** Requires the token to alter the vault's balance outside vault-initiated transfers; the CG token verifiably cannot (see above). Adopt the suggested unstake-time balance check **if this contract is ever redeployed for a different token**. |
| 2 | No sweep/rescue path for tokens sent directly to the contract (85) | **Accepted design tradeoff.** "No admin, ever" is a deliberate property; a sweep function would reintroduce privileged surface. Tokens transferred directly instead of via `stake()` are permanently lost to the sender. |
| 3 | Unbounded `maxLockSeconds` at construction; near-`uint64.max` values panic in `stake()` (80) | **Not applicable to this deployment.** Deployed with `maxLockSeconds = 63072000` (2 years); the panic path needs values within ~2 years of `uint64.max` (~584 billion years away). Add a sanity cap on any future redeploy. |
| 4 | Unbounded per-owner `positions[]` growth; `positionsOf()` gas grows with length (80) | **Accepted; self-scoped and unused on-chain.** Only the owner can grow their own array; `stake`/`unstake` stay O(1). Nothing in this codebase calls `positionsOf()` on-chain — the backend indexes `Staked`/`Unstaked` events into Postgres and the UI reads the API. On-chain integrators should prefer `positionCountOf` + `positionOf` pagination. |
| 5 | Token-issuer blacklist/pause can strand matured funds (75) | **Not applicable to this deployment.** The CG token has no blacklist, pause, owner, or upgrade capability (see verification above). |

Informational items: `stakedAt` sentinel and NatSpec wording are addressed in
this document (see above). The `uint64(block.timestamp)` narrowing cast is
unreachable for ~584 billion years. `PUSH0` (solc 0.8.28 default) is supported
on Ethereum mainnet (Shanghai), the only deployment target.

## Checklist for any future redeploy

The deployed instance needs no changes and can accept none. If `CgStaking` is
ever deployed again (different token or different chain), fold in first:

1. **Unstake-time solvency check** (audit finding 1): revert with
   `UnsupportedTokenBehavior` if `token.balanceOf(address(this)) < amount`
   before the payout transfer — converts a silent shortfall race into a clean
   revert.
2. **Constructor sanity cap** on `maxLockSeconds` (e.g. `<= 100 * 365 days`).
3. **Soften the NatSpec** solvency claim to stake-time-only and fix the
   `stakedAt` comment.
4. **Re-run the token verification table above against the new token**, plus
   the hostile-token fork tests. The no-admin design is only safe for tokens
   whose balances cannot be changed by third parties outside of transfers.
5. Confirm the target chain supports `PUSH0`, or pin `evm_version` in
   `foundry.toml`.

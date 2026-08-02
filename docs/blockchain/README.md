# Blockchain Integration

> Status: verified against commit a3c3f7608, 2026-08-01

This document covers all blockchain-related subsystems in Common Ground: smart contracts, on-chain data reading, token-gated roles, wallet management, token staking, and the API surface connecting them. The token sale itself was removed in the Phase-2 slimming (2026-08-01) — only its contract source and its database tables remain, for auditability.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Smart Contracts](#smart-contracts)
3. [Supported Chains and Token Standards](#supported-chains-and-token-standards)
4. [RPC Providers and Running Without Paid Endpoints](#rpc-providers-and-running-without-paid-endpoints)
5. [On-chain Integration (Backend)](#on-chain-integration-backend)
6. [Blockchain Data Model (Entities)](#blockchain-data-model-entities)
7. [Token-Gated Roles](#token-gated-roles)
8. [Token Staking](#token-staking)
9. [Frontend Wallet Integration](#frontend-wallet-integration)
10. [API Routes](#api-routes)

---

## Architecture Overview

Common Ground runs a dedicated **onchain microservice** (`srv/onchain.ts`) that is separate from the main API server. This service:

- Listens on port 4000 as an internal Express server (not user-facing).
- Spawns a pool of **worker threads** (`srv/onchain/ethereumApi.ts`) that hold JSON-RPC provider connections to every active chain.
- Continuously polls chain logs to detect token transfer events, update cached balances in the database, trigger role re-evaluation, and index staking positions.
- Responds to internal HTTP requests from the main API server for contract data fetching, balance queries, and role-claimability checks.

The main API server (`srv/api/`) exposes user-facing endpoints for contract lookup, Lukso Universal Profile operations, and staking data, delegating heavy on-chain reads to the onchain microservice.

The frontend uses **wagmi v1 + RainbowKit** for wallet connection and transaction signing. It also has dedicated providers for **Aeternity** and **Lukso Universal Profile** wallets.

```
Frontend (wagmi/RainbowKit)  --->  Main API Server (srv/api/)
                                        |
                                        | internal HTTP (port 4000)
                                        v
                                   Onchain Microservice (srv/onchain.ts)
                                        |
                                        | worker threads (4x)
                                        v
                                   JSON-RPC Providers (public or paid)
```

Reward accrual for staking runs as a scheduled worker job (`srv/jobs/stakingAccrual.ts`), independent of the onchain microservice.

### Optional and Degradable

The entire blockchain layer is optional. Chains for which no working RPC endpoint is configured degrade gracefully: the onchain service's premium-token bootstrap and event-listener setup catch their own failures and log/degrade instead of crashing the process. Staking is off unless explicitly configured (see [Token Staking](#token-staking)).

---

## Smart Contracts

Two contract projects live in the repository:

- `contracts/contracts/` — the Hardhat project (the retired token-sale contract + test tokens).
- `contracts/staking/` — a self-contained **Foundry** project for `CgStaking`.

### TokenSale.sol (retired)

**File:** `contracts/contracts/TokenSale.sol`

A Solidity ^0.8.24 contract for conducting a native-currency token sale with signature-based allowlisting. The app no longer talks to it: the buy/claim UI, the `/User/getTokenSaleAllowance` allowance signer and the `trackTokenSales` indexer were removed on 2026-08-01. The source is kept as the record of the sale that ran.

**Inheritance:** `Ownable` (OpenZeppelin), `ReentrancyGuard` (OpenZeppelin)

**Key state variables:**

| Variable | Type | Purpose |
|---|---|---|
| `hardcap` | `uint208` | Maximum total investment accepted |
| `beneficiary` | `address` | Receives invested funds immediately on each investment |
| `allowanceSigner` | `address` | Signs ECDSA messages authorizing user participation |
| `startTimestamp` | `uint48` | Sale opens |
| `endTimestamp` | `uint48` | Sale closes |
| `totalInvested` | `uint208` | Running total of accepted investment |
| `investmentId` | `uint48` | Auto-incrementing ID per investment (starts at 1) |
| `paginationBlocksBy1000` | `uint256[]` | Block numbers recorded every 1000th investment for off-chain pagination |

**Key functions:**

- `invest(bytes16 userId, bytes memory allowanceSignature)` -- The main payable entry point. Validates that the sale is active, verifies the ECDSA signature over the `userId` against `allowanceSigner`, accepts up to `hardcap - totalInvested` of `msg.value`, refunds any excess to the sender, forwards the accepted amount to `beneficiary`, and emits an `Investment` event. Minimum investment is `10^15` wei (0.001 ETH).
- `setBeneficiary(address)` -- Owner-only. Updates where funds are sent.
- `setAllowanceSigner(address)` -- Owner-only. Updates who can authorize investments.
- `setStartAndEndTimestamp(uint48, uint48)` -- Owner-only. Adjusts sale window.
- `setHardcap(uint208)` -- Owner-only. Adjusts cap (must be >= `totalInvested`).

**Events:**

```solidity
event Investment(
    bytes16 indexed userId,
    uint208 investedAmount,
    uint208 saleProgressBefore,
    uint48 investmentId,
    uint48 timestamp
);
```

The `userId` is a UUID encoded as `bytes16`. The `saleProgressBefore` field reports `totalInvested` **before** the current investment is added. The backend no longer reads these events — the `investmentContract_getEvents` worker handler was removed with the token-sale code paths (2026-08-01); the contract remains on-chain as the record of the completed sale.

**Security:** Direct ETH transfers via `receive()` and `fallback()` revert with `NoDirectDepositsAllowed`. The `invest` function is protected by `nonReentrant`.

### CgStaking.sol

**File:** `contracts/staking/src/CgStaking.sol` (Solidity 0.8.28, AGPL-3.0-or-later + additional terms)

Non-custodial time-lock staking for the CG token. Users lock ERC-20 tokens for a freely chosen duration inside `[minLockSeconds, maxLockSeconds]`; positions cannot be withdrawn before their unlock time. The contract is deliberately minimal: **no admin, no pause, no upgrade path, and no rescue function** — it can only ever return exactly what was staked to the wallet that staked it. Reward (Spark) accrual is entirely off-chain, driven by indexing the emitted events.

**Inheritance:** `ReentrancyGuard` (OpenZeppelin v5, vendored under `contracts/staking/lib/`)

**Immutable configuration** (constructor args, cannot be changed after deploy):

| Field | Type | Meaning |
|---|---|---|
| `token` | `IERC20` | The staked token |
| `minLockSeconds` | `uint64` | Lower bound on lock duration (> 0) |
| `maxLockSeconds` | `uint64` | Upper bound on lock duration (>= min) |

Changing any of these means deploying a new instance; positions in the old instance stay withdrawable forever.

**Storage:** `mapping(address owner => Position[])`, append-only per owner. A `Position` packs into a single storage slot: `uint128 amount` (0 after unstake), `uint64 unlockAt`, `uint64 stakedAt` (0 marks a never-created id). Position ids are array indexes.

**Key functions:**

- `stake(uint256 amount, uint64 lockSeconds) returns (uint256 positionId)` -- `nonReentrant`. Requires a prior ERC-20 approval. Rejects zero amounts, amounts above `uint128` max, and out-of-range lock durations. Fee-on-transfer / rebasing tokens are rejected via an exact received-amount check (measured balance delta must equal `amount`), so internal accounting can never drift from the true balance. Records the position and emits `Staked`.
- `unstake(uint256 positionId)` -- `nonReentrant`. Reverts on unknown, already-unstaked, or still-locked positions; otherwise zeroes the position amount and transfers the full amount back, emitting `Unstaked`.
- `positionsOf(address)`, `positionCountOf(address)`, `positionOf(address, uint256)` -- View accessors.

**Events:**

```solidity
event Staked(address indexed owner, uint256 indexed positionId, uint256 amount, uint64 stakedAt, uint64 unlockAt);
event Unstaked(address indexed owner, uint256 indexed positionId, uint256 amount);
```

**Tests / deploy:** The Foundry project ships unit + fuzz suites (`test/CgStaking.t.sol`) and a mainnet-fork suite (`test/CgStakingFork.t.sol`). Deployment is a separately gated step via `script/DeployCgStaking.s.sol`, parameterized by `STAKING_TOKEN_ADDRESS`, `STAKING_MIN_LOCK_DAYS`, `STAKING_MAX_LOCK_DAYS`. Dependencies (`forge-std`, the used subset of OpenZeppelin v5) are vendored under `lib/` — no submodules, no install step. An `AUDIT-NOTES.md` in the project records audit-response notes.

### CgTest.sol

**File:** `contracts/contracts/CgTest.sol`

A minimal ERC-20 token for testing. Extends OpenZeppelin's `ERC20` with a public `mint(address to, uint256 amount)` function. Token name: "CgTest", symbol: "CGT". Used in local development with the Hardhat chain.

### CgLuksoTest.sol

**File:** `contracts/contracts/CgLuksoTest.sol`

A minimal LSP7 digital asset for testing on the Lukso network. Extends `LSP7DigitalAsset` from `@lukso/lsp-smart-contracts`. Has a public `mint(address to, uint256 amount, bool force, bytes memory data)` function. Token name: "CgTest", symbol: "CGT", divisible (default 18 decimals, `isNonDivisible_` = `false`), `lsp4TokenType_` = `0` (Token), deployed with `msg.sender` as owner.

---

## Supported Chains and Token Standards

### EVM Chains

The catalogue of supported chains is defined in `srv/common/config.ts` (`AVAILABLE_CHAINS`) and mirrored with numeric chain IDs in `srv/common/chainIds.ts`. The `Models.Contract.ChainIdentifier` type union (in `src/common/types/models/contract.d.ts`) enumerates the production chains:

| Chain Identifier | Chain ID | RPC env var |
|---|---|---|
| `eth` | 1 | `QUIKNODE_ETH` |
| `bsc` | 56 | `QUIKNODE_BSC` |
| `matic` | 137 | `QUIKNODE_MATIC` |
| `xdai` | 100 | `QUIKNODE_XDAI` |
| `fantom` | 250 | `QUIKNODE_FANTOM` |
| `avax` | 43114 | `QUIKNODE_AVAX` |
| `arbitrum` | 42161 | `QUIKNODE_ARBITRUM` |
| `optimism` | 10 | `QUIKNODE_OPTIMISM` |
| `base` | 8453 | `QUIKNODE_BASE` |
| `linea` | 59144 | `INFURA_LINEA` |
| `arbitrum_nova` | 42170 | `QUIKNODE_ARBITRUM_NOVA` |
| `celo` | 42220 | `QUIKNODE_CELO` |
| `polygon_zkevm` | 1101 | `QUIKNODE_POLYGON_ZKEVM` |
| `scroll` | 534352 | `QUIKNODE_SCROLL` |
| `zksync` | 324 | `QUIKNODE_ZKSYNC` |
| `lukso` | 42 | `QUIKNODE_LUKSO` (default `https://rpc.mainnet.lukso.network/`) |

**Development/test chains:** `hardhat` (31337, added only when `DEPLOYMENT === 'dev'`), `sokol` (123456, added for non-prod deployments).

> The `QUIKNODE_*` / `INFURA_*` env-var names are **historical** — any JSON-RPC URL works. See [RPC Providers](#rpc-providers-and-running-without-paid-endpoints).

Each chain has configurable `BLOCK_BATCHSIZE`, `SAFE_BLOCK_DELAY`, `UPDATE_INTERVAL`, `PROVIDER_URL`, and `PROVIDER_COOLDOWN` in `srv/onchain/settings.ts`.

### Active Chains (`CG_ACTIVE_CHAINS`)

An instance does not run all supported chains — it runs the subset declared by **`CG_ACTIVE_CHAINS`** (comma-separated). This single knob keeps backend chain workers and every frontend chain picker (token gating, wallet management) consistent:

- The backend resolves it in `srv/common/config.ts` (`resolveActiveChains()` → `config.ACTIVE_CHAINS`); unknown keys are ignored.
- If unset, it falls back to `DEFAULT_ACTIVE_CHAINS` by deployment: prod = `eth, arbitrum, xdai, base, matic, lukso`; staging = `eth, xdai, lukso`; dev = the prod set plus `hardhat`.
- The frontend receives the resolved list via the injected instance config (`srv/util/instanceConfig.ts`), so self-hosted instances offer exactly the chains their RPCs support.

The onchain microservice creates **one `GenericConnector` per active chain** (`srv/onchain/index.ts`), not one per supported chain.

### Token Standards

The system supports five token types for role-gating, defined as the `Models.Contract.OnchainData` discriminated union:

| Standard | Type Key | Metadata Fields | Used For |
|---|---|---|---|
| ERC-20 | `"ERC20"` | name, symbol, decimals | Fungible tokens |
| ERC-721 | `"ERC721"` | name, symbol | NFTs |
| ERC-1155 | `"ERC1155"` | name (optional), withMetadataURI flag | Multi-token (per-tokenId balance) |
| LSP7 | `"LSP7"` | name, symbol, decimals, tokenType | Lukso fungible digital assets |
| LSP8 | `"LSP8"` | name, symbol, tokenType | Lukso identifiable digital assets (NFT-like) |

### Non-EVM Wallet Types

The `WalletType` enum (`srv/common/enums.ts`) includes:

- `CG_EVM` -- Common Ground custodial EVM wallet
- `EVM` -- Standard EVM wallet (MetaMask, etc.)
- `FUEL` -- Fuel Network wallet
- `AETERNITY` -- Aeternity blockchain wallet
- `CONTRACT_EVM` -- Contract-based wallet (e.g., Lukso Universal Profile, Gnosis Safe)

Aeternity and Fuel wallets can be linked to user accounts for identity purposes. The frontend has dedicated providers: `src/context/AeternityWalletProvider.tsx` and `src/context/FuelWalletProvider.tsx`. Only `evm` and `contract_evm` wallet types participate in on-chain balance checks for token-gated roles.

---

## RPC Providers and Running Without Paid Endpoints

Each chain's `PROVIDER_URL` (in `srv/onchain/settings.ts`) reads from a `QUIKNODE_*` / `INFURA_*` env var (or Docker secret). The names are historical labels — any JSON-RPC URL is accepted, so operators can point a chain at a public endpoint, a self-hosted node, or a paid provider interchangeably.

**Public defaults for self-hosting.** `docker/selfhost/init.sh` prefills the env vars with verified free public endpoints (mostly `drpc.org`, plus each chain's canonical RPC), so token gating, balances, and premium payments work out of the box; operators swap in paid endpoints for scale. LUKSO is special: even in code it falls back to the official public RPC (`https://rpc.mainnet.lukso.network/`) when `QUIKNODE_LUKSO` is unset, because existing deployments predate its configurability.

> Some public endpoints restrict `eth_getLogs` (the method the event listener relies on). The self-host defaults are chosen to avoid providers that block it.

**Frontend RPCs.** The production app uses a domain-locked Alchemy key, which cannot serve self-hosted origins (CORS). `src/App.tsx` therefore detects self-hosted instances (`window.__CG_INSTANCE__`) and, for those, wires wagmi's `configureChains` with a `jsonRpcProvider` keyed by numeric chain id (matching the backend's public defaults) plus `publicProvider()` as fallback — instead of the Alchemy provider. viem's built-in public RPCs were too flaky for balance reads and transaction simulation, so explicit endpoints are used.

---

## On-chain Integration (Backend)

### Microservice Entry Point

**File:** `srv/onchain.ts`

This is the onchain microservice process. It:

1. Starts an Express server on port 4000 with internal-only endpoints (see [API Routes](#onchain-microservice-internal-port-4000)).
2. On startup, if `RECALCULATE_BALANCES_AND_ROLES=true`, it re-evaluates all token-gated roles for every community member by querying on-chain balances and updating database role assignments.
3. Listens for PostgreSQL `NOTIFY` events on channels `contractchange` and `walletchange` to react to new contracts being added or wallets being created/deleted.
4. On startup, loads all known contracts from the database and begins watching them via the `GenericConnector` (one per active chain).

### GenericConnector

**File:** `srv/onchain/generic.ts`

Each active chain gets one `GenericConnector` instance. This is the core class that:

- **Detects contract types** by calling `detectContractType()`.
- **Fetches contract metadata** (name, symbol, decimals) via RPC calls through the worker pool.
- **Watches contracts** by registering event handler functions per contract address (`contractListeners`).
- **Runs an event listener loop** (`_getLogsInterval`) that periodically polls `eth_getLogs` in batches from `lastBlock+1` to the current block (capped at 20 batches per cycle), dispatches matching logs to the appropriate handler, and updates `chaindata` in the database.
- **Handles premium payments** by detecting ERC-20 transfers and native value transfers to a beneficiary address, converting them to in-app "spark" tokens.
- **Handles Universal Profile changes** by watching `DataChanged` events on LSP3 profile contracts and syncing name/avatar updates to the user database.
- **Indexes staking events** for the configured staking contract (see below).

**Event handlers by token type:**

| Handler | Event Signature | Token Type |
|---|---|---|
| `erc20Handler` | `Transfer(address,address,uint256)` | ERC-20 |
| `erc721Handler` | `Transfer(address,address,uint256)` (indexed tokenId) | ERC-721 |
| `erc1155Handler` | `TransferSingle(...)` / `TransferBatch(...)` | ERC-1155 |
| `lsp7Handler` | `Transfer(address,address,address,uint256,bool,bytes)` | LSP7 |
| `lsp8Handler` | `Transfer(address,address,address,bytes32,bool,bytes)` | LSP8 |
| `universalProfileHandler` | `DataChanged(bytes32,bytes)` on ERC725Y | Universal Profile |

After processing a batch of events, the connector calls `logHelper.flush()` which updates cached balances in the database, then checks if any users may have lost access to token-gated roles and triggers re-evaluation.

### Staking Event Indexing

**File:** `srv/onchain/generic.ts` (staking slice)

When staking is configured (`getStakingConfig()` returns non-null) and its `chain` matches a connector, that connector records the staking contract address (`stakingAddress`). The event loop fetches all logs in each block range and, for logs whose address equals `stakingAddress`, parses them against the `Staked`/`Unstaked` ABI (`handleStakingLog`) and buffers typed events. This dispatch lives deliberately outside the `contractListeners` map so contract-type detection can never displace the staking watch.

At the end of each batch — **before** `lastBlock` advances — `flushStakingEvents()` writes the buffered events to the database via `stakingHelper.recordStaked` / `recordUnstaked`, in log order. Repository writes are idempotent, so the loop's at-least-once delivery yields exactly-once effects on retry. See [Token Staking](#token-staking).

### EthereumApi (Worker Pool)

**File:** `srv/onchain/ethereumApi.ts`

This file runs as **both** main thread and worker thread code, gated by `isMainThread`.

**Main thread (`EthereumApi` class):**
- Spawns `NUM_BACKEND_WORKERS` (4) worker threads.
- Distributes RPC requests across workers via round-robin.
- Manages promise resolution/rejection by `requestId`.
- Supports request timeouts (default 35s) and a `'never'` timeout option for long-running tasks.

**Worker thread:**
- Creates a `JsonRpcProvider` (ethers.js v6) per chain, each with its own `FetchRequest` and static network.
- Maintains a priority queue (`HIGH > MEDIUM > LOW > retry`).
- Processes one request at a time with cooldown between requests.
- Retries failed requests up to `MAX_RETRIES` (10).
- Reports stats (scheduled/finished/retries) to the parent periodically.

**Supported RPC call types** (the `RPCCallType` union):

- `getBlockNumber`, `getBlockTransactions`, `getStorage`, `getCode`, `getLogs`
- `getSingleTransactionData` -- Fetches a transaction and its receipt, extracting ERC-20 Transfer events and native value transfers
- `ERC_20_contract.{name,symbol,decimals,balanceOf}`
- `ERC_721_contract.{name,symbol,balanceOf}`
- `ERC_1155_contract.balanceOf`
- `ERC_725Y_contract.{getData,getDataBatch}`
- `LSP_7_contract.{decimals,balanceOf}`
- `LSP_8_contract.balanceOf`
- `ERC_165_contract.supportsInterface`
- Proxy detection: `EIP_897_contract.implementation`, `EIP_1167_beaconContract.{implementation,childImplementation}`, `GNOSIS_SAFE_PROXY_contract.masterCopy`

### Contract Type Detection

**File:** `srv/onchain/detectContract.ts`

Determines what token standard a contract implements, using a two-phase approach:

1. **ERC-165 `supportsInterface` check** -- If the contract supports ERC-165, it queries for ERC-20, ERC-721, ERC-1155, LSP7 (two known interface IDs), and LSP8 support hashes.
2. **Bytecode sighash scanning** -- If ERC-165 is not supported, fetches the contract's deployed bytecode and checks if all function selectors for ERC-20, ERC-721, or ERC-1155 are present.
3. **Proxy detection fallback** -- If direct detection fails, it attempts proxy resolution (see below) and re-runs bytecode scanning on the implementation contract.

### Proxy Detection

**File:** `srv/onchain/detectProxy.ts`

Resolves proxy contracts to their implementation addresses. Checks in order:

1. **EIP-1967 direct proxy** -- Reads the implementation address from the EIP-1967 implementation storage slot.
2. **EIP-1967 beacon proxy** -- Reads the beacon address from storage, then calls `implementation()` or `childImplementation()` on the beacon.
3. **OpenZeppelin proxy** -- Reads from the `org.zeppelinos.proxy.implementation` storage slot.
4. **EIP-1822 UUPS** -- Reads from the `PROXIABLE` storage slot.
5. **EIP-1167 minimal proxy** -- Parses the clone bytecode to extract the implementation address.
6. **EIP-897 DelegateProxy** -- Calls `implementation()` directly.
7. **Gnosis Safe proxy** -- Calls `masterCopy()`.

### LogHelper (Balance Cache Updates)

**File:** `srv/onchain/loghelper.ts`

Accumulates transfer events during an event-polling cycle. On `flush()`:

1. Collects all (wallet, contract) address pairs that were involved in transfers.
2. Fetches existing balance records from the database for those pairs.
3. Applies transfer events chronologically: increments the receiver's balance, decrements the sender's balance. Uses block number ordering and a `_dirty` flag to handle same-block events.
4. Upserts only modified ("dirty") balance records back to the database.

Supports all five token types (ERC20, ERC721, ERC1155, LSP7, LSP8) with type-specific balance update logic.

### Lukso Universal Profile

**File:** `srv/onchain/lukso.ts`

Uses the `@erc725/erc725.js` library to interact with Lukso Universal Profiles:

- `isValidSignature(chain, {address, signature, message})` -- Validates a signature against a Universal Profile using ERC-1271.
- `getUniversalProfileData(chain, {address})` -- Fetches the `LSP3Profile` data key, resolves IPFS URIs, and returns `{ username, profileImageUrl, description }`. The username is suffixed with `#XXXX` (first 4 hex chars of the address).

### Scheduler

**File:** `srv/onchain/scheduler.ts`

Provides `Scheduler` and `ParallelScheduler` classes with priority queues (`HIGH=0`, `MEDIUM=1`, `LOW=2`) and timeout/cancellation support via the `Job` class. The current architecture primarily uses the `EthereumApi` worker pool for RPC scheduling, but the `OnchainPriority` enum from this file is used throughout.

### ABIs

**File:** `srv/onchain/abis.ts`

Exports human-readable ABI arrays for:
- ERC-165, ERC-20, ERC-721, ERC-1155 (with event variants)
- ERC-173 (ownership), ERC-725Y (key-value store)
- LSP7, LSP8 (full ABIs including inherited ERC-173 and ERC-725Y)
- `CGCommunity_abi` -- A custom contract interface with `adminOf`, `levelOf`, `featuresOf`

---

## Blockchain Data Model (Entities)

All entities use TypeORM. Database is PostgreSQL.

### Contract (`contracts` table)

**File:** `srv/entities/contracts.ts`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID (PK) | Auto-generated |
| `chain` | varchar(64) | `ChainIdentifier` value |
| `address` | varchar(50) | Lowercase hex address |
| `data` | jsonb | Discriminated union: `OnchainData` (type + name/symbol/decimals) |
| `updatedAtBlock` | bigint | Last block number when contract data was refreshed (nullable) |
| `createdAt` | timestamptz | |
| `updatedAt` | timestamptz | |

**Unique constraint:** `(chain, address)`

**Relations:**
- Many-to-many with `Role` (a role can reference contracts via gating rules)
- One-to-many with `WalletBalance`

### Wallet (`wallets` table)

**File:** `srv/entities/wallets.ts`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID (PK) | Auto-generated |
| `userId` | UUID (FK) | References `users.id`, nullable, SET NULL on delete |
| `type` | enum | `WalletType`: `cg_evm`, `evm`, `fuel`, `aeternity`, `contract_evm` |
| `walletIdentifier` | text | The wallet address or identifier |
| `loginEnabled` | boolean | Whether this wallet can be used for login |
| `visibility` | enum | `WalletVisibility`: `private` or `public` |
| `signatureData` | jsonb | Contains the signature proof and optional contract data (for `contract_evm` wallets, includes `contractData` with type like `universal_profile`) |
| `chain` | varchar(64) | Nullable; set for `contract_evm` wallets to restrict balance checks to that chain |
| `createdAt` | timestamptz | |
| `updatedAt` | timestamptz | |
| `deletedAt` | timestamptz | Soft delete |

**Unique constraints:** `(type, walletIdentifier)` and `(type, walletIdentifier, chain)`

### WalletBalance (`wallet_balances` table)

**File:** `srv/entities/wallets.ts`

| Column | Type | Notes |
|---|---|---|
| `walletId` | UUID (composite PK, FK) | References `wallets.id`, CASCADE delete |
| `contractId` | UUID (composite PK, FK) | References `contracts.id`, CASCADE delete |
| `balance` | jsonb | Discriminated union by token type (see below) |
| `updatedAt` | timestamptz | |

**Balance JSONB structure** (from `Models.Contract.WalletBalance`):

```typescript
// ERC20/LSP7:  { type, blockHeight, amount }
// ERC721/LSP8: { type, blockHeight, amount, tokenIds? }
// ERC1155:     { type, data: [{ blockHeight, tokenId, amount }] }
```

This table acts as a **cache** of on-chain balances. The onchain service updates it both reactively (via event log processing in `LogHelper`) and proactively (during role-claimability checks, which re-fetch from chain with a configurable probability, `RECHECK_BALANCE_PROBABILITY`).

### StakingPosition (`staking_positions` table)

**File:** `srv/entities/staking-positions.ts`

One row per on-chain CgStaking position, created by the onchain listener from `Staked` events and never deleted (unstaking sets `unstakedAt`).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID (PK) | Auto-generated |
| `chain` | varchar(64) | `ChainIdentifier` |
| `contractAddress` | varchar(50) | Staking contract (lowercase) |
| `walletAddress` | varchar(50) | Position owner address (lowercase) |
| `positionId` | bigint | Per-owner position index inside the contract |
| `userId` | UUID (FK, nullable) | Resolved from the wallet mapping; SET NULL on user delete |
| `amount` | numeric(39,0) | Token base units (uint128) as string |
| `stakedAt` | timestamptz(3) | From the event |
| `unlockAt` | timestamptz(3) | From the event |
| `unstakedAt` | timestamptz(3) | Set when the `Unstaked` event is indexed (nullable) |
| `stakeTxHash` / `stakeLogIndex` | varchar / integer | Stake event coordinates |
| `unstakeTxHash` | varchar | Nullable |
| `accruedThroughDay` | date | Last UTC day the accrual job credited |
| `accruedSpark` | numeric | Spark credited so far (see staking section) |

**Unique constraints:** `(chain, contractAddress, walletAddress, positionId)` and `(chain, stakeTxHash, stakeLogIndex)` — both make indexing idempotent. Additional partial indexes support unclaimed-wallet backfill and the accrual scan.

`userId` is resolved from the wallet mapping at indexing time and backfilled/cleared as wallets are linked and deleted. Only positions with a `userId` accrue Spark.

### ChainData (`chaindata` table)

**File:** `srv/entities/chaindata.ts`

| Column | Type | Notes |
|---|---|---|
| `id` | varchar(255) (PK) | The `ChainIdentifier` |
| `data` | json | Contains `{ lastBlock: number }` -- the most recent block that was scanned for events |

This is the cursor for the event listener loop. Each chain tracks its own `lastBlock` so the system resumes from the correct position after restart.

### UserCommunityAirdrop (`user_community_airdrops` table)

**File:** `srv/entities/airdrops.ts`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID (PK) | Auto-generated |
| `communityId` | UUID (FK) | References `communities.id`, CASCADE |
| `roleId` | UUID (FK) | References `roles.id`, CASCADE |
| `userId` | UUID (FK) | References `users.id`, CASCADE |
| `airdropData` | jsonb | `Models.Community.UserAirdropData` |
| `airdropEndDate` | timestamptz | Expiration date |

Used for distributing token-based rewards to community members based on role membership.

### TokenSale Entities (retired, kept for auditability)

**File:** `srv/entities/tokensale.ts`

These four tables are no longer read or written by any code path; they retain the
records of the sale that ran.

**`tokensale_registrations` table (TokenSaleRegistration):**

| Column | Type | Notes |
|---|---|---|
| `id` | UUID (PK) | |
| `userId` | UUID (FK, nullable) | |
| `email` | varchar | Indexed with lowercase unique constraint |
| `referredBy` | UUID (FK, nullable) | Referral tracking |
| `oneDayEmailSentAt` | timestamptz | Email notification tracking |
| `startsNowEmailSentAt` | timestamptz | Email notification tracking |

**`tokensales` table (TokenSale):**

| Column | Type | Notes |
|---|---|---|
| `id` | UUID (PK) | |
| `name` | text | Sale name |
| `saleContractChain` | varchar(64) | Chain where the sale contract is deployed |
| `saleContractAddress` | varchar(50) | Address of the sale contract |
| `saleContractType` | varchar(50) | Currently only `'cg_tokensale_v1'` |
| `targetTokenChain` | varchar(64) | Chain where the purchased token lives |
| `targetTokenAddress` | varchar(50) | Token contract address |
| `targetTokenDecimals` | integer | Token decimals |
| `recentUpdateBlockNumber` | bigint | Last block processed for this sale's events |
| `totalInvested` | varchar(255) | Running total (stored as string for big number precision) |
| `startDate` / `endDate` | timestamptz | Sale window |

**`tokensale_userdata` table (TokenSaleUserData):**

Composite PK: `(userId, tokenSaleId)`. Tracks per-user investment data:

| Column | Type | Notes |
|---|---|---|
| `totalInvested` | decimal(80,0) | User's total investment |
| `totalTokensBought` | decimal(80,0) | Tokens allocated |
| `referralBonus` | decimal(80,0) | Bonus from referrals |
| `referredUsersDirectCount` | integer | Direct referral count |
| `referredUsersIndirectCount` | integer | Indirect referral count |
| `rewardProgram` | jsonb | Custom reward program data |
| `targetAddress` | varchar(50) | Address to receive tokens |

**`tokensale_investments` table (TokenSaleInvestment):**

Composite PK: `(investmentId, tokenSaleId)`. Each on-chain `Investment` event is stored here:

| Column | Type | Notes |
|---|---|---|
| `investmentId` | bigint | From the on-chain event |
| `tokenSaleId` | UUID (FK) | |
| `userId` | UUID (FK) | Decoded from the on-chain `bytes16 userId` |
| `event` | jsonb | Full `SaleInvestmentEventJson` data |

### PointTransaction (`point_transactions` table)

**File:** `srv/entities/transactions.ts`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID (PK) | |
| `userId` | UUID (nullable) | |
| `communityId` | UUID (nullable) | |
| `amount` | integer | Spark/point amount |
| `data` | jsonb | `Models.Premium.TransactionData` -- transaction metadata |

Records in-app currency ("sparks") transactions, including those originating from on-chain premium payments (`GenericConnector.premiumPaymentHandler`) and from staking accrual (`data.type = 'staking-accrual'`).

---

## Token-Gated Roles

This is the primary use of blockchain data in Common Ground. Community administrators can create roles with `assignmentRules` of type `"token"`, which gate role access based on token ownership.

### Data Model

Defined in `src/common/types/models/community.d.ts`:

```typescript
type AssignmentRules = {
  type: 'free';          // No token requirement
} | {
  type: "token";
  rules: AccessRules;    // One or two gating rules
};

type AccessRules = {
  rule1: GatingRule;
} | {
  rule1: GatingRule;
  rule2: GatingRule;
  logic: "and" | "or";   // How to combine rule1 and rule2
};

type GatingRule =
  | { type: 'ERC20';  contractId: string; amount: `${number}` }
  | { type: 'ERC721'; contractId: string; amount: `${number}` }
  | { type: 'ERC1155'; contractId: string; tokenId: `${number}`; amount: `${number}` }
  | { type: 'LSP7';   contractId: string; amount: `${number}` }
  | { type: 'LSP8';   contractId: string; amount: `${number}` };
```

A role can have up to **two gating rules** combined with **AND or OR logic**. Each rule specifies a contract (by internal UUID, resolved to chain + address from the `contracts` table), a token type, and a minimum balance amount. For ERC-1155, a specific `tokenId` is also required.

### Evaluation Flow

Implemented in `srv/onchain/index.ts`, function `_checkRoleClaimability`:

1. Extract all `contractId`s referenced by the role's assignment rules.
2. Load contract data from the database (`contracts` table).
3. Load all wallets for the user with types `evm` or `contract_evm`.
4. Load existing cached balances from `wallet_balances` for those (wallet, contract) pairs.
5. For each (rule, wallet) pair:
   - If no cached balance exists, or if a re-check is triggered (`RECHECK_BALANCE_PROBABILITY`), query the chain via the worker pool (`ethereumApi.requestData`).
   - Otherwise, use the cached balance.
   - Contract-evm wallets are only checked on the chain they are bound to, and only chains in `ACTIVE_CHAINS` are queried.
   - Deduplicate concurrent requests for the same (token type, chain, contract, wallet) combination.
6. Sum balances across all wallets for each rule.
7. Compare the sum against the rule's `amount` threshold (raw token base units).
8. Apply AND/OR logic if there are two rules.
9. **Grant the role** (via `communityHelper.giveUserUnclaimedRoles`) if the user qualifies but doesn't already have it.
10. **Remove the role** (via `communityHelper.removeUserFromUnclaimableRoles`) if the user no longer qualifies.
11. Persist any updated balance data to `wallet_balances`.

### Reactive Re-evaluation

When the event listener loop detects transfer events for watched contracts:

1. `LogHelper.flush()` identifies which wallets had balance changes.
2. `walletHelper.getRoleAccessByWalletsAndContracts()` finds which roles and users are affected.
3. `checkRoleClaimability` is called for each affected user/role pair with priority based on whether the user is currently online.

### Batch Re-evaluation

The `checkCommunityRoleClaimability` function evaluates token-gated roles in a community for a given user at once and evaluates them in a single call to `_checkRoleClaimability`.

The `RECALCULATE_BALANCES_AND_ROLES` environment variable triggers a full re-evaluation of all token-gated roles across all communities on service startup.

---

## Token Staking

Staking lets users time-lock the CG token in the `CgStaking` contract and earn **Spark** (the in-app point currency) proportional to amount and lock duration. The contract is described in [Smart Contracts](#cgstakingsol); this section covers the off-chain half.

### Configuration

**File:** `srv/util/stakingConfig.ts`

Staking is **off unless configured**, like every other optional service. It is enabled only when `STAKING_CHAIN`, `STAKING_CONTRACT_ADDRESS`, and `STAKING_TOKEN_ADDRESS` are all set (addresses must match `0x` + 40 hex). Additional tunables (with defaults):

| Env var | Default | Meaning |
|---|---|---|
| `STAKING_BASE_RATE` | `0.012` | Spark per CG token per 365 days |
| `STAKING_MIN_LOCK_DAYS` | `7` | Minimum lock (integer ≥ 1) |
| `STAKING_MAX_LOCK_DAYS` | `730` | Maximum lock (integer ≥ min) |

`getStakingConfig()` parses this once at load; invalid values disable the feature with a logged error. The chain must also be in `CG_ACTIVE_CHAINS` for the connector to watch the contract.

### Accrual Formula

**File:** `srv/repositories/staking.ts`

For a position of `A` tokens (18-decimal base units) locked for duration `d` seconds, with `Y = 365 × 86400`:

```
total(A, d) = A_tokens × rate × (d / Y) × (1 + d / Y)
target(t)   = floor(total × min(t − stakedAt, d) / d)
```

`total` is the Spark a fully matured position earns; `target(t)` is the pro-rata amount accrued by time `t`. Matured positions receive the exact `total` (avoiding a one-Spark floor loss from sub-millisecond timestamp residue). The formula is implemented as Postgres exact-numeric SQL (`targetSparkSql`). The frontend mirrors `total` for a cosmetic preview in `src/common/staking.ts` (`previewTotalSpark`); the SQL is authoritative.

### Accrual Job

**File:** `srv/jobs/stakingAccrual.ts`, scheduled in `srv/jobs.ts` (`stakingAccrual`, cron `17 */6 * * *` — every 6 hours).

Runs only if staking is configured. `stakingHelper.runAccrual(config)` executes as one atomic statement: it locks due position rows (`FOR UPDATE ... SKIP LOCKED`, so concurrent runs are no-ops), computes `target − accruedSpark` per claimed position, writes the positive deltas to the `point_transactions` ledger (`type = 'staking-accrual'`), bumps user balances, and advances each position's `accruedSpark` / `accruedThroughDay`. It is fully idempotent — a rerun computes delta 0 — and self-catching-up after downtime because the target is a function of elapsed time, not of job executions. Credited users get a `cliUserOwnData` event so their balance updates live.

### Claim Ownership

Positions are indexed against a wallet address; the owning `userId` is resolved from the wallet mapping at insert time. When a wallet is linked or deleted, `syncClaimsForUser(userId)` re-derives ownership. Newly claimed positions start accruing from **claim time, not retroactively**: `accruedSpark` is raised to the position's current pro-rata target without crediting it, so only growth from that point on is paid out.

### Zero-Spark Guard (Frontend)

Because Spark is credited as an integer, very small stakes would floor to a lifetime total of zero. `src/views/TokenSale/StakeTab/StakeTab.tsx` previews the total, explains the minimum viable amount for the selected duration, and disables the stake button when the position would earn zero Spark.

---

## Frontend Wallet Integration

### Wallet Libraries

**File:** `src/App.tsx`

The app is wrapped in:

- `WagmiConfig` (wagmi v1) configured via `configureChains` over `activeChains`: `mainnet, polygon, optimism, arbitrum, gnosis, bsc, fantom, avalanche, zkSync, base` (plus `hardhat` when `DEPLOYMENT === 'dev'`).
- `RainbowKitProvider` for the wallet connection modal (supports dark/light themes).
- Provider chain: the hosted app uses `alchemyProvider(...)` + `publicProvider()`; self-hosted instances use a `jsonRpcProvider` (public RPC per chain id) + `publicProvider()` instead — see [RPC Providers](#rpc-providers-and-running-without-paid-endpoints).

`getDefaultWallets` from RainbowKit sets up MetaMask, Coinbase Wallet, WalletConnect, etc. The WalletConnect `projectId` comes from `config.WALLETCONNECT_PROJECT_ID` (self-hosted instances set their own via `CG_WALLETCONNECT_PROJECT_ID`, since project ids are origin-allowlisted upstream).

### Additional Wallet Providers

- **`AeternityWalletProvider`** (`src/context/AeternityWalletProvider.tsx`) -- Manages Aeternity wallet connection.
- **`UniversalProfileProvider`** (`src/context/UniversalProfileProvider.tsx`) -- Manages Lukso Universal Profile connection.
- **`FuelWalletProvider`** (`src/context/FuelWalletProvider.tsx`) -- Manages Fuel Network wallet connection.

### UserOnchainProvider

**File:** `src/context/UserOnchainProvider.tsx`

Provides a `trackTransaction(hash, chain, text)` function that monitors pending transactions. Uses `usePublicClient` from wagmi to get a viem client and converts it to an ethers.js provider via `clientToProvider()`. Tracks transactions per chain and shows snackbar notifications on completion.

Exports `useEthersProvider()` hook for components that need an ethers.js provider (bridge between viem/wagmi and ethers.js).

### Wallet Management View

**File:** `src/views/WalletManagementView/WalletManagementView.tsx`

A mobile-only view that renders the `WalletsManagement` component. On desktop, wallet management is accessed via a modal dialog on the profile view.

### Token / Staking View

**File:** `src/views/TokenSale/TokenSale.tsx`

Since the Phase-2 slimming the `/token/` page is a header plus the stake tab; the
buy/claim flow, the charts and the `cgTokensale_v1_abi` are gone.

The **StakeTab** (`src/views/TokenSale/StakeTab/StakeTab.tsx`) handles staking: it reads/writes via wagmi (`useContractRead`, `useContractWrite`, `useWaitForTransaction`), using the `stakingContractAbi` and `erc20MinimalAbi` from `src/common/staking.ts`. The flow is ERC-20 `approve` then `stake(amount, lockSeconds)`, plus `unstake(positionId)` for matured positions. Positions and config are fetched from the backend (`src/data/api/staking.ts`).

### SafeAndUpgradesView

**File:** `src/views/SafeAndUpgradesView/SafeAndUpgradesView.tsx`

Renders the `PremiumManagement` component, which handles premium feature purchases using on-chain payments (sparks). This view supports both mobile and desktop layouts.

### Key Frontend Files for Wallet Operations

| File | Purpose |
|---|---|
| `src/components/organisms/WalletsEditor/WalletsEditor.tsx` | Add/remove wallets from user account |
| `src/components/organisms/UserOnboarding/RainbowSign/RainbowSign.tsx` | Sign-in with EVM wallet |
| `src/components/organisms/UserOnboarding/ConnectWalletButton/ConnectWalletButton.tsx` | Wallet connection button |
| `src/components/organisms/UserOnboarding/ConnectWalletButton/ConnectAeternityWalletButton.tsx` | Aeternity-specific connection |
| `src/components/organisms/UserSettingsModalContent/SignWalletPage/SignWalletPage.tsx` | Wallet signing flow in settings |
| `src/components/organisms/UserSettingsModalContent/PaySpark/PaySpark.tsx` | On-chain spark purchases |
| `src/components/molecules/WalletManagerRow/WalletManagerRow.tsx` | Individual wallet display/management |

---

## API Routes

### Onchain Microservice (Internal, Port 4000)

**File:** `srv/onchain.ts`

These endpoints are called by the main API server, not by the frontend directly.

| Method | Path | Request Body | Response | Description |
|---|---|---|---|---|
| POST | `/getContractData` | `{ chain, address, skipWatch? }` | Contract metadata (type, name, symbol, decimals) | Detects contract type and fetches metadata from chain. Registers the contract for event watching unless `skipWatch=true`. |
| POST | `/checkRoleClaimability` | `{ userId, roleId, assignmentRules, priority }` | `{ data: boolean }` | Checks if a single user qualifies for a single token-gated role. |
| POST | `/checkMultiRoleClaimability` | `{ userId, roleData[], priority }` | `{ data: {roleId, claimable}[] }` | Checks multiple roles for a single user in one call. |
| POST | `/checkCommunityRoleClaimability` | `{ userId, communityId }` | `{ data: {roleId, claimable}[] }` | Checks token-gated roles in a community for a user. |
| POST | `/luksoIsValidSignature` | `{ address, signature, message }` | `{ isValidSignature: boolean }` | ERC-1271 signature validation for Lukso Universal Profiles. |
| POST | `/luksoGetUniversalProfileData` | `{ address }` | `{ username, profileImageUrl, description }` | Fetches LSP3 profile data. |
| POST | `/getSingleTransactionData` | `{ chain, txHash }` | `{ found, initiatorAddress?, transfers[] }` | Gets transaction details including ERC-20 and native transfers. |
| POST | `/getErc20Balance` | `{ chain, contractAddress, walletAddress }` | `{ balance }` | Direct ERC-20 balance query. |
| POST | `/getBlockNumber` | `{ chain }` | `{ blockNumber }` | Gets the current block number for a chain. |

### Main API Server (User-Facing)

**Contract Routes** (`srv/api/contracts.ts`):

| Method | Path | Request | Response | Description |
|---|---|---|---|---|
| POST | `/getContractData` | `{ chain, address }` | Contract data | Looks up a contract in the database by chain and address. If not found and the chain is active, fetches contract data from the onchain microservice, creates a database record, and returns the result. |
| POST | `/getContractDataByIds` | `{ contractIds: string[] }` | Contract data array | Batch lookup by internal UUIDs. |

**Staking Routes** (`srv/api/staking.ts`, mounted at `/Staking`):

| Method | Path | Request | Response | Description |
|---|---|---|---|---|
| POST | `/getConfig` | `undefined` | `{ config: Config \| null }` | Returns the public staking config (chain, token/contract address, base rate, lock bounds) or `null` if staking is not configured. Login required. |
| POST | `/getPositions` | `undefined` | `PositionView[]` | Returns the caller's staking positions (amount, lock window, unstaked state, accrued/total Spark). Login required. |

**Lukso Universal Profile Routes** (`srv/api/luksoUniversalProfile.ts`):

| Method | Path | Request | Response | Description |
|---|---|---|---|---|
| POST | `/PrepareLuksoAction` | `{ address, signature, message }` | `{ universalProfileValid, universalProfileExists, readyForLogin, readyForCreation, username, profileImageUrl, description }` | Validates a Lukso UP signature against the session nonce, checks if the UP is already linked to an account, fetches profile data, and stores the result in the session for subsequent login/registration. |

The `PrepareLuksoAction` endpoint verifies:
1. The message contains the session's `signSecret` nonce.
2. The signature is valid via `isValidSignature` (ERC-1271 call to the onchain microservice).
3. Whether the Universal Profile address is already linked to an existing user.

It returns `readyForLogin=true` if the UP is already linked (user can proceed to log in), or `readyForCreation=true` if the UP exists on-chain but is not yet linked (user can create a new account).

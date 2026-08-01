# AGENTS.md — Common Ground

> Common Ground is a browser-based, open-source social platform for communities, built as a robust alternative to Discord. It is licensed under AGPLv3.

## Project Overview

Common Ground is a full-stack TypeScript application:

- **Frontend**: React 18 SPA (Create React App + craco) with Tailwind CSS, Slate rich-text editor, markdown rendering, and styled-components
- **Backend**: Express.js REST API + Socket.IO real-time layer with TypeORM (PostgreSQL) and Redis
- **WebRTC**: MediaSoup-based voice/video calling (group calls, broadcasts)
- **Bots**: first-class bot accounts with a bearer-token Bot API v1 (`/api/bot/v1`)
- **Staking**: CgStaking contract + event indexing + Spark accrual
- **Smart Contracts**: Solidity (Hardhat; Foundry for staking)
- **Infrastructure**: Docker Compose stack (nginx, PostgreSQL, Redis, SeaweedFS/S3); single-server selfhost profile with Caddy TLS
- **PWA**: installable, push notifications, multi-tab coordination via service worker

## Repository Structure

```
/
├── src/                    # React frontend (components in atoms/molecules/organisms/templates, views, data layer, hooks, context)
├── srv/                    # Backend (api/, entities/, migrations/, repositories/, validators/, jobs/, onchain/, mediasoup/, redis/)
├── contracts/              # Solidity contracts (Hardhat; contracts/staking = Foundry)
├── docker/                 # Compose stacks (dev + selfhost), build scripts, nginx/Caddy config
├── pipelines/              # LEGACY: Azure DevOps pipelines (replacement: GitHub Actions, planned)
├── tools/                  # Developer utility scripts
├── public/                 # Static assets (PWA manifest, icons)
├── docs/                   # Living documentation (see below) + docs/todo/ working documents
├── run.sh                  # Main CLI entry point for dev workflows
└── AGENTS.md               # This file
```

## Key Commands

```bash
./run.sh build_full        # Full build (frontend + backend) and start stack
./run.sh start             # Dev frontend on http://localhost:3000
./run.sh start_https       # Dev frontend with HTTPS (needed for voice calls)
./run.sh update_backend    # Rebuild and restart backend only
./run.sh update_frontend   # Rebuild and restart frontend only
./run.sh up | down         # Start/stop Docker stack
./run.sh compose <args>    # Pass-through to docker compose
./run.sh shell             # Bash in the builder container
./run.sh make_migration <name>       # Generate a TypeORM migration
./run.sh make_empty_migration <name> # Generate an empty migration file
```

## Module Status

This list is normative. **Never build new functionality on top of a module marked
`removal-pending`**, and do not migrate such modules to new libraries or patterns —
they are deleted via dedicated cleanup PRs tracked in
[docs/todo/ROADMAP_CORE_SLIMMING.md](docs/todo/ROADMAP_CORE_SLIMMING.md).

| Module / area | Status | Notes |
|---|---|---|
| Communities, areas, channels, messaging, DMs | **core** | |
| Articles / blogs, events, search, notifications | **core** | |
| Voice/video calls (MediaSoup) | **core** | optional at deploy time (service toggle) |
| Plugin system (iframe host, appstore) | **core** | designated target for extracted non-core features |
| Bot accounts + Bot API v1 | **core** | |
| Staking (contract, indexing, accrual, Stake UI) | **core** | |
| Premium / Spark economy (supporter tiers, community upgrades) | **core** | active product feature |
| Auth: device, passkey/CGID, email+password, email code, wallet/SIWE (EVM), Lukso UP, Twitter, Farcaster | **core** | consolidation planned, see docs/auth-identity |
| Selfhost deployment profile | **core** | see docs/deployment |
| Token sale: buy/claim UI, charts, investor wizard (`FullscreenWizard`), Sumsub KYC, NDA/US gates, `trackTokenSales`/`tokenSaleNotifications` jobs | **removed 2026-08-01** | Phase 2 of the slimming roadmap. The `tokensales`/`tokensale_*` tables + entities stay for auditability (no reader, no writer); the five `wizard*` tables were dropped incl. data (`1785628800000-dropWizardDomain`). Do not reintroduce. |
| Aeternity wallet login, Fuel wallet login (providers, sign/connect components, `@aeternity/aepp-sdk`/`fuels` deps, backend verification, `WalletType` enum values, `wallets` rows) | **removed 2026-08-01** | Phases 3 + 3.5 of the slimming roadmap. Total eradication: no code, no icons, no enum values, and the stored rows are deleted by `1785632400000-dropFuelAeternityWallets` (`down()` restores the enum, not the rows). Every remaining wallet type is EVM-based. Do not reintroduce. |
| Ecosystems (`EcosystemProvider`, `/e/:ecosystem`, `EcosystemPicker`/`Chip`/`PickerField`/`HomeHeader`, hardcoded partner list, `ecosystemTagList`, partner icons) | **removed 2026-08-01** | Phase 3.5 of the slimming roadmap. **Tags are the replacement** — ecosystems were never anything but strings in `communities.tags`, and the backend never knew the concept. single-segment `/e/:ecosystem` URLs redirect to `/` so old partner links no longer 404 (they land on the unfiltered Home — the tag pre-filter is intentionally gone); existing partner tags live on as ordinary tags (no data cleanup). LUKSO compatibility (UP login, LSP7/LSP8, chain config, `READ_LUKSO`) and every chain tag/icon are untouched. Do not reintroduce. |
| AI assistant (`AssistantView`, `CommunityLobby/Assistant`, `assistantManager`, `srv/assistant.ts` + `srv/assistant/`, `assistant_dialogs`/`assistant_availability`, the `llama`/`assistant` compose services, the `AI_USE_GPU` compose-merge branches, `openai` + `react-syntax-highlighter` deps) | **removed 2026-08-01** | Phase 4 of the slimming roadmap. It was built in a much earlier phase of AI; **a bot integration takes its place** (bots are core), and keeping both made no sense. The two tables are dropped incl. data by `1785636000000-dropAssistantDomain` (`down()` restores the schema, not the rows). Zero overlap with bot code. `AI_API_KEY`/`AI_USE_GPU` are dead — nothing reads them — but the tracked `docker/.env` placeholder still carries both lines until the maintainer drops them in a separate, deliberate commit (same call as the Phase-2 `SUMSUB_*` lines). Do not reintroduce. |

## Documentation

Living documentation lives in `docs/`, one section per topic area:

| Section | Content |
|---|---|
| [docs/architecture/](docs/architecture/) | System architecture, request flows, service topology |
| [docs/auth-identity/](docs/auth-identity/) | All login methods, sessions, device keys, account linking |
| [docs/backend/](docs/backend/) | API routes, entities, repositories, validators, jobs |
| [docs/frontend/](docs/frontend/) | Components, views, state management, data layer, routing |
| [docs/database/](docs/database/) | Schema, migrations, patterns |
| [docs/realtime/](docs/realtime/) | Socket.IO, MediaSoup/protoo, push, Redis |
| [docs/blockchain/](docs/blockchain/) | Contracts, onchain service, token gating, wallets |
| [docs/staking/](docs/staking/) | Staking feature end-to-end |
| [docs/bots/](docs/bots/) | Bot accounts architecture ([docs/BOT-API.md](docs/BOT-API.md) = wire protocol) |
| [docs/plugins/](docs/plugins/) | Plugin system |
| [docs/infrastructure/](docs/infrastructure/) | Docker stack, build, nginx, env vars |
| [docs/deployment/](docs/deployment/) | Deployment matrix, selfhost profile, CI/CD |
| [docs/email-notifications/](docs/email-notifications/) | Email, newsletters, notification preferences |

Documentation rules:

1. Every section README starts with a status line
   (`> Status: verified against commit <hash>, <date>`). If your change makes a
   documented statement wrong, update the doc (and its status line) in the same PR.
2. Claims in docs must be verified against code — mark anything unverified with
   `TODO(verify): ...` instead of guessing.
3. **Never document unfixed security issues in `docs/`.** Report them privately to
   the maintainers; public docs describe behavior neutrally.

## TODO Convention (living work documents)

Ongoing and planned work lives in `docs/todo/`, one markdown file per workstream:

- `ROADMAP_<topic>.md` — goal, decisions made, checklist of steps (living document,
  updated as work progresses).
- `INVENTORY_<topic>.md` — evidence bases for decisions.
- **Lifecycle**: when a workstream is finished, its lasting insights are folded into
  the affected `docs/` sections and the TODO file is **deleted** in the same PR.
  TODO files are working state, not documentation of record.

## Agent Guidelines

1. **Always use `./run.sh`** for build/dev commands — do not invoke docker compose directly.
2. **Respect the atomic design hierarchy** in frontend components (atom/molecule/organism/template).
3. **TypeORM migrations are required** for any database schema change (`./run.sh make_migration <name>`; new tables must GRANT to the `writer`/`reader` roles).
4. **Joi validation is mandatory** for all API endpoints (`srv/validators/`).
5. **Socket.IO events** must be emitted via the Redis adapter/emitter for multi-instance compatibility.
6. **Never commit secrets.** `docker/.env` is tracked as a placeholder template — keep real values local, never stage them.
7. **Check the Module Status table** before touching anything — no new code on `removal-pending` modules.
8. **Blockchain features are optional** — the app must keep working without any blockchain configuration (graceful degradation applies to all optional third-party integrations).
9. **The backend has multiple entry points** (api, wsapi, memberlist, onchain, mediasoup, jobs, migrateDb) sharing entities and utilities — check which process your code runs in.
10. **Keep docs truthful** (see Documentation rules above).
11. **Delete branches after merge.** Once a branch is merged — into `main` or into a
    persistent integration branch such as `develop` — delete it on the remote (and
    locally). Only `main`, `develop`, and explicitly designated long-lived branches
    persist; everything else is working state and gets cleaned up with its PR.

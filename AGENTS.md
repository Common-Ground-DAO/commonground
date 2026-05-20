# AGENTS.md — Common Ground

> Common Ground is a browser-based, open-source social platform for communities, built as a robust alternative to Discord. It is licensed under AGPLv3.

## Project Overview

Common Ground is a full-stack TypeScript application consisting of:

- **Frontend**: React 18 SPA (Create React App + craco) with Tailwind CSS, Slate rich-text editor, and styled-components
- **Backend**: Express.js REST API + Socket.IO real-time layer with TypeORM (PostgreSQL) and Redis
- **WebRTC**: MediaSoup-based voice/video calling (1080p, group calls, broadcasts)
- **Smart Contracts**: Solidity contracts (Hardhat) for token sales and blockchain integration
- **Infrastructure**: Docker Compose stack with nginx reverse proxy, PostgreSQL, Redis, and S3-compatible storage
- **PWA**: Installable progressive web app with push notifications and offline support

## Repository Structure

```
/
├── src/                    # React frontend source
│   ├── components/         # UI components (atoms/molecules/organisms/templates)
│   ├── views/              # Page-level view components (~51 views)
│   ├── data/               # Data layer (API connectors, app state, databases)
│   ├── hooks/              # Custom React hooks
│   ├── context/            # React context providers
│   ├── common/             # Shared utilities, types, assistant logic
│   ├── cgid/               # Common Ground ID (identity system)
│   ├── types/              # TypeScript type definitions
│   ├── util/               # Frontend utility functions
│   └── static/             # Static assets (ecosystem configs)
├── srv/                    # Backend server source
│   ├── api/                # Express route handlers (REST endpoints)
│   ├── entities/           # TypeORM entity definitions (~43 entities)
│   ├── migrations/         # Database migrations (~149 migrations)
│   ├── repositories/       # Data access layer
│   ├── validators/         # Input validation (Joi)
│   ├── jobs/               # Scheduled background jobs (node-cron)
│   ├── assistant/          # AI assistant integration (OpenAI)
│   ├── mediasoup/          # WebRTC media server configuration
│   ├── redis/              # Redis pub/sub and caching
│   ├── onchain/            # Blockchain interaction layer
│   ├── types/              # Backend type definitions
│   ├── util/               # Backend utilities
│   └── tests/              # Backend tests (Jest)
├── contracts/              # Solidity smart contracts (Hardhat)
├── docker/                 # Docker Compose setup, build scripts, nginx config
├── pipelines/              # CI/CD pipeline definitions (Azure DevOps)
├── tools/                  # Developer utility scripts
├── public/                 # Static public assets (PWA manifest, icons)
├── run.sh                  # Main CLI entry point for dev workflows
└── docs/                   # Project documentation (see below)
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend framework | React 18 + TypeScript |
| Build tool | Create React App + craco |
| Styling | Tailwind CSS + styled-components |
| Rich text editor | Slate |
| State management | React Context + custom hooks + Dexie (IndexedDB) |
| Routing | React Router v6 |
| Real-time (client) | Socket.IO client + protoo-client (WebRTC signaling) |
| Backend framework | Express.js + TypeScript |
| ORM | TypeORM |
| Database | PostgreSQL |
| Cache/Pub-Sub | Redis |
| Real-time (server) | Socket.IO + Redis adapter |
| WebRTC | MediaSoup |
| File storage | AWS S3 |
| Auth | Session-based (express-session + Redis), passkeys (WebAuthn), wallet-based |
| Email | SendGrid |
| Identity verification | SumSub |
| Blockchain | ethers.js/viem (EVM), @aeternity/aepp-sdk, fuels (Fuel Network) |
| Smart contracts | Solidity + Hardhat |
| AI | OpenAI API |
| Containerization | Docker Compose |
| Reverse proxy | nginx |
| CI/CD | Azure DevOps Pipelines |
| Package manager | Yarn 4 (Berry) |

## Key Commands

```bash
./run.sh build_full        # Full build (frontend + backend) and start stack
./run.sh start             # Dev frontend on http://localhost:3000
./run.sh start_https       # Dev frontend with HTTPS (needed for voice calls)
./run.sh update_backend    # Rebuild and restart backend only
./run.sh update_frontend   # Rebuild and restart frontend only
./run.sh up                # Start Docker stack
./run.sh down              # Stop Docker stack
./run.sh compose <args>    # Pass-through to docker compose
./run.sh shell             # Open bash in the builder container
./run.sh make_migration <name>       # Generate a TypeORM migration
./run.sh make_empty_migration <name> # Generate an empty migration file
```

## Architecture Patterns

### Frontend
- **Atomic Design**: Components organized as atoms → molecules → organisms → templates → views
- **API Layer**: Centralized API connectors in `src/data/api/` using axios with a shared `baseConnector`
- **Local Database**: Dexie (IndexedDB) for offline-capable local data storage
- **Real-time Updates**: Socket.IO for live message/notification delivery
- **Plugin Host**: `@common-ground-dao/cg-plugin-lib-host` for embedding third-party plugins via iframes

### Backend
- **Modular API Routes**: Each domain (accounts, chats, community, messages, etc.) has its own route file in `srv/api/`
- **Entity-per-file**: TypeORM entities in `srv/entities/`, one per domain concept
- **WebSocket API**: `srv/wsapi.ts` handles real-time Socket.IO events alongside the REST API
- **Background Jobs**: Cron-scheduled jobs in `srv/jobs/` for activity scoring, cleanup, etc.
- **On-chain Integration**: `srv/onchain/` for reading blockchain state (token balances, NFT ownership) used for role gating

### Data Flow
1. Frontend calls REST API (`src/data/api/` → `srv/api/`)
2. Backend validates with Joi (`srv/validators/`), queries PostgreSQL via TypeORM (`srv/entities/`)
3. Real-time events broadcast via Socket.IO (Redis adapter for multi-instance)
4. WebRTC signaling via protoo (WebSocket), media via MediaSoup

## Domain Concepts

- **Community**: The top-level organizational unit (like a Discord server). Has areas, channels, roles, plugins.
- **Area**: A grouping of channels within a community (like a Discord category).
- **Channel**: A communication space within an area — can be text chat, voice, or other types.
- **Chat**: Direct messages between users (1:1 or group DMs).
- **Role**: Permission groups within a community. Can be token-gated (ERC20/721/1155).
- **Plugin**: Embedded web applications within a community (games, tools, etc.).
- **Article**: Long-form content published by communities.
- **Feed**: Content aggregation within communities.
- **Event**: Scheduled community events with registration.
- **CGID**: Common Ground Identity — the user identity system.
- **Assistant**: AI-powered community assistant using OpenAI.

## Documentation

Detailed documentation is available in the `docs/` directory:

- [docs/architecture/](docs/architecture/) — System architecture and data flow
- [docs/frontend/](docs/frontend/) — Frontend components, views, state management
- [docs/backend/](docs/backend/) — Backend API, entities, real-time layer
- [docs/database/](docs/database/) — Database schema and migrations
- [docs/infrastructure/](docs/infrastructure/) — Docker, nginx, deployment
- [docs/blockchain/](docs/blockchain/) — Smart contracts and on-chain integration
- [docs/plugins/](docs/plugins/) — Plugin system and development
- [docs/realtime/](docs/realtime/) — WebSocket, WebRTC, and MediaSoup

## Agent Guidelines

When working on this codebase:

1. **Always use `./run.sh`** for build/dev commands — do not invoke docker compose directly.
2. **Respect the atomic design hierarchy** in frontend components. New UI goes into the appropriate level (atom/molecule/organism/template).
3. **TypeORM migrations are required** for any database schema change. Use `./run.sh make_migration <name>`.
4. **Joi validation is mandatory** for all API endpoints. See `srv/validators/` for patterns.
5. **Socket.IO events** must be emitted via the Redis adapter for multi-instance compatibility.
6. **Never commit secrets.** `docker/.env` is tracked in the repo as a placeholder template (with `your-key`/`your-listid` defaults). Keep real values local and never stage changes that replace the placeholders with real credentials.
7. **Test with `./run.sh start`** for frontend dev, but the full stack (`build_full`) must be running for backend connectivity.
8. **Blockchain features** are optional — the app works without any blockchain configuration.
9. **Plugin development** uses `@common-ground-dao/cg-plugin-lib-host` on the platform side and a corresponding client lib in the plugin iframe.
10. **The backend has two entry points**: REST API (`srv/api.ts`) and WebSocket API (`srv/wsapi.ts`). Both share entities and utilities.

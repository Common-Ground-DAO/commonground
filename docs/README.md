# Common Ground Documentation

Living documentation for the Common Ground codebase. Each section is a README verified
against a specific commit (see the status line at the top of each file). Conventions for
maintaining these docs live in [AGENTS.md](../AGENTS.md) (sections "Documentation" and
"TODO Convention").

## Sections

| Section | Content |
|---|---|
| [architecture/](architecture/README.md) | System architecture, request flows, service topology |
| [auth-identity/](auth-identity/README.md) | All login methods, sessions, device keys, account linking |
| [backend/](backend/README.md) | API routes, entities, repositories, validators, jobs |
| [frontend/](frontend/README.md) | Components, views, state management, data layer, routing |
| [database/](database/README.md) | Schema, migrations, patterns |
| [realtime/](realtime/README.md) | Socket.IO, MediaSoup/protoo, push notifications, Redis |
| [blockchain/](blockchain/README.md) | Contracts, onchain service, token gating, wallets |
| [staking/](staking/README.md) | Staking feature end-to-end |
| [bots/](bots/README.md) | Bot accounts architecture; [BOT-API.md](BOT-API.md) is the wire protocol |
| [plugins/](plugins/README.md) | Plugin system |
| [infrastructure/](infrastructure/README.md) | Docker stack, build, nginx, env vars |
| [deployment/](deployment/README.md) | Deployment matrix, selfhost profile, CI/CD |
| [email-notifications/](email-notifications/README.md) | Email, newsletters, notification preferences |

## Working documents

[todo/](todo/) contains living roadmap and inventory documents for ongoing workstreams
(`ROADMAP_*.md`, `INVENTORY_*.md`). They are working state: once a workstream finishes,
its lasting insights are folded into the sections above and the file is deleted.

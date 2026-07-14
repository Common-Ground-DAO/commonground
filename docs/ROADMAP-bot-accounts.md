# Roadmap: Bot Accounts

> **Audience:** the implementing agent/developer. This document assumes **zero prior context** — read it fully before writing code.
> **Status:** planned & approved 2026-07-14. Architecture decisions below are **locked** (agreed with the product owner and CTO); do not relitigate them, but do flag anything you discover that contradicts them.
> **Process:** you implement; a separate reviewer agent reviews every PR. Work in slices (§6), one PR per slice.

---

## 1. What we're building

Common Ground currently has only human user accounts. We're introducing **bot accounts**: programmable actors that post/read/react in community channels via an API, written and hosted by third-party bot authors (we provide identity, auth, endpoints, and an event stream — we do **not** host bot code).

Three ownership flavors, all sharing one identity mechanism:

| Flavor | Owner | Presence rule |
|---|---|---|
| **Community bot** | a community | lives in its owning community; community admins pick which channels |
| **User bot** | a user | may join any community/channel its owner has access to — **but** each community decides whether to allow user-owned bots at all, and which channels |
| **Platform bot** | the instance/platform | configurable: present in *all* communities/channels or a specific subset |

**v1 scope:** post messages in channels, read messages / receive live events, react + reply in threads. **Explicitly deferred:** DMs with bots (mutual-follow gating makes this its own design problem — do not build DM support in these slices).

## 2. The core architectural decision (locked)

**A bot is a normal user.** From the CTO (translated): rewriting the message table with a nullable `creatorId` would force UI rebuilds everywhere; the user table instead comes with an enormous amount of free frontend machinery (caching, autofetch, hooks). So:

- `users` table gets a new boolean **`is_bot`** (default `false`). Otherwise bots are ordinary rows in `users`.
- `user_accounts` gets a new profile **type `'bot'`** (it's a Postgres enum; see §5.1).
- Bot-specific metadata lives in a new satellite table **`bots`** (keyed by `userId`), *not* in new columns on `users` — mirrors the existing `users_premium` / `user_accounts` satellite pattern.
- `messages.creatorId` stays a non-null FK to `users` — **zero message-schema changes**. A bot's messages are ordinary messages.

Why this works — verified in the codebase: the frontend resolves every `creatorId`/userId through a three-tier autofetch cache (`useUserData` hook → in-memory Map → Dexie/IndexedDB → `userApi.getUserData`), so **any real users-row renders correctly in messages, avatars, mentions, member lists and tooltips with no new frontend code**. See `src/context/UserDataProvider.tsx` and `src/data/databases/user.ts` (note the `<missing-user>` placeholder synthesis at ~L440 — evidence that rendering is fully userId-driven).

## 3. Repo orientation (zero-context primer)

- **Monorepo**: React frontend in `src/`, Node/TypeScript backend in `srv/`, Docker deployment in `docker/`. Shared types are mirrored between `src/common/` and `srv/common/` (keep them in sync when you edit either).
- **Backend services** (all built from one image, `cryptogram/backend`): `api` (REST), `wsapi` (socket.io), `onchain`, `job-runner`, `memberlist`, `mediasoup`, plus `migrate-db` (one-shot TypeORM migration runner: `srv/migrateDb.ts`; migrations auto-discovered from `srv/migrations/*.js` — no registration file).
- **DB**: Postgres. Entities in `srv/entities/`, repositories (raw SQL + helpers) in `srv/repositories/`, API route handlers in `srv/api/`. Migrations are TypeORM classes in `srv/migrations/` named `<epoch-ms>-<name>.ts`.
- **Auth today**: exclusively express-session cookies. `request.session.user` has shape `{ id: string, deviceId: string }` (`srv/util/express.ts` L23-33). Route handlers each check `if (!request.session.user) throw LOGIN_REQUIRED` individually (see the `registerPostRoute` wrapper in `srv/api/util.ts` — it validates the body but does NOT enforce auth). **There is no bearer/API-token auth anywhere yet** — you will build the first one (§6 slice 2).
- **Socket auth today**: `srv/wsapi.ts` — the `"login"` socket event (~L199-227) is a device-keypair challenge-response (`deviceHelper.verifyDeviceAndGetUserId`). The session cookie only wires event delivery rooms.
- **Permissions**: role-based per community. A user can write in a channel iff they hold a role with `CHANNEL_WRITE` there (`permissionHelper.hasPermissions`; see usage in `srv/api/messages.ts`). **Bots reuse this system unchanged** — "bot is in channel X" simply means the bot user holds an appropriate role.
- **Branching**: base all work on the **`develop`** branch (integration branch). One branch + PR per slice, PRs target `develop`, **never `main`** (main is frozen pending external review of PR #2). Name branches `feature/bot-accounts-<slice>`.
- **Reference deployment**: a live self-hosted instance runs at `https://cg.mogged.eu`, deployed from this repo via `docker/selfhost/` (see `docker/SELFHOST.md`). The reviewer can deploy your merged slices there for verification.

## 4. Data model (target state)

```
users
  + is_bot boolean NOT NULL DEFAULT false        -- the only change to users

user_accounts
  type enum gains value 'bot'                     -- bot's display profile row
  (displayName + imageId of the bot live here, like every other account type)

bots                                              -- NEW satellite table, 1:1 with users
  userId      uuid PK, FK -> users(id) ON DELETE CASCADE
  ownerType   enum('community','user','platform') NOT NULL
  ownerId     uuid NULL                           -- communityId | userId | NULL for platform
  description text NULL
  createdAt / updatedAt / deletedAt               -- match house style (timestamptz, soft delete)

bot_tokens                                        -- NEW, issued credentials
  id          uuid PK
  botUserId   uuid FK -> users(id) ON DELETE CASCADE
  tokenHash   text NOT NULL                       -- store a hash, NEVER the raw token
  name        varchar NULL                        -- operator label
  lastUsedAt  timestamptz NULL
  createdAt / revokedAt

communities (or its settings jsonb — inspect and follow house style)
  + allowUserBots boolean-ish setting             -- gate for user-owned bots (slice 3)

platform bot presence config                      -- slice 3; env/instance-config or a small table,
                                                  -- decide when you get there and justify in the PR
```

Enum changes required (both are Postgres enums — `ALTER TYPE ... ADD VALUE`, plus TS updates):
- `user_accounts_type_enum`: + `'bot'`
- `users_displayaccount_enum`: + `'bot'`

TS type touchpoints for the enum change:
- `srv/common/enums.ts` (~L145): `UserProfileTypeEnum` — add `BOT = 'bot'`
- `srv/common/types/models/user.d.ts` (L9): `ProfileItemType` union — add `'bot'` (mirror in `src/common/` — check whether these are symlinked or duplicated; keep both sides consistent)
- `srv/repositories/users.ts` (L22-41): `CreateUserAccountData` discriminated union — add a `bot` variant; extend the per-type insert branch in `_createUser` (~L478-553)

## 5. Known landmines (all verified in code — handle each)

1. **Credential guard**: `_createUser` (`srv/repositories/users.ts` ~L555-564) rejects users that have no wallet/password/external-account/email/passkey. A bot has none of these. The bot-provisioning path must satisfy or bypass this guard *explicitly for `is_bot` users* — do not weaken it for humans.
2. **`ALREADY_LOGGED_IN` guard**: `POST /User/createUser` (`srv/api/user.ts` ~L416-419) requires a logged-*out* session. Bot creation is a **new endpoint** called by a logged-*in* owner — do not reuse the human signup endpoint.
3. **Captcha + IP rate limit**: human signup enforces reCAPTCHA and `createUserRateLimiter` (2 creations / 24 h per /64!). The authenticated bot-creation endpoint bypasses both, but add its own sane limit (e.g. max bots per owner — pick a number, make it configurable).
4. **Trust gate**: messaging requires `hasTrustOrThrow({ trust: '1.0' })` (`srv/api/messages.ts` ~L502). Users get `trustScore` DB-default `1`, so bots pass automatically — **verify your creation path doesn't set a lower score**.
5. **`displayAccount` integrity**: `users.displayAccount` must point at an existing `user_accounts` row of that type (enforced via CTE in `_updateUser`, `srv/repositories/users.ts` ~L658-667). Bot creation must insert the `user_accounts` row `type='bot'` and set `displayAccount='bot'` together.
6. **CG-username uniqueness** is enforced by a partial index only for `type='cg'` (`idx_user_accounts_cg_unique_displayName`). Decide whether bot display names must be unique (recommended: yes, same mechanism — add an equivalent partial index for `type='bot'`) and state your decision in the PR.
7. **`deviceId` semantics**: every session user carries a `deviceId`, used for websocket echo-suppression and room membership (e.g. `srv/api/messages.ts` L271). Your bearer middleware must supply a stable synthetic deviceId per token (a real `devices` row per bot is the cleanest — `_createUser` already always inserts one; reuse that).
8. **`ALTER TYPE ... ADD VALUE`** cannot run inside a transaction block in older Postgres semantics; TypeORM migrations run in transactions by default. Check how existing enum-extending migrations in `srv/migrations/` handle this and copy the house pattern.
9. **Human-only surfaces** (don't break, don't over-build): bots must never receive emails/newsletters (they have `email = NULL` — the graceful-degradation code already handles null emails; just don't invent one), never appear in KYC/premium/onboarding flows, and follow/DM UI on bot profiles should be hidden in the polish slice — not load-bearing before that.

## 6. Delivery slices — one branch + PR each, in order

Each PR must include: migrations (if any), the code, and a **verification section in the PR description** describing what you ran to prove it works (this repo has no automated test suite — verification is manual/scripted; show your script or psql/curl transcript).

### Slice 1 — Schema + model foundation (`feature/bot-accounts-schema`)
- Migration(s): `users.is_bot`; `bots` table; both enum `ADD VALUE 'bot'`.
- Entity updates: `srv/entities/users.ts` (+`isBot`), new `srv/entities/bots.ts`; register entity where the datasource expects it (check `srv/util/datasource.ts`).
- TS enum/union/`CreateUserAccountData` updates per §4, both `srv/common` and `src/common` sides.
- `_createUser`: accept a `bot` account variant + `isBot` flag; handle landmines 1, 5.
- **No user-visible behavior change.** Verification: migration runs clean on a copy of the schema; creating a bot user via a repo-level script works; existing human signup still works.

### Slice 2 — Bearer auth for bots (`feature/bot-accounts-auth`)
- `bot_tokens` table + entity + migration.
- Token format: `cgb_<random>` (≥ 32 bytes entropy); store only a hash (use an existing hashing util if the repo has one — check how passwords are hashed — else SHA-256 is acceptable for high-entropy tokens; justify choice in PR).
- Express middleware (mounted before routes in `srv/api.ts`/router setup): if `Authorization: Bearer cgb_...` present and valid → set `request.session.user = { id: botUserId, deviceId: <bot's device id> }` for this request **without persisting a session**; update `lastUsedAt` (throttled). Invalid/revoked token → 401. No header → untouched (cookie path unaffected).
- Token issue/revoke/list endpoints for the bot's owner (session-authenticated humans only; bots cannot mint tokens).
- Verification: curl transcript — bearer request hits an authenticated endpoint successfully; revoked token → 401; cookieless request without header → LOGIN_REQUIRED as before.

### Slice 3 — Provisioning & ownership (`feature/bot-accounts-provisioning`)
- Create/delete-bot endpoints for the three owner flavors (community-admin-, user-, and platform-operator-authenticated respectively). Handle landmines 2, 3.
- `bots` ownership rules; per-community **allow-user-bots** setting (find where community settings live and follow house style); adding a user-bot to a community requires that setting on and respects channel selection via role assignment (reuse existing role/permission endpoints where possible — the bot is just a member).
- Platform-bot auto-presence: configurable all-communities or subset. **Must not touch DM/private contexts.**
- Per-owner bot count limit (configurable, sane default).
- Verification: end-to-end transcript creating each flavor, adding to channels, permission denial cases (user-bot into a community with the setting off, non-admin creating community bot, etc.).

### Slice 4 — Bot messaging (`feature/bot-accounts-messaging`)
- Likely near-zero new code: verify a bearer-authenticated bot can `POST /Message/createMessage`, reply in threads (`parentMessageId`), and `setReaction` through the existing endpoints, respecting channel permissions. Fix whatever friction appears (landmine 4, 7).
- Verification: transcript of a bot posting/replying/reacting in a real channel; a human in the UI sees the messages rendered normally.

### Slice 5 — Socket event stream for bots (`feature/bot-accounts-events`)
- Add a **token path** to the wsapi `"login"` event (or a parallel `"bot-login"` event) alongside the device-key challenge-response — do not weaken the human path. After auth, join the same user/role/community rooms a human user would (reuse the existing post-login room logic in `srv/wsapi.ts`).
- Decide + document what events a bot receives (target: the same channel events the frontend gets for channels the bot can read).
- Consider: bots should probably not emit "online" presence like humans (`markOnline`) — decide, justify in PR.
- Verification: script connecting socket.io with a bot token, receiving a live message event posted by a human.

### Slice 6 — Frontend polish (`feature/bot-accounts-frontend`)
- "Bot" badge where display names render: `getDisplayName` (`src/util/index.tsx` ~L87-119) and/or `UsernameWithVerifiedIcon` — follow how the verified/supporter badge is done.
- `isBot` must be included in the user payloads the frontend caches (check `userApi.getUserData` server response assembly, likely `srv/api/getRoutes.ts` / user repositories).
- Hide follow + DM buttons on bot profiles (`src/components/molecules/UserProfileV2/UserProfileV2OtherOptions.tsx` ~L174-184).
- Render the `bot` account type sensibly wherever account-type branching exists (icon switch in `src/components/atoms/ExternalIcon/ExternalIcon.tsx`, profile editor `UserProfileV2.tsx` — bots don't need "add account" buttons).
- Verification: screenshots from a live instance (headless browser is fine).

### Slice 7 — (deferred, do not start) DMs with bots
Placeholder. Requires its own authorization design (DMs are mutual-follow-gated today).

## 7. Working agreements

- **License headers**: every new file starts with the SPDX AGPL header used across the repo (copy from any existing file).
- **Style**: match surrounding code — raw-SQL repository style in `srv/repositories/`, Joi validators for new endpoints (see `Validators.API.*` usage in `srv/api/user.ts`), API request/response types in the shared `common/types` the way existing endpoints do it.
- **Migrations**: epoch-ms-prefixed filename, class name matching, `down()` may be empty (house style — see recent migrations).
- **Commits**: descriptive messages explaining *why*; reference this roadmap. Do not commit secrets; never commit `docker/.env.selfhost`.
- **PRs**: target `develop`, one slice per PR, include the verification transcript. The reviewer will test against a live instance.
- **When the roadmap conflicts with reality**: the codebase wins on facts, but the architecture decisions in §2 are locked. If a decision seems impossible, stop and flag it in the PR/issue instead of unilaterally redesigning.

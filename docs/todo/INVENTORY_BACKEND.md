# Backend Inventory (footprint & decommissioning candidates)

> Status: verified against commit 523fceccd, 2026-07-25.

This is a reference inventory of the backend surface — every HTTP router, every scheduled
job, every long-running service process, entities that no longer have a code path writing to
them, and every third-party integration — assembled to support **footprint reduction on a
small single-node self-host**. It is descriptive, not prescriptive: the final section lists
decommissioning candidates with the evidence behind each, so a maintainer can decide.

Nothing here was deleted or changed; this is an audit of the current tree.

Counting notes: "POST routes" counts `registerPostRoute(...)` call sites in each router file
(see `docs/backend/README.md` §2 for the helper). Auth is enforced **inside each handler**,
not by a shared middleware — `registerPostRoute` only validates the Joi body and wraps the
response. LoC is `wc -l` of the file.

---

## 1. HTTP Routers (`srv/api/`)

All routers are mounted in `srv/api.ts` on the `api` container (which also serves the SPA and
the SSR/OG routes at `/`). The real-time Socket.IO surface (`srv/wsapi.ts`, 502 LoC) runs in
the separate `wsapi` container and is out of scope for this table.

| Router file | Mount | LoC | POST routes | GET routes | Auth surface |
|---|---|---:|---:|---:|---|
| `community.ts` | `/Community` | 2097 | 80 | 0 | session + per-route permission checks (51 permission call sites) |
| `user.ts` | `/User` | 1708 | 50 | 0 | session; a few pre-login flows (signable secret, captcha, OTP) |
| `messages.ts` | `/Message` | 1071 | 14 | 0 | session + channel permission checks; subset also reachable via Bot API bearer |
| `getRoutes.ts` | `/` | 976 | 0 | 24 | public SSR/OG + role-gated file/video streaming; Twitter OAuth callback |
| `plugins.ts` | `/Plugins` | 668 | 9 | 1 | session; owner/limit checks |
| `emails.ts` | (none — util module) | 396 | 0 | 0 | n/a (SendGrid composition helpers, imported by other routers) |
| `cgid.ts` | `/CgId` | 380 | 6 | 0 | session bootstrap + WebAuthn (passkey) verification |
| `chats.ts` | `/Chat` | 346 | 12 | 0 | session; includes AI-assistant chat/queue routes |
| `search.ts` | `/Search` | 289 | 2 | 0 | public read (session-independent) |
| `notifications.ts` | `/Notification` | 203 | 9 | 0 | session; VAPID/web-push management |
| `files.ts` | `/File` | 215 | 1 | 1 | session; `POST /uploadImage` (multipart) + signed-URL fetch |
| `accounts.ts` | `/Accounts` | 157 | 2 | 0 | Farcaster SIWE + token-sale registration (session flow state) |
| `bots.ts` | `/Bot` | 111 | 13 | 0 | session (`sessionUserId`) + owner/platform-operator checks |
| `twitter.ts` | `/Twitter` | 100 | 1 | 1 | Passport (`passport-twitter`) OAuth |
| `sumsub.ts` | `/Sumsub` | 80 | 1 | 1 | access-token issue (session) + signed webhook (raw body) |
| `luksoUniversalProfile.ts` | `/Lukso` | 71 | 1 | 0 | session flow state |
| `botV1.ts` | `/BotV1` | 51 | 2 | 0 | **bearer** (bot token); also mounts `messageRouter` under `/messages` |
| `report.ts` | `/Report` | 48 | 2 | 0 | session (`createReport`); `getReportReasons` static list |
| `staking.ts` | `/Staking` | 46 | 2 | 0 | session (`getConfig`, `getPositions`) |
| `contracts.ts` | `/Contract` | 40 | 2 | 0 | public read (session-independent) |
| `util.ts` | (none — shared helpers) | 415 | 0 | 1 | n/a (`registerPostRoute`, error handling, Farcaster/Sumsub/signature helpers) |

Approx. totals: **~211 `registerPostRoute` handlers + 24 GET handlers**, spread over 19 route
files (plus `util.ts`/`emails.ts` which register nothing). `community.ts` + `user.ts` +
`messages.ts` alone account for ~144 of the POST handlers.

New since the March-2026 documentation baseline (`ffe888bd4`): `bots.ts`, `botV1.ts`,
`staking.ts` (and their repositories/jobs). The Bot API v1 (`/BotV1/*`) is bearer-only and
rejects requests that also carry a session cookie.

---

## 2. Scheduled & background jobs (`srv/jobs/`, orchestrated by `srv/jobs.ts`)

`srv/jobs.ts` runs in the dedicated `job-runner` container. Every job is a **worker thread**
(each throws if run on the main thread). Three lifecycle shapes exist:

- **Permanent** (`createPermanentWorker`) — long-running, auto-restarted on exit.
- **Cron/Interval** (`createCronOrIntervalWorker`) — respawned on a schedule.
- **One-shot** (`createOneshotWorker`) — spawned once per process start, self-guards against
  re-running via the `oneshot_jobs` table.

| Job file | Type | Schedule / trigger | Purpose | Footprint status |
|---|---|---|---|---|
| `premiumRenewal.ts` | permanent | continuous (30s startup delay) | Auto-renew expiring premium features | Active |
| `callUpdateEmitter.ts` | permanent | continuous | Track call servers, end stale calls, emit updates | Active (needs calls) |
| `trackTokenSales.ts` | permanent | continuous (30s delay) | Scan chain for token-sale contributions | Active only if a token sale is configured |
| `handleCommunityAirdrops.ts` | permanent | continuous (30s delay) | Execute finished role airdrops | Active only if airdrops configured |
| `tokenSaleNotifications.ts` | permanent | **`prod` deployment only** | Email/push for token-sale events | Not spawned on self-host |
| `onlineStatusCheck.ts` | interval | every 30s | Mark stale users offline | Active |
| `stakingAccrual.ts` | cron | `17 */6 * * *` (6-hourly) | Credit Spark from staking positions | Active only if staking configured (new since baseline) |
| `activityScore.ts` | cron | `*/10 * * * *` | Recompute community activity scores | Active |
| `newsletterDelivery.ts` | cron | `0 12 * * 6` (Sat 12:00) | Weekly platform newsletter | Active only if email (SendGrid) configured |
| `emailNotifications.ts` | cron | `*/1 * * * *` | Article-as-email + event reminders | Active only if email configured |
| `previewImageUpdate.ts` | one-shot | once per start | Backfill missing preview images | **Dead weight once run** |
| `erc20decimalFix.ts` | one-shot | once per start | Backfill ERC-20 decimals | **Dead weight once run** |
| `fileMetadataFix.ts` | one-shot | once per start | Backfill file metadata | **Dead weight once run** |
| `luksoProfileImageFix.ts` | one-shot | once per start | Backfill Lukso profile images | **Dead weight once run** |
| `erc1155nameAndMetadataFix.ts` | one-shot | once per start | Backfill ERC-1155 name/metadata | **Dead weight once run** |
| `calculateTokenRewardProgram.ts` | one-shot | once per start | Compute a past reward-program distribution | **Dead weight once run** |
| `calculateTokenRewardProgramSecond.ts` | one-shot | once per start | Second phase of the above | **Dead weight once run** |
| `calculateTokenRewardProgramSecondFix.ts` | one-shot | once per start | Fix pass for the second phase | **Dead weight once run** |

### One-shots are dead weight after their first successful run

All 8 one-shot jobs follow the same guard (verified, e.g. `erc20decimalFix.ts:47-68`): on
start they `SELECT id, "createdAt" FROM oneshot_jobs`, and if their `ONESHOT_ID` row exists
they log "…already … nothing to do" and exit. On any instance that has run before, they are
purely startup overhead: 8 worker-thread spawns + 8 full scans of `oneshot_jobs` on every
`job-runner` start, all no-ops. They are one-time migrations that were completed on the hosted
instance; a fresh self-host runs them once and then never again. None is referenced from the
request path or from any other job — they exist only in the `srv/jobs.ts` spawn list.

---

## 3. Long-running service processes ("extra services")

Beyond the datastores (`db`, three Redis instances, SeaweedFS `seaweedmaster`/`seaweedvolume`/`s3`)
and the edge (`nginx`, and `caddy` on self-host), the backend image is booted as several
distinct Node processes. On the single-node self-host compose
(`docker/docker-compose.selfhost.yml`) these are separate containers from one shared image.

| Service | Container / command | Entry (LoC) | Why it is its own process | Collapsible on a single node? |
|---|---|---|---|---|
| REST API + SPA/SSR | `api` → `node /dist/api.js` | `api.ts` (61) + routers | Stateless HTTP; serves SPA, REST, OG previews | Core — keep |
| Realtime | `wsapi` → `node /dist/wsapi.js` | `wsapi.ts` (502) | Socket.IO event loop; separated so a slow/long-poll socket workload does not block REST | Could co-reside with `api` on one node, but code assumes a distinct process + Redis socket.io adapter |
| Member lists | `memberlist` → `node /dist/memberlist.js` | `memberlist.ts` (1332) | **Stateful, in-RAM** per-community member sets kept live via Postgres `LISTEN/NOTIFY`; serves windowed lookups over HTTP (`http://memberlist:4000/...`, called from `community.ts:201/227/276`) | Inherently single-instance (in-memory state); keep as one process. Its RAM footprint scales with total membership |
| On-chain reads | `onchain` → `node /dist/onchain.js` | `onchain.ts` (286) + `onchain/` (4097) | Isolates RPC scheduling/rate-limiting/caching behind an internal HTTP API (`http://onchain:4000`, via `repositories/onchain.ts`); holds an in-memory priority scheduler | Needed whenever token-gating/staking/token-sale is used; **inert if no chains are configured** (the app runs without blockchain config) |
| WebRTC SFU | `mediasoup` → `node /dist/mediasoup.js` | `mediasoup.ts` (516) + `mediasoup/` (1443) | Media server needs host UDP port range + its own worker processes for voice/video/broadcasts | Only needed if voice/video is used; heavy (CPU + UDP ports) — the largest optional cost |
| Job runner | `job-runner` → `node /dist/jobs.js` | `jobs.ts` (126) + `jobs/` | Runs the §2 workers off the request path | Keep (but see one-shot dead weight above) |
| DB migrate | `migrate-db` → `node /dist/migrateDb.js` | `migrateDb.ts` | Runs TypeORM migrations at deploy, then exits | Short-lived — fine |
| AI assistant queue | `assistant` → `node /dist/assistant.js` | `assistant.ts` (12) + `assistant/` (975) | Drains a Redis-backed LLM request queue to an OpenAI-compatible endpoint | **Not deployed by default** — commented out in `docker-compose.yml:363-380`; `COMMUNITY_ASSISTANT_ENABLED`/`PERSONAL_ASSISTANT_ENABLED = false` (`src/common/config.ts:222`). Requires the GPU compose (`llama`) or an external LLM |

Summary for a minimal single node: `db` + 3× Redis + SeaweedFS (3) + `nginx`/`caddy` +
`migrate-db` + `api` + `wsapi` + `memberlist` + `job-runner` are the always-on set. `onchain`,
`mediasoup`, and `assistant` are each only justified by an opt-in feature (blockchain, calls,
AI respectively) and are the primary candidates for turning off when those features are unused.

---

## 4. Entities with no active writers

Verified by searching `srv/` (excluding `migrations/`, `tests/`, and the entity definitions
themselves) for any `INSERT`/`UPDATE`/TypeORM `save` targeting each table.

| Entity / table | Reads? | Writes? | Verdict |
|---|---|---|---|
| `Feed` / `feeds` | none | none | **Fully dead.** No repository, no route, no frontend API connector references `feeds` |
| `FeedItem` / `feeditems` | none | none | **Fully dead** (schema-only) |
| `CommunityFeed` / `communities_feeds` | none | none | **Fully dead** (schema-only) |
| `communities_feeds_roles_permissions` | none | none | **Fully dead** (schema-only) |
| `Wizard` / `wizards` | yes (`repositories/communities.ts:3374,4292,4400,4567`) | UPDATE only (`:4499,4617`) | **Frozen.** Rows are read/updated but there is **no create path in code** — wizard definitions are seeded directly in the DB. TODO(verify): confirm wizards were only ever seeded manually for the past token-sale onboarding |
| `wizard_role_permission` | via joins | none | Frozen (depends on `wizards`) |
| `wizard_claimable_codes` | yes | INSERT + UPDATE | Active within the wizard flow |
| `wizard_user_data` | yes | INSERT | Active within the wizard flow |
| `wizard_investment_data` | yes | INSERT | Active within the wizard flow |
| `tokensales` | yes | INSERT + UPDATE | **Active** (token-sale + jobs) |
| `tokensale_registrations` | yes | INSERT + UPDATE | Active |
| `tokensale_userdata` | yes | INSERT + UPDATE (6 writers, incl. 5 jobs + `repositories/users.ts`) | Active |
| `tokensale_investments` | yes | INSERT | Active |

Takeaway: the **feeds domain (4 tables + `Feed`/`FeedItem`/`CommunityFeed` entities) is
entirely unreferenced by any code path** — no writers *and* no readers. The **wizard
definition table (`wizards`) has no code that creates rows** (only reads/updates), so the
wizard feature is effectively event-specific/frozen rather than a live product surface. The
token-sale tables, by contrast, are actively written (mostly by the token-reward/track jobs)
and should not be treated as dead even though the sale itself may be over.

---

## 5. Third-party integrations

Capability flags for most of these are re-derived at runtime in `srv/util/instanceConfig.ts`
(from which Docker secret / env var is actually present) and advertised to the frontend as
`window.__CG_INSTANCE__.features`, so an unconfigured integration is simply hidden rather than
erroring.

| Integration | Purpose | Where wired (backend) | Enable signal | Self-host default |
|---|---|---|---|---|
| **SendGrid** | Transactional + newsletter email | `srv/serverconfig.ts` (`sgMail.setApiKey`), `srv/api/emails.ts`, jobs `emailNotifications`/`newsletterDelivery` | secret `sendgrid_api` / `SENDGRID_API_KEY` | Off unless key set (`features.email`) |
| **Mailchimp** | Marketing list subscription | `srv/serverconfig.ts` (`mailchimpClient.setConfig`, server hardcoded `us9`), `srv/repositories/users.ts` | secret `mailchimp_api` + `mailchimp_list_id` | Off (placeholder default) |
| **Sumsub** | KYC / identity verification | `srv/api/sumsub.ts` (access token + signed webhook), token helper in `srv/api/util.ts` | secrets `sumsub_app_token` + `sumsub_secret_key` | Off unless both set (`features.kyc`) |
| **Twitter / X** | OAuth login + account linking | `srv/api/twitter.ts` (`passport-twitter`), `srv/util/express.ts`, callback in `getRoutes.ts` | secrets `twitter_api_v1_key` + `twitter_api_v1_secret` | Off unless both set (`features.twitterAuth`) |
| **Farcaster Hub** | Farcaster account verification | `srv/api/util.ts` (`farcasterApi`: `onChainIdRegistryEventByAddress`, `userDataByFid`), `srv/api/accounts.ts` | Hub endpoint (see `util.ts`) | Used by the Farcaster account flow |
| **OpenAI-compatible LLM** | AI assistant | `srv/assistant/queue.ts` (`new OpenAI({ baseURL, apiKey })`, `http://llama:8000` local or `https://<domain>`) | secret `ai_api_key` / `AI_API_KEY` + assistant service | **Off** (service commented out, assistant flags `false`) |
| **QuikNode** (per-chain RPC) | EVM chain reads for token-gating/staking/sales | `srv/onchain/settings.ts` (per-chain provider URLs), consumed by `onchain` service | secrets/env `quiknode_<chain>` | Off unless configured; LUKSO falls back to the public RPC `rpc.mainnet.lukso.network` |
| **Infura** (Linea RPC) | Linea chain reads | `srv/onchain/settings.ts` (`INFURA_LINEA`) | secret/env `infura_linea` | Off unless configured |
| **Giphy** | GIF picker in the message editor | Frontend (`src/util/giphy.ts`, editor components); backend only forwards the key via `instanceConfig.ts` | `CG_GIPHY_API_KEY` | Off unless key set |
| **Matomo** | Web analytics | **Frontend only** (`src/index.tsx`) | hardcoded to `analytics.<deployment>.app.cg` | **Disabled on self-host** — skipped whenever an injected instance config is present; only tracks the official `staging`/`prod` instances |
| **WalletConnect** | Wallet connection (project id) | forwarded via `instanceConfig.ts` | `CG_WALLETCONNECT_PROJECT_ID` | Off unless set |
| **reCAPTCHA** | Registration bot protection | `srv/api/user.ts`; site key forwarded via `instanceConfig.ts` | `CG_RECAPTCHA_SITE_KEY` + server secret | Off unless configured (see `docs/todo/ROADMAP_CAPTCHA.md`) |

Only **Matomo** is hardwired to Common Ground's own hosted endpoints; it is explicitly skipped
for self-hosted instances. Every other integration degrades to "feature off" when its
credential is absent (`f34979653 Graceful degradation for all optional third-party services`).

---

## 6. Decommissioning / footprint-reduction candidates

Ranked roughly by "clearly safe" → "needs a product decision". Evidence columns point at the
verification above.

| # | Candidate | Evidence | Effect if removed / disabled | Risk |
|---|---|---|---|---|
| 1 | The 8 one-shot backfill jobs in `srv/jobs.ts` | §2 — all self-guard via `oneshot_jobs` and no-op after first run; no other references | Removes 8 worker spawns + 8 `oneshot_jobs` scans per `job-runner` start; slightly faster/cleaner startup | Low — only affects fresh installs that never ran them; keep them until confident all target instances have run once |
| 2 | Feeds domain (`Feed`, `FeedItem`, `CommunityFeed` + 4 tables) | §4 — zero writers **and** zero readers anywhere in `srv/` or the frontend API layer | Removes 3 entities + 4 tables (migration) and dead schema | Low functional (nothing uses it); needs a drop migration and a check that no external tooling reads the tables |
| 3 | `assistant` service + `assistant/` module | §3/§5 — service commented out in prod compose, flags `false`, not in self-host compose | No always-on cost today; documents that AI is opt-in and requires an LLM backend | Low — already effectively off; this is a documentation/cleanup decision, not a running cost |
| 4 | `mediasoup` service | §3 — only needed for voice/video; heaviest optional process (host UDP + workers) | Big resource saving on nodes that do not use calls | Medium — disabling removes all voice/video; gate behind a "calls enabled" toggle |
| 5 | `onchain` service (+ per-chain RPC integrations) | §3/§5 — inert with no chains configured; app runs without blockchain | Saving on nodes that do not use token-gating/staking/sales | Medium — token-gated roles, staking, and token sales stop working; only for chain-free deployments |
| 6 | `tokenSaleNotifications` permanent worker | §2 — already `prod`-only; never spawned on self-host | None on self-host (already excluded) | None — noted for completeness |
| 7 | Wizard definition surface (`wizards` + `wizard_role_permission`) | §4 — read/updated but **no create path in code**; appears event-specific | Would simplify the community schema if the onboarding-wizard feature is retired | Medium — verify no live community depends on a seeded wizard before touching (TODO(verify)) |
| 8 | Collapse `wsapi` into `api` on a single node | §3 — separate process is a scaling choice, not a hard requirement | One fewer container | Higher — the code + Redis socket.io adapter assume distinct processes; needs real refactoring/testing, not just a compose edit |

### Open questions for the maintainer

- **Wizards:** confirm the `wizards` table is only ever seeded manually (no create endpoint was
  found). If so, is the onboarding-wizard feature intended to stay, or can it be retired?
- **Feeds:** is any external/analytics tooling reading `feeds`/`feeditems`/`communities_feeds`
  outside this repo before we drop them?
- **One-shots:** are all production/self-host instances known to have completed the 8 backfills,
  so the spawn list can be trimmed?
- **Token-reward jobs:** the `calculateTokenRewardProgram*` one-shots contain distribution
  logic for a past program — keep for auditability, or archive out of the runtime image?

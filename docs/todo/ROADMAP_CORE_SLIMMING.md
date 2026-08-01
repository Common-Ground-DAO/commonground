# Roadmap: Core Slimming (Entschlackung)

> Status: decisions made 2026-07-25 (maintainer). Evidence: [INVENTORY_FRONTEND.md](INVENTORY_FRONTEND.md), [INVENTORY_BACKEND.md](INVENTORY_BACKEND.md).

Goal: focus the app on its core competencies (communities, messaging, calls, articles,
bots, staking, plugins) and remove the legacy surface. Non-core features with a future
belong in the plugin system, not the core app.

**Ordering (decided 2026-08-01):** slimming runs FIRST, the build-stack migration
(CRA/craco → Vite, see build-stack roadmap, planned) follows once the codebase is
clean — everything removed here is code that never has to be migrated. Keep the
target build system in mind while cleaning (no new craco-/CRA-specific constructs).

## Decisions (2026-07-25)

| Block | Decision |
|---|---|
| Token-sale complex (buy/claim UI, charts/investors/airdrops subtrees, investor wizard, Sumsub KYC, NDA/US gates, `trackTokenSales` + `tokenSaleNotifications` jobs) | **Remove.** `tokensales`/`tokensale_*` DB tables are KEPT for auditability. **Wizard domain is dropped entirely** — all five `wizard*` tables incl. data (decided 2026-08-01; DB backups cover auditability). The one live community that owned a seeded wizard **stays**: only the wizard tables go, `communities` is never touched. Staking is untouched (core). |
| Aeternity + Fuel wallet logins | **Remove.** *Revised 2026-08-01:* total eradication — code, icons, enum values **and** the existing `wallets` rows (migration). |
| Hardcoded ecosystem partner list + commented-out ecosystem theming | **Remove.** *Revised 2026-08-01:* the ecosystem concept goes entirely and **tags replace it** — no partnership was still active. LUKSO compatibility (UP login, LSP7/LSP8, chain config, `READ_LUKSO`) is untouched. |
| Verified-dead inventory (4 unrouted views, `WhatsNewModal`, `EarlyAdopterBanner`, feeds domain incl. table drops, 8 no-op one-shot jobs, commented-out routes/blocks) | **Remove, all of it.** Feeds tables dropped via defensive migration (`DROP IF EXISTS`; no-op down — Phase 1 found the tables were never created by any migration, so there is no original schema to restore). |
| Premium / Spark economy | **Keep — core.** Not part of this roadmap. |

## Execution phases

Each phase is one reviewable PR against `develop`. Order matters: start with zero-risk
deletions, end with the blocks that need coordinated backend+frontend+schema changes.

### Phase 1 — verified-dead code (no behavior change) — DONE 2026-08-01
- [x] Remove unrouted views: `AppsView`, `GroupBrowser`, `SwapAccountView`, `BlogBrowser` (+ their lazy imports / commented routes in `App.tsx`). Also removed the unused `ProfileView` lazy import in `App.tsx` (the view itself stays — `ProfileRouter` imports it directly).
- [x] Remove `WhatsNewModal` (hardcoded `return null`) and `EarlyAdopterBanner` (only usage commented) + call sites
- [x] Remove commented-out route blocks (`App.tsx:211`, `CommunityRouter.tsx:131-134`) and the commented ecosystem theming block (`EcosystemProvider.tsx:36-100`). Note: the `announcements/articles/guides/drafts` routes were a *duplicate* — the live ones live in `CommunityView.tsx`, so `CommunityContentList` stays.
- [x] Remove the 8 one-shot jobs from the `srv/jobs.ts` spawn list + their files (keep `oneshot_jobs` table + `createOneshotWorker` mechanism for future use; archive reward-program logic in git history)
- [x] Remove feeds domain: `Feed`/`FeedItem`/`CommunityFeed` entities + drop migration (`1785542400000-dropFeedsDomain`). **Finding:** no migration ever created the 4 tables (grep for "feed" over all of `srv/migrations/`, `initdb` included, is empty) and the commented entities referenced a `PermissionType` enum that does not exist in the codebase — the domain never reached the schema. The migration therefore drops with `IF EXISTS` (no-op on every migration-provisioned DB) and `down()` is an explicit no-op: there is no original schema to restore.
- [x] Fix trivial dead spots found in review: duplicate `/getChats` registration removed; `cancelAssistantQueueItem` **removed** rather than implemented — no caller (the only frontend reference was the unused connector method), and its `{ dialogId }` payload cannot address `assistantQueue.cancelQueueItem`, which needs `(userId, priority, model)` while the queue keeps no dialogId→priority mapping.

### Phase 2 — token-sale complex — DONE 2026-08-01
- [x] Frontend: remove `TokenSale.tsx` buy/claim branches, `Info/`, `Charts/`, `TokenAirdrops/` subtrees; `StakeTab` becomes the token page (route stays `/token/`). Also removed as part of the same surface: `TokenSaleProcess` (+ the `tokenSaleProcess` sidebar type), `TokenSaleBanner` on `Home`, the never-mounted `BuyTokenHeader`, the unused `TokenSale.helper`, and the `registeredForTokenSale` / `agreedToTokenSaleTermsTimestamp` / `investsFromSwitzerland` extraData keys.
- [x] Frontend: remove `FullscreenWizard/` + `CommunityWizardProvider` + wizard route + `investmentTargets`. **Finding:** the wizard-only content elements (`WizardImage`, `dynamicTextFunction`, `dynamicTextRequest`, `inlineImage`, `nativeVideoEmbed`, `nativeDownloadEmbed`) were reachable *exclusively* through `Models.Wizard.WizardElement`, so they went too. `createUser`'s `useWizardCode` branch (wizard invite-code signup) went with them.
- [x] Frontend: remove Sumsub KYC (`SumsubContext`, `SumsubKyc`, `IdVerificationView`, `/id-verification/` route, `sumsub` API connector) + the `@sumsub/websdk*` dependencies
- [x] Backend: remove `/Sumsub` router + webhook, wizard routes in `community.ts` (`/Wizard/*`), token-sale routes in `user.ts`/`accounts.ts`, `trackTokenSales` + `tokenSaleNotifications` jobs. The now-unreachable `investmentContract_getEvents` / `getTokensaleEvents` path through the `onchain` service went with them.
- [x] Backend: remove all wizard entities + drop migration for the five `wizard*` tables (`wizards`, `wizard_role_permission`, `wizard_claimable_codes`, `wizard_user_data`, `wizard_investment_data`) — real drops incl. data (`1785628800000-dropWizardDomain`; `down()` restores the schema from the four creating migrations, without data). `communities` is untouched: the only FK is `wizards."communityId" -> communities(id)` and nothing points back.
- [x] Backend: `tokensales`/`tokensale_*` tables and their entities are KEPT (auditability); only the code paths writing/reading them for the removed features go
- [x] Remove `TOKEN_SALE_ENABLED`/`SHOW_GET_EARN_TABS` flags and Sumsub env/secrets from configs + docs. The `kyc` capability flag is gone from `instanceConfig.ts` / `instance.ts` / `inject-instance-config.sh`, `SUMSUB_*` left both compose files, `docker/selfhost/init.sh` and `SELFHOST.md`, and nginx dropped `Sumsub` from the router whitelist plus `api.sumsub.com` from every CSP. **Not touched:** `docker/.env` is a tracked placeholder that is locally modified with real credentials — its `SUMSUB_APP_TOKEN`/`SUMSUB_SECRET_KEY`/`SUMSUB_WEBHOOK_PRIVATE_KEY` lines are now dead and should be dropped by the maintainer in a separate, deliberate commit.

**Left standing on purpose (follow-up candidates, not Phase 2 scope):**
`contracts/contracts/TokenSale.sol` + its deploy script (record of the sale that ran);
`role_gated_files` + `GET /gated-videos/:filename` / `GET /gated-files/:filename`, whose only
content producers were the wizard data-room elements — the table is not in the Phase-2 drop list
and, like `wizards` before it, has no create path in code.

### Phase 3 — partner chains — DONE 2026-08-01 (wallet logins; ecosystem list handed to Phase 3.5)
- [x] Remove Aeternity: `AeternityWalletProvider` (unmounted from `App.tsx`), `AeternitySign`, `ConnectAeternityWalletButton`, `SignWalletPageAeternity` + the `sign-wallet-aeternity` settings page, `@aeternity/aepp-sdk` in both manifests, the `verifyMessage` branch in `prepareWalletAction`. **Finding:** Aeternity was already unreachable for end users. `aeternity` existed in `LoginButtonType`/`LoginOption` but in neither `loginButtons` nor `createButtons`; the `AvailableProvidersPage` entry was commented out (leaving `attemptConnectAeternity` dead), and both `ConnectAeternityWalletButton` call sites sat commented out inside the unrouted `CreateAccount`/`Login` forms. Nothing could navigate to `sign-wallet-aeternity`.
- [x] Remove Fuel: `FuelWalletProvider`/`useFuel`, `FuelSign`, `ConnectFuelWalletButton`, `SignWalletPageFuel` + the `sign-wallet-fuel` settings page, `Fuelet.svg`, `fuels` + `@fuel-wallet/sdk` + `@fuels/connectors`, the `Signer.recoverAddress` branch in `prepareWalletAction`. **Answers the inventory's open question:** yes, Fuel login *was* reachable — `useFuel` is a hook, not a mounted provider, so it worked from `SplashLoginActions` and `AvailableProvidersPage` without being in the `App.tsx` tree.
- [x] Backend: `signableWalletDataValidator` is EVM-only, `prepareWalletAction` accepts `cg_evm`/`evm`, `FuelAddress`/`AeternityAddress` leave `validators/common.ts`, nginx drops `testnet.aeternity.io` / `mainnet.aeternity.io` / `testnet.fuel.network` from every CSP. **Finding:** `walletHelper.getLoginWalletUserId` (the other fuel/aeternity verification site) had **no callers at all** — wallet login goes through the prepared-credential session — so it was removed together with `_getLoginWalletByIdentifier`, its only helper. `errors.server.WALLET_NOT_ALLOWED_FOR_LOGIN` was orphaned by that removal and deleted in the review follow-up (its only thrower was `_getLoginWalletByIdentifier`; no other occurrence repo-wide).
- [x] Reduce hardcoded ecosystem list — **superseded**: the maintainer's answer (2026-08-01) was that no partnership is still active, so the ecosystem concept was removed outright in Phase 3.5 rather than reduced.
- [x] ~~Keep `WalletType` enum values and existing `wallets` rows (no data migration).~~ **Reversed 2026-08-01** by the same decision round — see Phase 3.5. The "kept for legacy rows" types, comments, icons and rows are all gone.

### Phase 3.5 — ecosystems → tags — DONE 2026-08-01

Maintainer decisions taken on 2026-08-01, all final:

1. The ecosystem feature is removed **entirely**; tags are the slimmer replacement.
   LUKSO *compatibility* (UP wallet login, LSP7/LSP8, chain config, `READ_LUKSO`
   plugin permission, `universalProfileEnabled`) is untouched — it was never an
   ecosystem question.
2. `/e/:ecosystem` URLs redirect to `/` so old partner links no longer 404. They land on the
   unfiltered Home — the tag pre-filter is intentionally gone. Only one segment deep: nginx's
   SPA fallback matches `e/[^/]+` (`docker/nginx/nginx*.conf`), so `/e/x/y` 404s at nginx and
   never reaches React. Deliberately left as is — no evidence deeper legacy links exist, and
   the `e/[^/]+` clause is what makes the redirect reachable at all.
3. Partner icons are deleted; chain icons used by ordinary web3 tags stay (incl. lukso).
4. No data cleanup: old partner tag strings on communities live on as ordinary tags.
5. Fuel and Aeternity are eradicated completely — no code, no icons, no enum values,
   **and** their `wallets` rows are deleted by migration. This reverses the Phase-3
   "keep rows readable" decision and applies to fuel/aeternity only.

- [x] Frontend: delete `EcosystemProvider` (context, `EcosystemParamSetter`, the compiled-in
  partner list), `EcosystemPicker`, `EcosystemChip`, `EcosystemPickerField`,
  `EcosystemHomeHeader`; `URL_ECOSYSTEM` and the `channel` branch of
  `getUrl({ type: 'home' })`; `ecosystemTagList` and its priority ranking / bolding in
  `TagInputField`, `TagSuggestionsDropdown` and `SearchInputField`. **Finding:** the backend
  has *zero* ecosystem knowledge — an ecosystem was only ever a string inside
  `communities.tags`, so the whole removal is frontend-only apart from one orphaned route.
- [x] `EcosystemMenu` → **`TagFilterMenu`**. Despite the name it was the live tag-filter
  dropdown behind `TagHeader`'s "Filter by tags", used by the home feed and the community
  browser. Kept: recent tags (`tag-header-recent-tags`), the general + web3 sections,
  free-text search, ad-hoc tag creation. Dropped: the Partner Tags section, the
  `simpleChannels`/`channelNameMap`/`channelFeatures` maps with their chain tooltip (dead once
  the pickers were gone — `web3TagList` is the canonical chain-tag list), the write-only
  `SELECTED_CHANNELS_LOCAL_STORAGE` key and the commented-out two-pane channel UI.
- [x] `LUKSO` moves from `ecosystemTagList` into `web3TagList`, where every other chain tag
  already lived — that is what keeps the lukso icon in `ExternalIcon` justified. `Aeternity`
  and `Powershift` leave the list; `si3`, `powershift`, `cannabis-social-clubs`, `fuel` and
  `aeternity` leave `ExternalIcon` together with their assets and the orphaned `.si3-text`
  gradient. `cg` stays (used by `Search` and `UserProfileV2`).
- [x] Backend: remove `POST /Community/getCommunityCount` + validator + repository method +
  shared type + connector. It existed solely for `EcosystemHomeHeader`.
- [x] Fuel/Aeternity total eradication: `WalletType.FUEL`/`AETERNITY`, `Models.Wallet.Type`,
  `Common.FuelAddress`/`AeternityAddress`, the `fuel`/`aeternity` `SignableWalletData`
  variants, the `/User/getWallets` type filter, the `AccountsPage` icon branches,
  `Fuel.svg`/`Aeternity.svg` and the `--*-fuel*`/`--*-aeternity` CSS variables.
  With the enum down to three EVM variants, `Models.Wallet.Wallet` collapses to a plain object,
  which let `_getAllWalletsByUserId` drop its `as any[]` and the `TypeMapping` lookup that had
  never covered `aeternity` anyway.
- [x] DB: `1785632400000-dropFuelAeternityWallets` — `DELETE FROM wallets WHERE type IN
  ('fuel','aeternity')` (their `wallet_balances` follow via `ON DELETE CASCADE`; the
  `wallet_update_notify` trigger is INSERT/UPDATE-only, so no notifications fire), then the
  standard rename/create/re-cast/drop dance on `wallets_type_enum`, bracketed by dropping and
  re-adding the two unique constraints on the column. `down()` restores the enum but **not** the
  rows — backups cover them, same call as the Phase-2 wizard drop. Verified up+down against a
  throwaway PostgreSQL 15.
- [x] Verified-dead components removed alongside: `UserOnboarding/CreateAccount/` and
  `UserOnboarding/Login/` (zero references repo-wide; they were the last home of the
  commented-out `ConnectAeternityWalletButton` call sites).

**Deviation from plan:** the plan expected `simpleChannels`/`channelNameMap` to possibly survive
for chain display names. They do not — nothing in the surviving tag UI reads them, so both maps
and `HomeChannelTypes` are gone.

### Phase 4 — assistant removal

Decision (2026-08-01, maintainer): the AI assistant is removed **entirely** — everything
that provides the assistant functionality. It was built in a much earlier phase of AI;
its role will eventually be filled by a bot integration (bots are core), and keeping both
makes no sense. This supersedes the old Phase-4 item "document opt-in status".

Full-surface inventory taken 2026-08-01, condensed into the checklist below (≈28 files
deleted, ≈31 edited, ≈4,200 LOC — Phase-2-sized). Verified: **zero overlap with bot
code** (`srv/api/bots.ts`, `srv/api/botV1.ts`, bot repositories untouched). One PR, four
commits in this order — the frontend commit must not land after the backend one, or the
UI would 500 on every assistant route:

- [ ] Frontend (~1,140 LOC): delete `views/AssistantView/` (+css),
  `templates/CommunityLobby/Assistant/` (+css; note `CommunityLobby.tsx` itself does not
  import it), `data/managers/assistantManager.ts` (incl. the `cliAssistantEvent` handler
  and the `BroadcastChannel('cg_assistant')` cross-tab sync),
  `common/assistant/initialMessages.ts`, `common/types/models/assistant.d.ts` (shared with
  the backend via the `srv/common` symlink — one delete serves both compile units).
  Strip: the `assistant/` routes (`App.tsx:84,214`, `CommunityRouter.tsx:36,108`), the
  dead `AssistantView` import in `ChatView.tsx:16`, the `'assistant'` /
  `'community-assistant'` variants in `getUrl` (`common/util.ts`),
  `COMMUNITY_ASSISTANT_ENABLED` / `PERSONAL_ASSISTANT_ENABLED` (`config.ts:219-220` — the
  only feature flags; `instanceConfig` is not involved), the menu entries in
  `ExpandedMenu`, `MobileMenu`, `OwnCommunitiesBrowser` and `CommunityViewSidebar` (incl.
  `assistantPathRegex`), the 7 assistant connectors in `data/api/chat.ts` (keep
  `startChat`/`closeChat`/`getChats` — those are DMs), the assistant namespaces in
  `common/types/api/chats.d.ts` and `Events.Chat.Assistant` in
  `common/types/events/chat.d.ts` (`Events.Chat.Chat` stays). Deps: drop `openai`
  (type-only in the frontend) and `react-syntax-highlighter` + `@types/…` from the root
  manifest. `react-markdown` and `react-icons` STAY (shared with core rendering).
- [ ] Backend (~1,070 LOC): delete `srv/assistant.ts` (dedicated process entry point —
  also remove it from the `include` list in `srv/tsconfig.json:32`), the whole
  `srv/assistant/` tree (queue with OpenAI client + Redis sorted-set scheduling, `data/`,
  `templates/`), `srv/entities/assistant.ts` (glob-registered via
  `srv/util/datasource.ts`, no import site to fix). Strip the 7 assistant routes from
  `srv/api/chats.ts` (~L97-313; keep `/startChat`, `/closeChat`, `/getChats`), the 6
  assistant schemas in `srv/validators/api/chat.ts`, `common.Assistant.ModelName` in
  `srv/validators/common.ts:71-73`. Drop `openai` from `srv/package.json`. nginx needs NO
  change: the `Chat` router whitelist entry stays for DMs, and there is no assistant CSP
  entry. The realtime emitter (`srv/repositories/event.ts`) is core and stays — only the
  `cliAssistantEvent` payload type goes.
- [ ] Schema: one drop migration for `assistant_dialogs` (FKs to `users`/`communities`
  ON DELETE CASCADE + 2 indexes; created `1738856821267-addAssistantDialog`, `model`
  column added `1742985062426`) and `assistant_availability`
  (`1743775203719`). Phase-2/3.5 precedent: `IF EXISTS`-guarded, `down()` restores schema
  incl. writer/reader GRANTs but not rows. The assistant only *read* core tables — no
  cleanup beyond its own two tables. Optional: one-off `DEL` of stale `Assistant_*` Redis
  keys (harmless if skipped).
- [ ] Infra + docs: remove the commented-out `llama` + `assistant` services
  (`docker/docker-compose.yml:337-380`), `docker/docker-compose.gpu.yml`,
  `docker/llama/`, the `AI_USE_GPU` compose-merge branches in `run.sh`,
  `docker/build.sh` and `docker/updateBackend.sh`, the `AI_API_KEY`/`AI_USE_GPU` lines
  from the tracked env template, and the `ai_api_key` docker-secret plumbing. Docs:
  `docs/backend` (§8 AI Assistant + route/entity/flag mentions), `docs/database` (table
  section + two lists), `docs/frontend` (view/manager/route mentions),
  `docs/infrastructure` (§7 GPU support + service-table rows + env rows), AGENTS.md
  (Module Status row → removed; drop `assistant` from the entry-point list), inventories.

### Phase 5 — footprint (bridges into small-footprint roadmap)

- [ ] Deploy-time toggles for `mediasoup` (calls) and `onchain` (blockchain) services in the selfhost profile
- [ ] Redis 3× → 1, **all deployments** (decided 2026-08-01) — details below
- [ ] `wsapi`-in-`api` collapse explicitly deferred (real refactor, low payoff)

**Redis consolidation — feasibility verified 2026-08-01 (full usage sweep): safe with
small changes.** The 2022 three-way split (commit `3201fd80c`) was purely mechanical and
never load-bearing. There is NO dynamic instance-selection mechanism — the three
hostnames are hardcoded in `srv/redis/index.ts:24-37`, the only file that creates
clients (node-redis v4). All three instances run identical configs (`--save ""` = no
persistence, no eviction policy = `noeviction`, same password). Key prefixes are pairwise
disjoint (`sess:`, `ratelimit:`, `bot-ratelimit:`, `bot-presence:`, `captcha:`,
`pluginRequest:`, `ud:`/`us:`, `online-user-addresses`); the socketio instance writes no
keys at all (pure `v2:`-prefixed pub/sub shared deliberately by adapter + emitter); no
`FLUSHALL`/`FLUSHDB`/`SCAN`/`KEYS` in any live application path. mediasoup and push
notifications don't use Redis. The assistant queue — the only blocking-connection
consumer (`BZPOPMIN`) — is gone after Phase 4, which is why Phase 4 runs first.

- [ ] `srv/redis/index.ts`: three literal URLs → one resolved URL (default
  `redis://redis:6379`). **Keep all four client objects** — `session` needs `legacyMode`
  (connect-redis v6 speaks the v3 API) and the Socket.IO subscriber needs a dedicated
  connection; those are protocol requirements, not instance requirements.
- [ ] Keep `--save ""` and `noeviction` — do NOT introduce an eviction policy (it would
  evict `sess:*`, the captcha HMAC key and other non-cache data).
- [ ] `maxmemory` becomes a shared budget: size the merged instance to roughly the sum;
  `REDIS_MAXMEMORY` changes meaning from per-instance to total
  (`docker/selfhost/init.sh`, `docker/SELFHOST.md`, `docs/deployment`).
- [ ] Both compose files: one `redis:` service replaces the three blocks
  (dev `docker-compose.yml:32-51`, selfhost `docker-compose.selfhost.yml:92-111`);
  update the four `depends_on` lists in each.
- [ ] Drive-bys while in there: collapse the triple healthcheck PING
  (`srv/healthcheck.ts:31-36`); give the bare 6-char temp key in
  `srv/redis/userdata.ts:69` a `tmp:` prefix.
- [ ] Cutover note: existing sessions drop once (one forced logout — the same thing any
  Redis restart causes today, since nothing persists).
- [ ] Docs: `docs/infrastructure`, `docs/architecture`, `docs/realtime`,
  `docs/deployment`, `docker/SELFHOST.md`, inventories.

## Rules

- Every phase updates the affected `docs/` sections + AGENTS.md Module Status table in the same PR.
- No new code on `removal-pending` modules in the meantime (enforced via AGENTS.md).
- Deletions are plain `git rm` — no "keep it commented out". Git history is the archive.

## Open verification items

- [x] Confirm no live community depends on a seeded `wizards` row before Phase 2 — checked 2026-08-01: exactly one community has a seeded wizard; maintainer decision: drop the wizard domain (tables incl. data), **keep the community** (DB backups exist)
- [x] Confirm no external tooling reads the feeds tables before the drop migration (Phase 1) — moot: the tables were never created by any migration, and the drop is `IF EXISTS`-guarded
- [x] Maintainer: name the ecosystems that remain in the reduced list (Phase 3) — answered 2026-08-01: **none**. The concept is removed and tags replace it (Phase 3.5).

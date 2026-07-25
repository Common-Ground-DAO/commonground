# Roadmap: Core Slimming (Entschlackung)

> Status: decisions made 2026-07-25 (maintainer). Evidence: [INVENTORY_FRONTEND.md](INVENTORY_FRONTEND.md), [INVENTORY_BACKEND.md](INVENTORY_BACKEND.md).

Goal: focus the app on its core competencies (communities, messaging, calls, articles,
bots, staking, plugins) and remove the legacy surface. Non-core features with a future
belong in the plugin system, not the core app. This roadmap interacts with the Vite
migration (see build-stack roadmap, planned): everything removed here is code we never
have to migrate.

## Decisions (2026-07-25)

| Block | Decision |
|---|---|
| Token-sale complex (buy/claim UI, charts/investors/airdrops subtrees, investor wizard, Sumsub KYC, NDA/US gates, `trackTokenSales` + `tokenSaleNotifications` jobs) | **Remove.** DB tables (`tokensales`, `tokensale_*`, `wizard_*`) are KEPT for auditability. Staking is untouched (core). |
| Aeternity + Fuel wallet logins | **Remove.** Existing `wallets` DB rows remain (type enum values stay). |
| Hardcoded ecosystem partner list + commented-out ecosystem theming | **Reduce/remove.** Ecosystem *filtering* mechanics stay; hardcoded partner list to be reduced to active partnerships; dead theming code removed. EVM + Lukso remain. |
| Verified-dead inventory (4 unrouted views, `WhatsNewModal`, `EarlyAdopterBanner`, feeds domain incl. table drops, 8 no-op one-shot jobs, commented-out routes/blocks) | **Remove, all of it.** Feeds tables dropped via migration (down-migration restores schema). |
| Premium / Spark economy | **Keep — core.** Not part of this roadmap. |

## Execution phases

Each phase is one reviewable PR against `develop`. Order matters: start with zero-risk
deletions, end with the blocks that need coordinated backend+frontend+schema changes.

### Phase 1 — verified-dead code (no behavior change)
- [ ] Remove unrouted views: `AppsView`, `GroupBrowser`, `SwapAccountView`, `BlogBrowser` (+ their lazy imports / commented routes in `App.tsx`)
- [ ] Remove `WhatsNewModal` (hardcoded `return null`) and `EarlyAdopterBanner` (only usage commented) + call sites
- [ ] Remove commented-out route blocks (`App.tsx:211`, `CommunityRouter.tsx:131-134`) and the commented ecosystem theming block (`EcosystemProvider.tsx:36-100`)
- [ ] Remove the 8 one-shot jobs from the `srv/jobs.ts` spawn list + their files (keep `oneshot_jobs` table + `createOneshotWorker` mechanism for future use; archive reward-program logic in git history)
- [ ] Remove feeds domain: `Feed`/`FeedItem`/`CommunityFeed` entities + drop migration for `feeds`, `feeditems`, `communities_feeds`, `communities_feeds_roles_permissions`
- [ ] Fix trivial dead spots found in review: duplicate `/getChats` registration, `cancelAssistantQueueItem` stub (remove route or implement)

### Phase 2 — token-sale complex
- [ ] Frontend: remove `TokenSale.tsx` buy/claim branches, `Info/`, `Charts/`, `TokenAirdrops/` subtrees; `StakeTab` becomes the token page (route stays `/token/`)
- [ ] Frontend: remove `FullscreenWizard/` + `CommunityWizardProvider` + wizard route + `investmentTargets`
- [ ] Frontend: remove Sumsub KYC (`SumsubContext`, `SumsubKyc`, `IdVerificationView`, `/id-verification/` route, `sumsub` API connector)
- [ ] Backend: remove `/Sumsub` router + webhook, wizard routes in `community.ts` (`/Wizard/*`), token-sale routes in `user.ts`/`accounts.ts`, `trackTokenSales` + `tokenSaleNotifications` jobs
- [ ] Backend: keep all DB tables; entities for kept tables remain (read-only surface may stay for auditability)
- [ ] Remove `TOKEN_SALE_ENABLED`/`SHOW_GET_EARN_TABS` flags and Sumsub env/secrets from configs + docs

### Phase 3 — partner chains
- [ ] Remove Aeternity: `AeternityWalletProvider`, sign/login components, `@aeternity/aepp-sdk` dependency, backend verification paths
- [ ] Remove Fuel: `FuelWalletProvider`, sign/login components, `fuels` dependency, backend verification paths
- [ ] Reduce hardcoded ecosystem list (maintainer to name active partnerships; `lukso` stays)
- [ ] Keep `WalletType` enum values and existing `wallets` rows (no data migration)

### Phase 4 — footprint toggles (bridges into small-footprint roadmap)
- [ ] Deploy-time toggles for `mediasoup` (calls) and `onchain` (blockchain) services in the selfhost profile
- [ ] Assistant service: document opt-in status (already off by default)
- [ ] Evaluate: 3× Redis → 1 on selfhost; `wsapi`-in-`api` collapse explicitly deferred (real refactor, low payoff)

## Rules

- Every phase updates the affected `docs/` sections + AGENTS.md Module Status table in the same PR.
- No new code on `removal-pending` modules in the meantime (enforced via AGENTS.md).
- Deletions are plain `git rm` — no "keep it commented out". Git history is the archive.

## Open verification items

- [ ] Confirm no live community depends on a seeded `wizards` row before Phase 2 (query prod DB)
- [ ] Confirm no external tooling reads the feeds tables before the drop migration (Phase 1)
- [ ] Maintainer: name the ecosystems that remain in the reduced list (Phase 3)

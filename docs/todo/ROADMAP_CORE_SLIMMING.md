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
| Aeternity + Fuel wallet logins | **Remove.** Existing `wallets` DB rows remain (type enum values stay). |
| Hardcoded ecosystem partner list + commented-out ecosystem theming | **Reduce/remove.** Ecosystem *filtering* mechanics stay; hardcoded partner list to be reduced to active partnerships; dead theming code removed. EVM + Lukso remain. |
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

### Phase 3 — partner chains — PARTIALLY DONE 2026-08-01 (wallet logins removed; ecosystem list still open)
- [x] Remove Aeternity: `AeternityWalletProvider` (unmounted from `App.tsx`), `AeternitySign`, `ConnectAeternityWalletButton`, `SignWalletPageAeternity` + the `sign-wallet-aeternity` settings page, `@aeternity/aepp-sdk` in both manifests, the `verifyMessage` branch in `prepareWalletAction`. **Finding:** Aeternity was already unreachable for end users. `aeternity` existed in `LoginButtonType`/`LoginOption` but in neither `loginButtons` nor `createButtons`; the `AvailableProvidersPage` entry was commented out (leaving `attemptConnectAeternity` dead), and both `ConnectAeternityWalletButton` call sites sat commented out inside the unrouted `CreateAccount`/`Login` forms. Nothing could navigate to `sign-wallet-aeternity`.
- [x] Remove Fuel: `FuelWalletProvider`/`useFuel`, `FuelSign`, `ConnectFuelWalletButton`, `SignWalletPageFuel` + the `sign-wallet-fuel` settings page, `Fuelet.svg`, `fuels` + `@fuel-wallet/sdk` + `@fuels/connectors`, the `Signer.recoverAddress` branch in `prepareWalletAction`. **Answers the inventory's open question:** yes, Fuel login *was* reachable — `useFuel` is a hook, not a mounted provider, so it worked from `SplashLoginActions` and `AvailableProvidersPage` without being in the `App.tsx` tree.
- [x] Backend: `signableWalletDataValidator` is EVM-only, `prepareWalletAction` accepts `cg_evm`/`evm`, `FuelAddress`/`AeternityAddress` leave `validators/common.ts`, nginx drops `testnet.aeternity.io` / `mainnet.aeternity.io` / `testnet.fuel.network` from every CSP. **Finding:** `walletHelper.getLoginWalletUserId` (the other fuel/aeternity verification site) had **no callers at all** — wallet login goes through the prepared-credential session — so it was removed together with `_getLoginWalletByIdentifier`, its only helper. `errors.server.WALLET_NOT_ALLOWED_FOR_LOGIN` was orphaned by that removal and deleted in the review follow-up (its only thrower was `_getLoginWalletByIdentifier`; no other occurrence repo-wide).
- [ ] Reduce hardcoded ecosystem list (maintainer to name active partnerships; `lukso` stays) — **not started**, blocked on the open verification item below. `fuel` and `aeternity` remain *ecosystems* (`EcosystemProvider`, `EcosystemMenu`, `EcosystemHomeHeader.data.ts`, `predefinedTags.ts`, `ExternalIcon`, the `--*-fuel*`/`--*-aeternity` variables in `index.css`); that is deliberate and untouched by the wallet-login removal.
- [x] Keep `WalletType` enum values and existing `wallets` rows (no data migration). `Models.Wallet.Type`, `Common.FuelAddress`/`AeternityAddress`, the `fuel`/`aeternity` variants of `SignableWalletData` (they type the *stored* `signatureData.data`) and the `fuel`/`aeternity` entries in the `/User/getWallets` type filter all stay, each with a comment saying why. `AccountsPage` still renders those wallets with their chain icon; `Fuel.svg` and `Aeternity.svg` therefore stay too.

### Phase 4 — footprint toggles (bridges into small-footprint roadmap)
- [ ] Deploy-time toggles for `mediasoup` (calls) and `onchain` (blockchain) services in the selfhost profile
- [ ] Assistant service: document opt-in status (already off by default)
- [ ] Evaluate: 3× Redis → 1 on selfhost; `wsapi`-in-`api` collapse explicitly deferred (real refactor, low payoff)

## Rules

- Every phase updates the affected `docs/` sections + AGENTS.md Module Status table in the same PR.
- No new code on `removal-pending` modules in the meantime (enforced via AGENTS.md).
- Deletions are plain `git rm` — no "keep it commented out". Git history is the archive.

## Open verification items

- [x] Confirm no live community depends on a seeded `wizards` row before Phase 2 — checked 2026-08-01: exactly one community has a seeded wizard; maintainer decision: drop the wizard domain (tables incl. data), **keep the community** (DB backups exist)
- [x] Confirm no external tooling reads the feeds tables before the drop migration (Phase 1) — moot: the tables were never created by any migration, and the drop is `IF EXISTS`-guarded
- [ ] Maintainer: name the ecosystems that remain in the reduced list (Phase 3)

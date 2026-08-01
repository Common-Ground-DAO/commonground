# Frontend Inventory — Slimming Decision Basis

> Status: verified against commit 523fceccd, 2026-07-25.
> Update 2026-08-01: Phases 1 and 2 of ROADMAP_CORE_SLIMMING have been executed —
> the four dead views, `WhatsNewModal`, `EarlyAdopterBanner` and the commented-out
> route/theming blocks, and the whole token-sale complex (buy/claim UI, wizard,
> Sumsub KYC) are **removed** (see the per-row notes below).

Working document for the upcoming frontend slimming initiative. It inventories every
view in `src/views/` plus the major feature areas, with route(s), approximate size
(`wc -l`), key dependencies, **reachability** (whether a route actually mounts the view),
and an **evidence-based** legacy assessment. Nothing here proposes deletion of code —
it is a map to decide from.

## Method & evidence basis

- **LoC**: `wc -l` over `*.tsx`/`*.ts` in each view directory (assets/images excluded).
- **Reachability**: traced from `src/App.tsx` (`RoutedContent`), `src/views/CommunityRouter/CommunityRouter.tsx`
  and `src/views/ProfileRouter/ProfileRouter.tsx`. A view is *reachable* only if a live
  `<Route element={…}>` mounts it. Views that are only `React.lazy`-imported but never
  placed in a `<Route>`, or whose route is commented out, are flagged **orphaned/dead**.
- **Activity**: `git log ffe888bd4..HEAD -- <path>` (ffe888bd4 = the docs baseline, mid-March 2026).
  Note: the public GitHub history is squashed to a single root commit (`92df8c677`, "initial
  commit"), so per-line blame dates are not meaningful; "touched since baseline" vs. "untouched
  since baseline" is the only reliable signal, and it is used as such below.

Since the March baseline, the **only** frontend areas with real commits are the token
page / staking (`src/views/TokenSale`) and bot management. Everything flagged legacy below
has had **zero** commits in that window.

---

## 1. Top-level routes (`src/App.tsx` → `RoutedContent`)

| View | Route path | ~LoC | Reachability | Notes / key deps |
|------|-----------|------|--------------|------------------|
| `Home` | `*` (catch-all) and `e/:ecosystem` | 422 | reachable (default) | Landing/explorer; `EcosystemMenu`, `CommunityExplorer` (the mobile `WhatsNewModal` was removed 2026-08-01). |
| `TokenSale` | `/token/` | 3518 → ~730 | reachable | **Reduced 2026-08-01** to a header + `StakeTab`; `TOKEN_SALE_ENABLED` removed, route unconditional. See §3. |
| `TokenSaleRedirect` | `/token-sale` | 17 | reachable | Redirect shim to `/token/`. |
| `IdVerificationView` | — | 56 | **REMOVED 2026-08-01** | Wrapped `SumsubKyc` (§5). |
| `ContentBrowser` | `/feed/` | 28 | reachable | Wraps `ArticleExplorer` (global article feed). |
| `ConversationsBrowser` | `/chats/` | 45 | reachable | DM list. |
| `NotificationsBrowser` | `/notifications/`, `/notifications/:shortUuid/` | 542 | reachable | The commented `EarlyAdopterBanner` usage (line 477) was removed 2026-08-01. |
| `ChatView` | `/chats/:chatShortUuid/` | 55 | reachable | Uses `MessageViewInner`. |
| `AssistantView` | `/assistant/` | 144 | reachable | Also mounted inside communities (§CommunityRouter). |
| `LearnMore` | `/learn-more` | 42 | reachable | Static "What is CG?" marketing page. |
| `ProfileManagementView` | `/settings/` (profile settings) | 42 | reachable | |
| `WalletManagementView` | profile settings → account & wallets | 33 | reachable | |
| `AudioDevicesManagementView` | profile settings → calls | 39 | reachable | |
| `CreateUserPostView` | `/create-user-post` | 15 | reachable | Thin wrapper. |
| `IsolationModeToggle` | `/enable-cross-origin-security`, `/disable-cross-origin-security` | 54 | reachable | COOP/COEP isolation toggle. |
| `TwitterCallbackView` | `/twitter-login` (outside layout) | 41 | reachable | OAuth callback. |
| `VerifyEmailView` | `/verify-email` (outside layout) | 79 | reachable | |
| `CgUpdate` | not a `<Route>` — rendered by `App` when `showReleaseNotes`, and for PWA reload | 431 | reachable (conditional) | Release-notes / update-reload screen. |
| `ProfileView` | via `ProfileRouter` (`/u/:idOrUrl/*`) | 40 | reachable | |
| **`AppsView`** | — | 13 | **REMOVED 2026-08-01** | `React.lazy` at `App.tsx:102`, **never** placed in a `<Route>`. Wraps `PluginAppstore` (reachable elsewhere via modal). |
| **`GroupBrowser`** | — | 27 | **REMOVED 2026-08-01** | `React.lazy` at `App.tsx:113`, never routed. Wraps `CommunityExplorer mode="unlimited"`. |
| **`BlogBrowser`** | `blog-browser` | 40 | **REMOVED 2026-08-01** | Route commented at `App.tsx:211`. Wraps `BlogExplorer`. |
| **`SwapAccountView`** | — | 36 | **REMOVED 2026-08-01** | Import commented at `App.tsx:125`; no route. |

Layout wrappers (not routed views, but live in `src/views/Layout/`): `DesktopLayout`,
`TabletLayout`, `MobileLayout` selected by `useWindowSizeContext` — total `src/views/Layout` ≈ 207 LoC. Core.

`MessageViewInner` (228) and `OwnCommunitiesBrowser` (365) live under `src/views/` but are
**shared components**, not routed views (`MessageViewInner` used by `TextChannel`, `ChatView`,
`CallPage`, `Event`; `OwnCommunitiesBrowser` used by `CommunityViewSidebar`). Core.

## 2. Community routes (`src/views/CommunityRouter/CommunityRouter.tsx`, base `/c/:communityUrl/*`)

All views below are imported **non-lazily** and mounted by live routes (reachable) unless noted.

| View | Route (relative to `/c/:communityUrl/`) | ~LoC | Notes |
|------|------------------------------------------|------|-------|
| `CommunityView` | `*` (catch-all), `channel/:id/*` | 85 | Main community surface. The `wizard/:wizardId/*` route was removed 2026-08-01. |
| `CommunitySettingsView` | `settings/` | 164 | Settings hub. |
| `CommunityManagementView` | `settings/info/` | 39 | |
| `AreaChannelManagementView` | `settings/areas-and-channels/` | 40 | |
| `MemberManagementView` | `settings/members/`, `members/` | 21 | |
| `BanManagementView` | `settings/manage-bans/` | 21 | |
| `RoleManagementView` | `settings/roles/` | 34 | |
| `RolesView` | `roles/` | 23 | Member-facing role list (distinct from `RoleManagementView`). |
| `SafeAndUpgradesView` | `settings/upgrades/` | 34 | Safe / premium upgrades. |
| `OnboardingManagementView` | `settings/onboarding/` | 32 | |
| `TokenSettingsView` | `settings/token/` | 32 | |
| `PluginSettingsView` | `settings/plugins/` | 32 | |
| `BotManagementView` | `settings/bots/` | 25 | Touched since baseline (bot UI). |
| `MemberApplicationView` | `member-applications/` | 21 | |
| `EventsView` | `events/` | 139 | |
| `EventView` | `event/:eventIdOrUrl/` | 674 | |
| `AssistantView` | `assistant/` | 144 | |
| `CommunityTokenView` | `token/` | 17 | Thin wrapper (`CommunityToken`). |
| `CreateArticleView` | `create/article/` | 42 | |
| `ArticleView` | `article/:articleUri/` | 82 | |
| `EditArticleView` | `article/:articleUri/edit/` | 41 | |
| `CallPageView` | `call/:callId/` | 18 | |
| `PluginView` | `plugin/:pluginId/` | 568 | Plugin iframe host. |

Dead code inside `CommunityRouter`: a block of `announcements/articles/guides/drafts`
routes was commented out (lines 131–134) — **removed 2026-08-01**. It was a duplicate of the
live routes in `CommunityView.tsx`, so `CommunityContentList` itself stays.

## 3. ProfileRouter (`/u/:idOrUrl/*`)

| View | Route | ~LoC | Reachability |
|------|-------|------|--------------|
| `ProfileView` | `*` | 40 | reachable |
| `BlogView` | `article/:articleUri` | 65 | reachable |
| `EditBlogView` | `article/:articleUri/edit` | 54 | reachable |

---

## Feature deep-dives

### Wizard system — `FullscreenWizard` + `CommunityWizardProvider`

- **Files**: `src/context/CommunityWizardProvider.tsx` (121), `src/components/organisms/FullscreenWizard/` ≈ 1805 LoC across 10 `*.tsx` (`FullscreenWizard` 432, `WizardInvest` 462, `WizardDataRoom` 302, `WizardStartOrLogin` 165, `WizardLoginFallback` 131, `WizardOGView`, `WizardEmailView`, `WizardNdaConfirmCheckboxView`, `WizardAmericanConfirmCheckboxView`, `WizardShareLink`), plus `src/common/types/models/wizard.d.ts` (175) and `WizardImage/` assets.
- **Route**: `/c/:communityUrl/wizard/:wizardId/*` (via `CommunityWizardProvider`, mounted in `CommunityRouter`). Reachable, but only usable if a community has server-side wizard definitions.
- **Purpose**: This is **not** a generic onboarding wizard — it is the CG **token-sale / investor onboarding flow**. Step types are `startOrLogin`, `invest` (`WizardInvest` → `wizardClaimInvestmentTransaction`, uses `common/investmentTargets`), `dataRoom`, `ndaConfirmCheckboxView`, `americanConfirmCheckboxView` (US-investor gate), `kyc` (Sumsub, `kycLiveness`/`kycFull`/`kycCgTokensale`), `emailView`, `OGView`, `shareLink`, `plainContent`.
- **Dependencies**: `communityApi` (getWizardData, wizardSetWizardStepData, wizardFinished, wizardClaimInvestmentTransaction), `SumsubKyc`, `investmentTargets`, `ethers`.
- **Legacy assessment**: **REMOVED 2026-08-01** together with the five `wizard*` tables (migration `1785628800000-dropWizardDomain`) and the wizard-only content elements in `MessageBodyRenderer`.

### TokenSale flow — `src/views/TokenSale/`

- **Size**: ≈ 3518 LoC (`*.tsx`/`*.ts`), the single largest view. Sub-areas: root `TokenSale.tsx` (1342), `StakeTab/` (`StakeTab` 375, `LockDurationSlider` 140, `WalletOverview` 96), `Info/` (`TokenSaleInfo` 312, `TokenSaleInvestors` 263, `TokenSaleFeaturePreviews` 87, `InfoArticleBox` 78), `Charts/` (`SaleGraph` 227, `DistributionPie` 218, `TokenDistributionGraph` 217), `TokenAirdrops/` (~119), `TokenSaleRedirect` (17), `TokenSale.helper` (27), plus `icons/` and `Info/*Imgs/` assets.
- **Route**: `/token/`, was gated by `config.TOKEN_SALE_ENABLED`; the flag was removed 2026-08-01 and the route is now unconditional.
- **State of the tabs**: `TokenSale.tsx` has three tabs `buy | claim | stake`. The Get/Earn (buy/claim) tabs are hardcoded off — `const SHOW_GET_EARN_TABS = false;` (line 110) — and the page defaults to `stake`. So the **buy/claim marketing + charts + investors + airdrops UI is present but not shown**, while `StakeTab` is the active, actively-maintained surface (all post-baseline commits are staking: reward curve, duration slider, wallet overview, RPC fixes, zero-Spark guard).
- **Dependencies**: `wagmi`/`viem`/`rainbowkit`, `stakingApi`, `common/staking` (contract ABIs), `common/chainIds`.
- **Legacy assessment**: **Split, executed 2026-08-01.** `StakeTab/` (+ its API) is **core / active** and is now the whole page. The `Info/`, `Charts/`, `TokenAirdrops/` subtrees and the `buy`/`claim` branches of `TokenSale.tsx` are **removed**.

### Ecosystem feature — `EcosystemProvider` / `EcosystemPicker` / `EcosystemMenu`

- **Files**: `src/context/EcosystemProvider.tsx` (125), `EcosystemMenu` (331+27, now `TagFilterMenu`), `EcosystemHomeHeader` (194+78+`.data.ts` 262), `EcosystemPicker` (162+62), `EcosystemPickerField` (65), `EcosystemChip` (36+24). Total ≈ 1366 LoC.
- **Routing**: `/e/:ecosystem` (via `EcosystemParamSetter` → `Home`). Ecosystems enumerated in-code: `fuel, lukso, si3, cannabis-social-clubs, powershift` (prod & staging identical). `EcosystemMenu`/picker are consumed by `Home`, `ExpandedMenu`, `CommunityExplorer`, `TagHeader`, `LoginBanner`, tag inputs — so ecosystem **filtering is live**.
- **Notable**: The per-ecosystem **theming** in `EcosystemProvider` (all the CSS-variable overrides for fuel/lukso/powershift) was **entirely commented out** (lines 36–100) and was **removed 2026-08-01**; the provider only ever *removes* the eco variables. So the provider is effectively a no-op wrapper around ecosystem-scoped routing/filtering.
- **Legacy assessment**: **REMOVED 2026-08-01** (Phase 3.5). The maintainer's answer to the open question below was "none": the whole feature goes and **tags replace it**. Provider, param setter, picker, chip, picker field and home header are deleted; single-segment `/e/:ecosystem` URLs redirect to `/`; `ecosystemTagList` and the partner icons (si3, powershift, cannabis-social-clubs, fuel, aeternity) are gone. `EcosystemMenu` survives — it was the tag-filter dropdown all along — renamed to `TagFilterMenu`. Existing partner tag strings on communities are left in place as ordinary tags.

### Sumsub KYC — `SumsubContext` / `SumsubKyc`

- **Files**: `src/context/SumsubContext.tsx` (69), `src/components/molecules/SumsubKyc/SumsubKyc.tsx` (154), `src/data/api/sumsub.ts` (21), types (27).
- **Reachability**: `SumsubContextProvider` wraps the whole app (`App.tsx`). `SumsubKyc` mounts in two live places: the `/id-verification/` route (`IdVerificationView`) and the Wizard `kyc` step.
- **Legacy assessment**: **REMOVED 2026-08-01.** Both entry points (the wizard `kyc` step and the dev-only `/id-verification/` page) are gone, so the integration, the `kyc` capability flag and the `@sumsub/websdk*` dependencies went with them.

### Aeternity & Fuel wallet providers

- **Aeternity**: `src/context/AeternityWalletProvider.tsx` (203) was mounted app-wide in `App.tsx`. Consumers: `ConnectAeternityWalletButton` (113), `AeternitySign` (106), `SignWalletPageAeternity` (98), plus onboarding `CreateAccount`/`Login`/`Splash` and `AvailableProvidersPage`. **Correction (2026-08-01): it was not actually reachable** — `aeternity` was missing from both `loginButtons`/`createButtons`, the `AvailableProvidersPage` entry was commented out, and the two `ConnectAeternityWalletButton` call sites were commented out inside unrouted forms.
- **Fuel**: `src/context/FuelWalletProvider.tsx` (138) is **not** mounted as a top-level provider in `App.tsx` (unlike Aeternity). It is imported/consumed by `SplashLoginActions`, `AvailableProvidersPage`, `ConnectFuelWalletButton` (128), `FuelSign` (104), `SignWalletPageFuel` (98) — i.e. the provider is used locally where Fuel login is offered. **Answered 2026-08-01: yes, Fuel login was live.** `useFuel` is a plain hook, not a context provider, so it worked from `SplashLoginActions` (the `fuel` entry was in both button lists) and from the settings `AvailableProvidersPage` without ever being in the `App.tsx` tree.
- **Legacy assessment**: **REMOVED 2026-08-01** (Phases 3 + 3.5). Phase 3 took both providers, both sign/status components, both connect buttons, both `sign-wallet-*` settings pages, `Fuelet.svg` and the `@aeternity/aepp-sdk` / `fuels` / `@fuel-wallet/sdk` / `@fuels/connectors` dependencies, plus the backend verification branches. Phase 3.5 finished it: `WalletType` values, address types, `SignableWalletData` variants, `AccountsPage` icons, `Fuel.svg`/`Aeternity.svg`, the `--*-fuel*`/`--*-aeternity` CSS variables **and the stored `wallets` rows** (`1785632400000-dropFuelAeternityWallets`). Repo-wide, the words no longer appear in any tracked file.

### Browsers: Group / Blog / Content

- `GroupBrowser` (27) — **removed 2026-08-01** (was imported, never routed).
- `BlogBrowser` (40) — **removed 2026-08-01** (route was commented, `App.tsx:211`).
- `ContentBrowser` (28) — **live** at `/feed/`.
- All three are thin wrappers around explorers (`CommunityExplorer` / `BlogExplorer` / `ArticleExplorer`); the explorers themselves are reused elsewhere, so removing the dead wrapper views is low-risk.

### Feeds remnants

- `URL_FEED = 'feed'` → `/feed/` still resolves to `ContentBrowser` (global article feed), so "feed" as a **route** is live. No separate legacy "feeds" view remains beyond the browser wrappers above; references to `feed` in `Home`/`CgUpdate` are the article-explorer feed, not a distinct subsystem.

### WhatsNewModal / EarlyAdopterBanner

- `WhatsNewModal` (85) — **removed 2026-08-01**; was wired into `Home` (mobile) and `ExpandedMenu`, **but the component early-returned `null`** (`WhatsNewModal.tsx`, `return null;` with a `// FIXME: uncomment if you want it to work`). Effectively **disabled dead code**; also contains a hardcoded promo URL/date. **Dead**.
- `EarlyAdopterBanner` (68) — **removed 2026-08-01**; its only usage was **commented out** in `NotificationsBrowser.tsx:477`.

### Supporter / premium UI

- `BecomeSupporter` (273), `SupporterPurchaseConfirm` (67), `SupporterPurchaseSuccess` (45), `SupporterScreen`, `SupporterGold/Silver` icons — under `UserSettingsModalContent`. Community-side: `PremiumManagement/` (`PremiumManagement` 231 + `UpgradesTab`/`BillingTab`), reached from `SafeAndUpgradesView` / community settings. Also intertwined with the Spark economy (`GetSpark`, `PaySpark`, `PaySparkSuccess`).
- **Legacy assessment**: Not investigated for live billing wiring here. Reachable via settings. **Verify with product** whether supporter/premium purchase is an active offering before touching. **Verify** (do not assume dead — it is wired into current Spark UI, which *is* active).

---

## Candidate summary

| Feature | Approx size | Evidence | Proposal |
|---------|-------------|----------|----------|
| `StakeTab` + staking (within TokenSale) | ~600 LoC | Only actively-committed frontend area since baseline | **core** |
| TokenSale `Info/` + `Charts/` + `TokenAirdrops/` + buy/claim tabs | ~2500 LoC | Behind hardcoded `SHOW_GET_EARN_TABS=false`; no commits since baseline | **removed 2026-08-01** |
| Wizard (`FullscreenWizard` + `CommunityWizardProvider`) | ~1900 LoC | Token-sale/investor funnel; untouched since baseline; isolated route | **removed 2026-08-01** (tables dropped too) |
| Sumsub KYC | ~270 LoC | Entry points = wizard + `/id-verification/`; untouched | **removed 2026-08-01** |
| Aeternity wallet | ~520 LoC | Partner-chain login; app-wide provider but no reachable entry point | **removed 2026-08-01** |
| Fuel wallet | ~600 LoC | Partner-chain login; provider not in global tree, but reachable (hook, not context) | **removed 2026-08-01** |
| Ecosystem theming (in `EcosystemProvider`) | ~65 LoC commented | Entire theming block commented out | **removed 2026-08-01** |
| Ecosystem filtering/menu/picker | ~1300 LoC | Wired & reachable across Home/menu/explorer | **removed 2026-08-01** (tags replace it; `EcosystemMenu` kept as `TagFilterMenu`) |
| `AppsView` | 13 | Imported, never routed | **removed 2026-08-01** |
| `GroupBrowser` | 27 | Imported, never routed | **removed 2026-08-01** |
| `SwapAccountView` | 36 | Import commented, never routed | **removed 2026-08-01** |
| `BlogBrowser` | 40 | Route commented (`App.tsx:211`) | **removed 2026-08-01** |
| `WhatsNewModal` | 85 | Component hardcoded `return null` | **removed 2026-08-01** |
| `EarlyAdopterBanner` | 68 | Only usage commented (`NotificationsBrowser:477`) | **removed 2026-08-01** |
| `CommunityRouter` announcements/articles/guides/drafts routes | ~4 lines | Commented out (lines 131–134) | **removed 2026-08-01** |
| Supporter / premium UI | ~1000 LoC | Wired into active Spark UI; billing state not confirmed | **verify** (likely core) |
| Everything else in §1–3 not listed | — | Reachable, standard app surfaces | **core** |

## Open questions for the maintainer

1. ~~Is the public **token sale** returning?~~ — answered 2026-07-25 (no) and executed 2026-08-01: buy/claim subtree, wizard funnel, Sumsub KYC and the American/NDA gates are removed.
2. ~~Is the standalone `/id-verification/` route still surfaced anywhere in the UI?~~ — it was a `DEPLOYMENT === 'dev'`-only menu entry; removed 2026-08-01 with the rest of KYC.
3. ~~Is the **Fuel** login option actually shown to users?~~ **Answered 2026-08-01: yes.** `useFuel` is a hook, so the missing `App.tsx` mount meant nothing; the option was in `loginButtons`/`createButtons` and in the settings provider list. (Aeternity, despite its app-wide provider, had no reachable entry point at all.) Both are now removed.
4. ~~Are the hardcoded partner **ecosystems** (`fuel, lukso, si3, cannabis-social-clubs, powershift`) all still active partnerships?~~ **Answered 2026-08-01: none of them.** The maintainer removed the ecosystem concept entirely; tags are the slimmer replacement. LUKSO *compatibility* is unaffected — it was never an ecosystem question.
5. ~~Confirm the four **dead views** (`AppsView`, `GroupBrowser`, `SwapAccountView`, `BlogBrowser`) and two **dead widgets** (`WhatsNewModal`, `EarlyAdopterBanner`) can be removed~~ — confirmed by the maintainer and removed 2026-08-01.
6. Is **Supporter/premium** purchasing live? It is wired into the current Spark UI, so it is assumed core, but the billing flow was not runtime-verified here.

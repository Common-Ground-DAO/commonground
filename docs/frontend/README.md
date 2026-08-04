# Common Ground Frontend Documentation

> Status: verified against commit ac33fcf69, 2026-08-04

This document describes the frontend architecture of Common Ground, a browser-based social platform for communities built with React and TypeScript. It is intended for AI agents and developers working on the codebase.

**License:** AGPL-3.0-or-later (see LICENSE-ADDITIONAL-TERMS.md for additional terms)

---

## 1. Component Architecture (Atomic Design)

The project follows atomic design principles. All components live under `src/components/` and are organized into five layers.

### Atoms (`src/components/atoms/`)

The smallest, most reusable UI primitives. They have no business logic and accept props for customization.

| Component | Purpose |
|---|---|
| `Button` | Standard button with variants |
| `Checkbox` / `CheckboxBase` | Checkbox inputs |
| `RadioButton` / `RadioButton2` | Radio button inputs |
| `Modal` | Base modal overlay wrapper |
| `Tag` | Label/tag chip |
| `Tooltip` | Hover tooltip (also exports `Popover`) |
| `SearchField` | Text input styled for search |
| `Timestamp` | Renders human-readable timestamps (uses dayjs) |
| `Jdenticon` | Identicon avatar generator |
| `StatusIndicator` | Online/offline/away status dot |
| `NotificationCount` | Badge showing unread count |
| `NotificationDot` | Simple unread indicator dot |
| `SkeletonLine` | Loading skeleton placeholder |
| `Snackbar` | Toast/snackbar notification |
| `InlineToast` | Inline alert message |
| `Step` | Step indicator for wizards |
| `SimpleLink` | Styled anchor/link (exports `isLocalUrl`, `isLocalUrl` helpers) |
| `BottomSliderModal` | Mobile bottom-sheet modal |
| `Breadcrumbs` | Navigation breadcrumb trail |
| `CollapsableElement` | Expand/collapse wrapper |
| `CollapsableTopBarLayout` | Layout with collapsable top bar |
| `FullscreenImageModal` | Lightbox for images |
| `ScreenAwareDropdown` | Dropdown that adapts to viewport |
| `ScreenAwareModal` | Modal that adapts to viewport |
| `ScreenAwarePopover` | Popover that adapts to viewport |
| `AnimatedContainerVertical` | Vertical expand/collapse animation |
| `AnimatedTabPage` | Animated tab page transition |
| `BookmarkButton` | Bookmark toggle |
| `ShareButton` | Share action button |
| `JoinCommunityButton` | Join/leave community toggle |
| `AttendEventButton` | RSVP toggle for events |
| `BigWalletIcon` | Large wallet icon display |
| `BotBadge` | "BOT" chip marking bot accounts (with tooltip) |
| `CommunityPhoto` | Community avatar/photo |
| `ExternalIcon` | External link icon |
| `ListItem` | Generic list row |
| `MemberPreview` | Compact member display |
| `PaddedIcon` | Icon with standardized padding |
| `ReactionEmojiItem` | Single emoji reaction display |
| `RolePermissionUnit` / `RolePermissionToggleUnit` | Permission display atoms |
| `SettingsListItem` | Settings menu row |
| `SidebarContainer` | Sidebar wrapper |
| `SparkMultiIcon` | Multi-spark icon for premium |
| `SupporterIcon` | Supporter badge icon |
| `UserTag` | User name badge/chip |
| `UserInfoManager` | Invisible component that manages user info retrieval in the background |
| `YoutubeIframe` | YouTube embed iframe |
| `DropdownHeader` | Header row for dropdown menus |
| `CheckCircle` | Circular check icon |
| `icons/` | Directory of SVG icon components (16px, 20px, 24px, misc sizes; includes `misc/spark.svg` for the Spark currency) |

### Molecules (`src/components/molecules/`)

Composed of atoms; represent small, functional UI units.

| Component | Purpose |
|---|---|
| `Message` | Single chat message display (text, attachments, reactions). Its `MessageTooltip` sub-component hosts the per-message actions incl. the **Report** action. |
| `MesssageBodyRenderer` | Renders message/article body content into React elements. Note the triple-`s` directory name. See §6 for the markdown pipeline. Exports `MessageBodyRenderer`, `AllContentRenderer`, and (in `MarkdownContent.tsx`) `MarkdownContent` + `toMarkdownSource`. |
| `CommentMessage` | Article/post comment display |
| `CommentList` | List of comments |
| `Dialog` | Confirmation/action dialog |
| `Dropdown` | Dropdown menu |
| `EmojiPickerTooltip` | Emoji picker in a tooltip popover |
| `LinkPreview` | URL preview card (OG metadata); `LinkPreviewLoader` fetches previews for internal links |
| `MediaAttachment` | Image/video/file attachment display |
| `GiphyAttachment` | Giphy GIF attachment |
| `UserProfilePhoto` | User avatar with optional status indicator |
| `UserProfileV2` | Compact user profile card |
| `UsernameWithVerifiedIcon` | Username with optional verification badge |
| `ConnectionStatusIndicator` | Shows websocket/network connection status banner |
| `CommunityCard` | Community discovery card |
| `CommunitySkeletonCard` | Loading skeleton for community card |
| `CommunityContentSkeletonCard` | Loading skeleton for community content |
| `EventCard` | Event listing card |
| `LiveCallCard` | Active voice/video call card |
| `RoleCard` | Role display card |
| `RolePhoto` | Role icon/photo |
| `NotificationMessage` | Single notification display |
| `NotificationBanner` | Notification prompt banner |
| `NotificationTypeSelector` | Notification preference toggles |
| `LoginBanner` / `MiniLoginBanner` | Prompt to log in (full + inline "midway" variant) |
| `CreateCommunityBanner` | Prompt to create a community |
| `JoinCallModal` | Modal to join a voice/video call |
| `PinnedChatOptionsModal` | Options for pinned channels |
| `VoiceChatOptionsModal` | Options for voice channel |
| `DirectMessageBar` | DM input bar |
| `Scrollable` | Custom scrollbar wrapper (used extensively) |
| `ContentSlider` | Horizontal content carousel |
| `HorizontalContentSlider` | Another horizontal slider variant |
| `GroupSlider` | Slider for community groups |
| `AudioManagerButtons` | Mute/unmute/deafen audio controls |
| `AudioWidget` | Floating audio call widget |
| `UserWidget` | Current user widget (bottom-left) |
| `UserSettingsButton` | Settings gear button |
| `UserSettingsHeader` | Header for user settings |
| `StartCallButton` | Button to initiate a call |
| `TalkersCounterButton` | Shows count of users in voice |
| `VoiceChannelDescription` | Voice channel info display |
| `VoiceChannelTalkers` | Avatars of users in voice channel |
| `WalletConnector` | Wallet connect UI (uses RainbowKit) |
| `WalletRow` / `WalletManagerRow` | Wallet list items |
| `TokenGatedTag` | Tag indicating token-gated access |
| `PremiumBox` | Premium tier upsell box |
| `ContractDetails` | Smart contract details display |
| `AccessRulesEditor` | Editor for role access rules |
| `RoleAccessEditor` | Editor for role-based access |
| `OptionToggle` | Toggle switch |
| `ToggleText` | Toggle with text labels |
| `PasswordField` | Password input with show/hide |
| `MenuButton` / `MenuNftButton` | Main navigation menu buttons |
| `HexagonalIconButton` | Hexagonal shaped icon button |
| `SettingsButton` | Settings action button |
| `SocialLink` | Social media link display |
| `PinnedChannel` | Pinned channel display |
| `PluginInstallField` | Plugin installation UI |
| `SectionEnd` / `SectionEndGroups` | Section dividers |
| `FrontPageSectionHeader` | Section header for home page |
| `ManagementHeader` / `ManagementHeader2` | Headers for admin views |
| `GenericMessageList` | Reusable message list container |
| `CollapsableGroup` | Collapsable section group |
| `AreaList` | List of community areas |
| `CallList` | List of active calls |
| `ArticleCardV2` | Article preview card |
| `CommunityInput` | Community-specific input field |
| `CommunityLinksInput` | Input for community social links |
| `NewsletterSubscribeField` / `NewsletterSubscribeInput` | Email newsletter subscription |
| `ExternalLinkModal` | Warning modal for external links |
| `GridToColumnToggle` | Grid/list view toggle |
| `PWA` | PWA install prompt |
| `inputs/` | Shared input components (`TextInputField`, `TextAreaField`, etc.) |
| `LiveCallSlider` | Slider showing active calls |
| `JoinNewsletterBanner` | Newsletter subscribe banner |
| `CaptchaModal` | CAPTCHA challenge modal |
| `RolePermissionList` | List of role permissions |
| `RolePermissionToggle` | Individual permission toggle |

### Organisms (`src/components/organisms/`)

Complex, self-contained UI sections that combine molecules and atoms with significant business logic.

| Component | Purpose |
|---|---|
| `TextChannel` | The main text channel view -- message list + input. Core messaging component. |
| `EditField` | Rich text message editor built on **Slate.js**. Supports mentions, embeds, file attachments, GIFs (Giphy), emoji picker, link previews, and a hovering formatting toolbar. |
| `ChannelList` | Sidebar channel list for a community (areas + channels tree) |
| `CommunityViewSidebar` | Full community sidebar (community header + channel list + voice channels). Has its own context (`CommunityViewSidebarContext`). Also hosts community-level report affordances via `reasonCodeToText`. |
| `CommunityHeader` | Community name, photo, and action buttons at top of sidebar |
| `CommunitySettings` / `CommunitySettingsList` | Community settings panels |
| `CommunityExplorer` | Community discovery/browsing grid |
| `MemberList` | Community member list with roles. Has its own context (`MemberListContext`). |
| `Menu` / `MobileMenu` / `ExpandedMenu` | Main navigation menu (left sidebar on desktop). Shows own communities, DMs, notifications. |
| `CallPage` | Voice/video call UI with MediaSoup integration. Uses a reducer (`CallPage.reducer`) for call state. |
| `VoiceCallManager` / `MobileVoiceCallManager` | Manages active voice call overlay/widget |
| `StartCallModal` | Modal to configure and start a new call |
| `Search` | Global search organism |
| `Article` | Full article display |
| `ArticleExplorer` | Article browsing/discovery |
| `ArticleList` | List of articles |
| `ArticleCommentSection` | Comments section for articles |
| `GenericArticle` | Generic article renderer. Hosts the article-level **Report** action via `useReportModalContext`. |
| `GenericArticleManagement` | Article CRUD management |
| `Blog` | Blog post display |
| `BlogExplorer` | Blog browsing |
| `BlogList` | Blog post list |
| `BlogManagement` | Blog CRUD management |
| `EmailEditor` | Rich text email/newsletter editor |
| `EventExplorer` | Event discovery |
| `EventsList` | Event list |
| `ScheduleEventModal` | Modal to create/edit events |
| `LiveCallExplorer` | Browse active calls |
| `GroupList` | Community group list |
| `ChatsMenu` | DM conversations sidebar menu |
| `UserProfile` | Full user profile display |
| `UserProfileDetails` | Detailed profile info |
| `UserProfileModal` | Profile popup modal |
| `UserProfileAdminPanel` | Admin actions for user profiles |
| `UserProfileManagement` | Own profile editing |
| `UserTooltip` | Hover tooltip showing user info |
| `ProfileForm` | Profile edit form |
| `IdentitiesEditor` | Manage linked identities (wallets, social accounts) |
| `UserSocialLinksEditor` | Edit social media links |
| `UserSettings` / `UserSettingsList` / `UserSettingsModalContent` | User settings panels. `UserSettingsModalContent` mounts the personal **Bots** page (`BotsPage` + `BotEditor`). |
| `UserSettingsModalContent/BotsPage` | Personal bot management: `BotsPage` lists the user's bots; `BotEditor` creates/edits a bot, issues/revokes tokens, and configures scopes. |
| `UserOnboarding` | New user onboarding wizard overlay |
| `SwapAccount` | Account switching UI |
| `WalletsEditor` / `WalletsManagement` | Wallet management UI |
| `ConnectedWalletsModal` | Modal showing connected wallets |
| `RoleAssignmentList` | Assign roles to members |
| `RoleBenefitsModal` | Modal showing role benefits |
| `RoleClaimedModal` | Confirmation after claiming a role |
| `AddPermissionModal` | Modal for adding permissions |
| `AudioDevicesManagement` | Audio input/output device selection |
| `CommunityJoinedModal` | Post-join welcome modal |
| `CommunityPendingModal` | Pending membership modal |
| `CommunityQuestionnaireModal` | Community join questionnaire |
| `CommunityRequirementsModal` | Shows requirements to join |
| `GatedDialogModal` | Token/role gating dialog |
| `LeaveCommunityModal` | Confirm leave community |
| `LogOffModal` | Confirm logout |
| `EmailConfirmationModal` | Email verification modal |
| `PostPublishedModal` | Article published confirmation |
| `SchedulePostModal` | Schedule article publication |
| `ManagementContentModal` | Generic management modal |
| `SupporterScreen` | Supporter/premium purchase screen |
| `TagFilterMenu` | Tag-filter dropdown behind `TagHeader`'s "Filter by tags" |
| `MyCommunitiesExplorer` | Browse own communities |
| `PluginAppstore` | Plugin marketplace |
| `IframePluginPortal` | Renders plugin iframes |
| `TagHeader` | Tag/category header |

### Templates (`src/components/templates/`)

Page-level layout templates that compose organisms into full page structures.

| Template | Purpose |
|---|---|
| `CommunityLobby` | The community landing/lobby page layout. Displayed when no specific channel is selected. Contains a `BotManagement/` sub-template for the community-scoped bot admin surface (list, install from catalog, per-bot roles, allow/deny user bots). |
| `CommunityContentList` | Template for listing community content (articles, announcements). |
| `CreateCommunity` | Multi-step community creation wizard layout. |

### SuspenseRouter (`src/components/SuspenseRouter/`)

Not a visual component but a critical infrastructure piece. `SuspenseRouter` wraps React Router's `Router` with `useTransition` to enable concurrent rendering during navigation. It also:
- Provides a `NavigationContext` with `isDirty` and `setDirty` for unsaved-changes warnings on navigation.
- Integrates with Matomo analytics (tracks page views on navigation).
- Supports triggering app updates on navigation via `setUpdateOnNavigate`.

---

## 2. Views

Views are full pages composed of templates/organisms. They live in `src/views/` and are loaded via React.lazy for code splitting. Views are grouped below by function.

### Home and Discovery

| View | Route | Purpose |
|---|---|---|
| `Home` | `/` (fallback `*`) | Main landing page, community discovery feed |
| `ContentBrowser` | `/feed/` | Content feed browser |
| `LearnMore` | `/learn-more` | Informational page |
| `OwnCommunitiesBrowser` | (embedded) | Browse own communities |

### Community Views

| View | Route | Purpose |
|---|---|---|
| `CommunityView` | `/c/:communityUrl/*` (default) | Main community page -- shows lobby or selected channel |
| `CommunitySettingsView` | `/c/:communityUrl/settings/` | Community settings landing |
| `CommunityManagementView` | `.../settings/info/` | Edit community info (name, description, photo) |
| `AreaChannelManagementView` | `.../settings/areas-and-channels/` | Manage areas and channels |
| `MemberManagementView` | `.../settings/members/` | Manage community members |
| `BanManagementView` | `.../settings/manage-bans/` | Manage banned users |
| `RoleManagementView` | `.../settings/roles/` | Manage roles and permissions |
| `OnboardingManagementView` | `.../settings/onboarding/` | Configure join onboarding |
| `TokenSettingsView` | `.../settings/token/` | Community token settings |
| `PluginSettingsView` | `.../settings/plugins/` | Manage community plugins |
| `BotManagementView` | `.../settings/bots/` | Community bot management (installed bots, roles, user-bot policy) |
| `SafeAndUpgradesView` | `.../settings/upgrades/` | Premium upgrades and Safe settings |
| `RolesView` | `.../roles/` | Public roles listing (claimable roles) |
| `EventsView` | `.../events/` | Community events listing |
| `EventView` | `.../event/:eventIdOrUrl/` | Single event detail page |
| `MemberApplicationView` | `.../member-applications/` | Review pending member applications |
| `CommunityTokenView` | `.../token/` | Community token detail page |
| `PluginView` | `.../plugin/:pluginId/` | Single plugin view (wrapped in `CommunityPluginProvider`) |

### Articles and Content

| View | Route | Purpose |
|---|---|---|
| `ArticleView` | `.../article/:articleUri/` | Read a community article |
| `CreateArticleView` | `.../create/article/` | Create a new article |
| `EditArticleView` | `.../article/:articleUri/edit/` | Edit an existing article |
| `BlogView` | `/u/:idOrUrl/article/:articleUri` | Read a user blog post |
| `EditBlogView` | `/u/:idOrUrl/article/:articleUri/edit` | Edit a user blog post |
| `CreateUserPostView` | `/create-user-post` | Create a user post |

### Messaging

| View | Route | Purpose |
|---|---|---|
| `ChatView` | `/chats/:chatShortUuid/` | Direct message conversation view |
| `ConversationsBrowser` | `/chats/` | List of DM conversations |
| `MessageViewInner` | (embedded) | Inner message display component |

### Voice/Video Calls

| View | Route | Purpose |
|---|---|---|
| `CallPageView` | `.../call/:callId/` | Full voice/video call page (MediaSoup) |

### Profile

| View | Route | Purpose |
|---|---|---|
| `ProfileView` | `/u/:idOrUrl` (default) | User profile page |
| `ProfileManagementView` | `/settings/profile/` | Edit own profile |
| `WalletManagementView` | `/settings/account-and-wallets/` | Manage wallets and account |
| `AudioDevicesManagementView` | `/settings/calls/` | Audio device settings |

### Notifications

| View | Route | Purpose |
|---|---|---|
| `NotificationsBrowser` | `/notifications/`, `/notifications/:notificationShortUuid/` | Notification list (optionally focused on one notification) |

### Auth and Verification

| View | Route | Purpose |
|---|---|---|
| `TwitterCallbackView` | `/twitter-login` | Twitter OAuth callback handler (rendered outside main layout) |
| `VerifyEmailView` | `/verify-email` | Email verification handler (rendered outside main layout) |

### Token and Commerce

| View | Route | Purpose |
|---|---|---|
| `TokenSale` | `/token/` | Token / Spark page. Since the Phase-2 slimming (2026-08-01) it is a thin header plus `StakeTab`; the buy/claim tabs, the charts and the investor/airdrop sections are gone. |
| `TokenSale/StakeTab` | (embedded) | Staking UI: connect wallet, choose amount + lock duration, preview Spark reward, submit the on-chain stake. |

### System

| View | Route | Purpose |
|---|---|---|
| `CgUpdate` | (conditional) | Release notes / forced update screen |
| `IsolationModeToggle` | `/enable-cross-origin-security`, `/disable-cross-origin-security` | Toggle COOP/COEP isolation mode |
| `Layout` (Desktop/Tablet/Mobile) | (wrapper) | Responsive layout wrappers selected based on viewport size |

---

## 3. State Management

State management uses a layered approach: React Context for shared UI state, Dexie (IndexedDB) for persistent local data, and singleton manager classes for connection/auth state.

### React Context Providers (`src/context/`)

Providers are composed across three levels:

1. `src/index.tsx` wraps everything in `ConnectionProvider` (outermost) and, inside the router, `GlobalDictionaryProvider` (i18n).
2. `src/App.tsx` `App()` wraps the app in `DarkModeProvider`.
3. `src/App.tsx` `Inner()` composes the large provider stack. Nesting order matters -- outer providers are available to inner ones.

The `Inner()` stack (outer → inner) is, in order: `IsolationModeProvider`, `WagmiProvider`, `QueryClientProvider` (TanStack Query, required by wagmi 2), `RainbowKitProvider`, `AuthKitProvider` (Farcaster), `WindowSizeProvider`, `SnackbarContextProvider`, `OwnDataProvider`, `PasskeyProvider`, `MobileLayoutProvider`, `NotificationProvider`, `CommunitySidebarProvider`, `ExternalModalProvider`, `UserOnboardingProvider`, `CreateCommunityModalProvider`, `LoginWithKeyphraseProvider`, `CopiedToClipboardDialogProvider`, `CallDevicesProvider`, `CallProvider`, `CommunityProvider`, `CommunityListViewProvider`, `UserSettingsProvider`, `CommunityModerationProvider`, `ReportModalProvider`, `SidebarDataDisplayProvider`, `PluginDetailsModalProvider`, `UniversalProfileProvider`, `TwitterLoginProvider`, `RoleClaimedProvider`, `EmailConfirmationProvider`, `CommunityJoinedProvider`, `CommunityOnboardingProvider`, `CaptchaContextProvider`, `UserOnchainProvider`, `PluginIframeProvider` (innermost), which renders `UserInfoManager`, `ConnectionStatusIndicator`, and `RoutedContent`.

#### Core Infrastructure Providers

| Provider | Purpose |
|---|---|
| `ConnectionProvider` | Exposes WebSocket state, login state, service worker state, online state, visibility state, and `showReleaseNotes`. Wraps the singleton `ConnectionManager` from `src/data/appstate/connection.ts`. Outermost provider (in `index.tsx`). |
| `DarkModeProvider` | Dark/light mode toggle. Persists preference to localStorage via `useLocalStorage`. Values: `'auto'`, `'light'`, `'dark'`. Wraps `Inner` in `App()`. |
| `WindowSizeProvider` | Exposes `isMobile` and `isTablet` booleans based on viewport width. Used to select layout (Desktop/Tablet/Mobile). |
| `IsolationModeProvider` | Manages COOP/COEP cross-origin isolation mode. |
| `GlobalDictionaryProvider` | Provides i18n dictionary. Wraps `App` in `index.tsx`. |

#### User and Auth Providers

| Provider | Purpose |
|---|---|
| `OwnDataProvider` | Provides the logged-in user's data (`ownUser`), own communities list, own wallets, and chats. Uses `useLiveQuery` from Dexie to reactively read from IndexedDB. Also provides `navigateToChatOrCreateNewChat`. Exposes `useOwnUser`. |
| `UserDataProvider` | Not a Context provider mounted in the tree -- provides user data via hooks (`useUserData`, `useMultipleUserData`). Uses `useLiveQuery` with an in-memory `userCacheMap` for fast lookups. Located in `src/context/UserDataProvider.tsx`. |
| `UserOnboardingProvider` | Manages new user onboarding wizard state. |
| `UserSettingsProvider` | User-level settings state. |
| `UserOnchainProvider` | User's on-chain (blockchain) data. |
| `PasskeyProvider` | WebAuthn passkey authentication state. |
| `LoginWithKeyphraseProvider` | Mnemonic/keyphrase login flow state. |
| `EmailConfirmationProvider` | Email confirmation flow state. |
| `TwitterLoginProvider` | Twitter OAuth login flow state. |

#### Community Providers

| Provider | Purpose |
|---|---|
| `CommunityProvider` | Central community state. Provides the currently viewed community's detail data, areas, channels, roles, calls, own roles, and computed permissions. State is `'loading'` \| `'loaded'` \| `'no-community'`. Exposes `useLoadedCommunityContext` / `useSafeCommunityContext` and `setCommunityIdOrUrl`. Uses `useLiveQuery` for reactive Dexie queries. |
| `CommunityChannelIdProvider` | Resolves and provides the currently selected channel ID within a community. |
| `CommunityListViewProvider` | Community list/grid view preferences. |
| `CommunityModerationProvider` | Moderation actions and state (ban, mute, etc.). |
| `CommunityOnboardingProvider` | Community join onboarding flow state. |
| `CommunityJoinedProvider` | Post-join celebration/modal state. |
| `CommunityPluginProvider` | Plugin data for the currently viewed plugin within a community. |
| `CommunitySidebarProvider` | Sidebar (community view) shared state. |

#### Communication Providers

| Provider | Purpose |
|---|---|
| `CallProvider` | Voice/video call state. Manages `RoomClient` (MediaSoup wrapper), call reducer state (peers, consumers, producers), join/leave/mute actions. |
| `CallDevicesProvider` | Audio/video device selection for calls. |
| `NotificationProvider` | Notification state and unread counts. |

#### UI State Providers

| Provider | Purpose |
|---|---|
| `SnackbarContextProvider` | Global snackbar/toast notifications (`useSnackbarContext`). |
| `CopiedToClipboardDialogProvider` | "Copied to clipboard" confirmation popup. |
| `ExternalModalProvider` | Generic external modal state. |
| `CreateCommunityModalProvider` | Create community modal state. |
| `PluginDetailsModalProvider` | Plugin details modal state. |
| `ReportModalProvider` | Content reporting modal. Exposes `useReportModalContext().showReportModal({ type, targetId })`; renders a `ScreenAwareModal` with reason picker + optional details and submits via `reportApi.createReport`. Supported `ReportType`s: `PLUGIN`, `USER`, `COMMUNITY`, `ARTICLE`, `MESSAGE`. Triggered from `Message`'s `MessageTooltip` (messages) and `GenericArticle` (articles), among others. |
| `SidebarDataDisplayProvider` | Sidebar display mode state. |
| `MobileLayoutProvider` | Mobile-specific layout state (`MobileContext`). |
| `CaptchaContextProvider` | CAPTCHA challenge state. |
| `RoleClaimedProvider` | Role claimed celebration modal state. |

#### Profile Provider

| Provider | Purpose |
|---|---|
| `ProfileProvider` | Provides user profile state for `/u/:idOrUrl` routes. Resolves the URL param to user data via `useUserData`. State is `'loading'` \| `'loaded'` \| `'no-user'`. Includes `isSelf` boolean. Wraps `ProfileRouter` in `App.tsx`. |

#### Blockchain and Wallet Providers

| Provider | Purpose |
|---|---|
| `UniversalProfileProvider` | LUKSO Universal Profile integration. |

#### Generic Data Provider

| Provider | Purpose |
|---|---|
| `GenericDataProvider` | A reusable generic provider (`src/context/GenericDataProvider.tsx`) that wraps `useLiveQuery` with a `ViewCountManager` for reference-counted data retrieval. Components register/unregister "views" for IDs, and the provider batches Dexie queries for only the currently-visible IDs. |

#### Third-Party Integrations

| Provider | Purpose |
|---|---|
| `PluginIframeProvider` | Manages plugin iframe communication. Renders `IframePluginPortal` and `AddPermissionModal` globally. Uses `useIframePlugin` hook for message handling. |

### Custom Hooks (`src/hooks/`)

| Hook | Purpose |
|---|---|
| `useLocalStorage` | Persistent state backed by `localStorage`. Supports cross-tab synchronization via `StorageEvent` and same-tab synchronization via a `changeListeners` map. Returns `[value, setValue]` like `useState`. |
| `useAsyncMemo` | Like `useMemo` but for async computations. |
| `useOnScreen` | Detects if an element is visible in the viewport via `IntersectionObserver`. |
| `usePremiumTier` | Returns the current user's premium tier (`'free'`, `'silver'`, `'gold'`). Also exports `useUserPremiumTier` (for arbitrary users) and `useCommunityPremiumTier` (for communities with tiers `'BASIC'`, `'PRO'`, `'ENTERPRISE'`). |
| `useSentinelLoadMore` | Infinite scroll helper. Uses `IntersectionObserver` on a sentinel element to trigger `loadMore` callbacks. |
| `useSignedUrl` | Resolves signed URLs for protected assets. |
| `useTwitterAuth` | Twitter OAuth flow helper. |
| `useUserAgent` | Parses user agent for device/browser detection. |

### Dexie Local Database (`src/data/databases/`)

The app uses **Dexie.js** (a wrapper around IndexedDB) for persistent, reactive local storage. All database classes extend `AbstractDatabase` (`src/data/databases/abstractDatabase.ts`).

#### AbstractDatabase Base Class

`AbstractDatabase<T, V>` provides:
- A Dexie instance with tables defined by generic type `T`.
- Database name prefixed with `config.IDB_PREFIX`.
- Registration with `dbTracker` for lifecycle management and cleanup of old databases.
- A **debounced batch retrieval** system (`scheduleRetrieval` / `retrieveMissing`): when the UI requests data for IDs not yet in the local DB, requests are batched (200ms debounce) and fetched from the API in a single call. This prevents N+1 request patterns.
- Abstract methods: `setUpDb`, `setUpHandlers`, `onConnectionLoss`, `onConnectionRestored`, `retrieveMissing`.

#### Database Instances

All databases are aggregated in `src/data/index.ts`:

```typescript
const data = {
  community: communityDB,    // CommunityDatabase
  notification: notificationDB, // NotificationDatabase
  message: messageDB,         // MessageDatabase
  user: userDB,               // UserDatabase
  signedUrls: signedUrlsDB,   // SignedUrlsDatabase
  chats: chatsDB,             // ChatsDatabase
  channelManager: channelDatabaseManager, // ChannelDatabaseManager
};
```

| Database | File | Tables | Purpose |
|---|---|---|---|
| `CommunityDatabase` | `community.ts` | `communities`, `areas`, `channels`, `roles`, `calls`, `communityListViews`, `communityMembers`, `status` | Stores community detail views, areas, channels, roles, calls, and member data. Handles retrieval by ID and URL. Manages staleness checks (120s TTL). |
| `UserDatabase` | `user.ts` | `userData`, `status` | Stores user profile data. Batch-retrieves missing user data by ID. |
| `MessageDatabase` | `messages.ts` | `messages`, `chunks` | Stores messages in chunks for pagination. Supports loading messages before/after a given message. |
| `ChannelDatabaseManager` | `channel.ts` | (dynamic per channel) | Manages per-channel `ChunkedItemDatabase` instances. Handles real-time message events, last-read tracking, and cross-tab synchronization via `BroadcastChannel('channelDatabaseManager_events')`. |
| `ChunkedItemDatabase` | `channel/chunkedDatabase.ts` | `items`, `chunks`, `status` | Generic chunked list database used for channel messages. Items are stored in chunks (size 10-40, target 30) with start/end timestamps. Supports efficient range queries, chunk merging, and gap detection. Coordinates via `BroadcastChannel('chunkedDatabase-<dbName>')`. |
| `ChatsDatabase` | `chats.ts` | Chat conversations and last messages. |
| `NotificationDatabase` | `notification.ts` | Notification storage and unread counts. |
| `SignedUrlsDatabase` | `signedUrls.ts` | Cache for signed asset URLs. |
| `UniqueDatabase` | `unique.ts` | Key-value store for singleton data (`OwnData`, `CommunityDetailViewUpdateTimestamps`, etc.). |

#### dbTracker (`src/data/databases/dbTracker.ts`)

Tracks all registered IndexedDB databases, their creation time, and app version. Provides `deleteOldIndexedDbs()` for cleanup of stale databases (runs 10s after the tab becomes active).

#### Reactivity

Dexie databases are made reactive in React via `useLiveQuery` from `dexie-react-hooks`. Context providers (especially `OwnDataProvider` and `CommunityProvider`) use `useLiveQuery` to subscribe to database changes, making the UI automatically update when data changes in IndexedDB.

---

## 4. Data Layer

### API Connectors (`src/data/api/`)

All API communication goes through connector classes that extend `BaseApiConnector`.

#### BaseApiConnector (`baseConnector.ts`)

- Constructs a base URL from `urlConfig.API_URL` + a domain path (e.g., `Community`, `Message`, `Staking`, `Bot`).
- Provides a generic `ajax<T>(method, uri, data?)` method using `XMLHttpRequest`.
- All requests use `withCredentials: true` (cookie-based auth).
- Sends/receives JSON by default; supports `ArrayBuffer` for binary uploads.
- Response format: `{ status: "OK", data: T }` or `{ status: "ERROR", error: string }`.
- On `LOGIN_REQUIRED` error, automatically triggers `loginManager.loginRequiredErrorHandler()` and retries the request once.

#### Domain-Specific Connectors

| Connector | File | Domain | Key Methods |
|---|---|---|---|
| `communityApi` | `community.ts` | Community | `getCommunityList`, `getCommunityDetailView`, `joinCommunity`, `leaveCommunity`, `createCommunity`, `updateCommunity`, CRUD for areas/channels/roles, article CRUD, event CRUD, call management, newsletter management, token management |
| `messageApi` | `messages.ts` | Messages | `createMessage`, `editMessage`, `deleteMessage`, `loadMessages`, `loadUpdates`, `setReaction`, `unsetReaction`, `setChannelLastRead`, `getUrlPreview` |
| `userApi` | `user.ts` | User | Login, logout, user CRUD, wallet operations, profile management |
| `chatApi` | `chat.ts` | Chat/DM | `startChat`, `closeChat`, `getChats` |
| `fileApi` | `file.ts` | Files | File upload, signed URL generation |
| `notificationsApi` | `notifications.ts` | Notifications | Notification retrieval, read status, web push subscription |
| `searchApi` | `search.ts` | Search | Global search |
| `contractApi` | `contract.ts` | Smart Contracts | Contract interaction, token operations |
| `stakingApi` | `staking.ts` | Staking | `getConfig` (staking parameters / contract addresses), `getPositions` (the user's stakes + accrued Spark) |
| `botApi` | `bot.ts` | Bots | `listBots`, `listCommunityBots`, `listInstallableUserBots`, `createBot`, `updateBot`, `disableBot`, `installBot`, `removeBot`, `setBotRoles`, `setAllowUserBots`, `issueToken`, `listTokens`, `revokeToken` |
| `accountsApi` | `accounts.ts` | Accounts | Account management |
| `pluginsApi` | `plugins.ts` | Plugins | Plugin CRUD, marketplace |
| `reportApi` | `report.ts` | Reports | `createReport` (content reporting) |
| `luksoApi` | `lukso.ts` | LUKSO | LUKSO blockchain operations |
| `twitterApi` | `twitter.ts` | Twitter | Twitter OAuth operations |
| `cgidApi` | `cgid.ts` | CG Identity | Session management (`ensureSession`) |

### App State Managers (`src/data/appstate/`)

These are singleton classes that manage non-UI application state. They are NOT React components -- they run independently and notify the UI via listener callbacks.

#### ConnectionManager (`connection.ts`)

The central state coordinator. Manages:
- **WebSocket state**: `disconnected` | `connecting` | `connected` | `version-update`
- **Login state**: `pending` | `anonymous` | `loggingin` | `loggedin` | `loggingout`
- **Service worker state**: `pending` | `none` | `installing` | `installed` | `update-available` | etc.
- **Visibility state**: mirrors `document.visibilityState`
- **Online state**: `online` | `offline`
- **Tab state**: `active` | `active-throttled` | `passive` | `passive-throttled` | `unknown`

Provides a typed listener system (`addListener` / `removeListener`) and a client event handler system (`registerClientEventHandler` / `unregisterClientEventHandler`) for real-time server events.

Key behaviors:
- On WebSocket connect: triggers auto-login or login status check.
- On `version-update`: triggers service worker update.
- On disconnect: emits `cliConnectionLost` event.
- Runs IndexedDB cleanup 10s after tab becomes active.

#### WebSocketManager (`webSocket.ts`)

Manages the Socket.IO connection:
- Uses `socket.io-client` with polling + websocket transports (websocket only in dev).
- **Multi-tab coordination**: tabs report their state (including document visibility) over `BroadcastChannel('CG_WEBSOCKET_STATE')` and the service worker acts as referee, assigning exactly one tab the active-socket role (see §8). Only the active tab maintains the live connection; passive tabs receive state via broadcasts.
- Tab states: `active`, `active-throttled`, `passive`, `passive-throttled`, `unknown`, `tabClosed`.
- Handles `buildId` events for version detection and forced updates.
- Socket authentication: emits `getSignableSecret`, signs with device keypair, emits `login`.
- Ping/pong for disconnect detection.
- All server events prefixed with `cli` are forwarded to `ConnectionManager.eventHandler`.

#### LoginManager (`login.ts`)

Manages authentication:
- Stores current user (`userId`, `deviceId`) in `localStorage`.
- Uses WebCrypto API for device keypair generation and signing (ECDSA P-384).
- Supports multiple login methods: device keypair, password, wallet (SIWE), Twitter, LUKSO, Farcaster, passkey, email verification code.
- `autoLogin()`: attempts login with stored device keypair or legacy mnemonic.
- `setupAfterLogin()`: initializes all Dexie databases with login response data.
- `logout()`: clears all databases, removes device keypair, resets state.
- Cross-tab login coordination via `BroadcastChannel('CG_LOGIN_STATE')`.

#### ServiceWorkerManager (`serviceWorker.ts`)

Manages service worker lifecycle: registration, updates, installation, and communication. Handles push notification setup and participates in the multi-tab active-socket handoff (see §8).

### Data Managers (`src/data/managers/`)

Thin wrapper classes that coordinate between API connectors and databases.

| Manager | File | Purpose |
|---|---|---|
| `CommunityManager` | `communityManager.ts` | Wraps `communityApi.getCommunityDetailView` with Dexie promise integration. |
| `CommunityArticleManager` | `communityArticleManager.ts` | Community article operations. |
| `UserArticleManager` | `userArticleManager.ts` | User blog/article operations. |

### Data Utilities (`src/data/util/`)

| Utility | File | Purpose |
|---|---|---|
| `urls` | `urls.ts` | API URL and WebSocket URL configuration. Reads the runtime instance config (§9) to resolve URLs for self-hosted instances. |
| `device` | `device.ts` | Device keypair management (generate, save, load, delete, sign) using WebCrypto and IndexedDB. |
| `appversion` | `appversion.ts` | App version comparison utilities. |

---

## 5. Routing

### Entry Point (`src/index.tsx`)

The app bootstraps in `window.onload`:
1. Async-imports React, ReactDOM, `ConnectionProvider`, and config.
2. Lazy-loads `SuspenseRouter`, `GlobalDictionaryProvider`, and `App` with preloading.
3. Renders a `Wrapper` component inside `ConnectionProvider`.
4. `Wrapper` waits for preloads to complete, then renders `Router > GlobalDictionaryProvider > App`.
5. Includes an `ErrorBoundary` that shows an error screen on crash.
6. In production (non-dev), wraps in `StrictMode`. In dev mode, `StrictMode` is intentionally excluded to avoid double-render side effects during development.
7. Shows a loading/splash screen (HTML elements manipulated directly) until React finishes loading.

### SuspenseRouter (`src/components/SuspenseRouter/SuspenseRouter.tsx`)

A custom `BrowserRouter` replacement that wraps navigation state updates in `startTransition()` for concurrent rendering. It:
- Creates a `BrowserHistory` instance.
- Listens to history changes and updates state inside `startTransition`.
- Shows a "You have unsaved changes" confirmation when `isDirty` is true.
- Tracks page views in Matomo analytics.
- Exposes `useNavigationContext()` with `isDirty`, `setDirty`, `setUpdateOnNavigate`.

### Top-Level Routes (`src/App.tsx` - `RoutedContent`)

The `RoutedContent` component defines all top-level routes inside a responsive layout wrapper:

- **Layout selection**: Based on `isMobile` / `isTablet` from `WindowSizeProvider`, wraps routes in `MobileLayout`, `TabletLayout`, or `DesktopLayout`.
- **Routes outside layout**: `TwitterCallbackView` (`/twitter-login`) and `VerifyEmailView` (`/verify-email`) render without the main layout.

Key route structure (paths are derived from `getUrl(...)` / `config.URL_*`):
```
/token-sale                   -> TokenSaleRedirect
/token/                       -> TokenSale
/e/*                          -> redirect to / (legacy ecosystem URLs; nginx's SPA fallback
                                 only matches one segment, so /e/x/y 404s before React)
/feed/                        -> ContentBrowser
/c/:communityUrl/*            -> CommunityRouter
/u/:idOrUrl/*                 -> ProfileProvider > ProfileRouter
/chats/:chatShortUuid/        -> ChatView
/notifications/               -> NotificationsBrowser
/notifications/:notificationShortUuid/ -> NotificationsBrowser
/learn-more                   -> LearnMore
/settings/profile/            -> ProfileManagementView
/settings/account-and-wallets/ -> WalletManagementView
/settings/calls/              -> AudioDevicesManagementView
/create-user-post             -> CreateUserPostView
/enable-cross-origin-security -> IsolationModeToggle (enable)
/disable-cross-origin-security -> IsolationModeToggle (disable)
/ (or *)                      -> Home
```

### CommunityRouter (`src/views/CommunityRouter/CommunityRouter.tsx`)

Handles all routes under `/c/:communityUrl/`. On mount, it sets the community ID/URL in `CommunityProvider` via `setCommunityIdOrUrl`. It shows a spinner while the community is loading.

Once loaded, it wraps content in `MemberListProvider` and shows `CommunityViewSidebar` (on non-mobile). Nested routes:

```
settings/                     -> CommunitySettingsView
settings/info/                -> CommunityManagementView
settings/areas-and-channels/  -> AreaChannelManagementView
settings/members/             -> MemberManagementView
settings/manage-bans/         -> BanManagementView
settings/roles/               -> RoleManagementView
settings/upgrades/            -> SafeAndUpgradesView
settings/onboarding/          -> OnboardingManagementView
settings/token/               -> TokenSettingsView
settings/plugins/             -> PluginSettingsView
settings/bots/                -> BotManagementView
create/article/               -> CreateArticleView
roles/                        -> RolesView
members/                      -> MemberManagementView
member-applications/          -> MemberApplicationView
events/                       -> EventsView
token/                        -> CommunityTokenView
call/:callId/                 -> CallPageView
article/:articleUri/          -> ArticleView
article/:articleUri/edit/     -> EditArticleView
event/:eventIdOrUrl/          -> EventView
plugin/:pluginId/             -> CommunityPluginProvider > PluginView
channel/:channelIdOrUrl/*     -> CommunityChannelIdProvider > CommunityView
* (default)                   -> CommunityView (lobby)
```

### ProfileRouter (`src/views/ProfileRouter/ProfileRouter.tsx`)

Handles routes under `/u/:idOrUrl/`. Wrapped in `ProfileProvider` (set up in `App.tsx`). Shows spinner while profile loads. Routes:

```
article/:articleUri/edit  -> EditBlogView
article/:articleUri       -> BlogView
* (default)               -> ProfileView
```

---

## 6. Key Libraries

### Slate.js (Rich Text Editor)

**Used in:** `src/components/organisms/EditField/EditField.tsx`

The `EditField` organism is the primary rich text input for messages and articles. It uses:
- `slate` (core editor model)
- `slate-react` (React bindings: `Slate`, `Editable`, `withReact`)
- `slate-history` (`withHistory` for undo/redo)

Custom features built on Slate:
- **Mentions** (`@user`): Custom `MentionElement` type. Suggestion dropdown (`MentionSuggestion`). Inserted via `insertMention` helper.
- **Link detection**: Automatic URL detection via regex. Custom link element type.
- **Formatted text**: Bold, italic, etc. via `HoveringToolbar` (floating toolbar on text selection).
- **Embeds**: YouTube and other embeds via `FieldEmbed`.
- **Attachments**: Image/file attachments via drag-and-drop (`react-dropzone`), `MediaPickerDropdown`, `AttachmentDropdown`.
- **GIF support**: Giphy integration via `GiphyPicker`.
- **Emoji**: Emoji picker via `EmojiPickerTooltip`.
- **Link previews**: Automatic URL preview generation via `LinkPreview` / `LinkPreviewSkeleton`.
- Helper functions in `EditField.helpers.ts`: `convertToMessageBody`, `clearEditor`, `recalculateNodeTypes`, `findAndSetWordType`, etc.

### Markdown Rendering (`react-markdown`)

**Used in:** `src/components/molecules/MesssageBodyRenderer/`

Chat messages and articles render markdown at **display** time; the composer still stores the structured Slate/message body model, not raw markdown. The renderer (`AllContentRenderer` in `MessageBodyRenderer.tsx`) works in two passes:

1. `groupMarkdownRuns()` splits the stored content into lines and collapses maximal runs of "plain" lines (plain text + bare links, no mentions / parsed tags / tickers / toolbar formatting / media) into synthetic `markdownRun` elements. Lines with structured elements keep the classic element-by-element rendering.
2. Each `markdownRun` is fed through `toMarkdownSource()` (joins lines, converts single chat line breaks into markdown hard breaks, leaving fenced code blocks untouched) and rendered by `MarkdownContent` via `react-markdown`.

`MarkdownContent` customizes the renderer: links go through the internal `SimpleLink` atom, and inline markdown images are not rendered (the `img` element is disallowed and unwrapped to its alt text) — shared images are expected to go through the attachment path instead.

### Socket.IO Client

**Used in:** `src/data/appstate/webSocket.ts`

The `socket.io-client` library provides the real-time WebSocket connection to the server. The `WebSocketManager` class:
- Connects to `urlConfig.WS_URL` with path `/api/ws/`.
- Uses typed events (`API.Server.ClientToServerEvents`, `API.Server.ServerToClientEvents`).
- Emits: `cgPing`, `getSignableSecret`, `login`, `logout`.
- Receives: `buildId`, `connect`, `disconnect`, and all `cli*` events (forwarded to `ConnectionManager`).
- Handles reconnection with a bounded backoff.

### MediaSoup Client (Voice/Video)

**Used in:** `src/util/RoomClient.tsx`, `src/components/organisms/CallPage/`, `src/context/CallProvider.tsx`

MediaSoup is used for WebRTC-based voice and video calls:
- `RoomClient` class wraps MediaSoup client for producing/consuming audio and video streams.
- `CallPage.reducer.ts` manages call state: peers, consumers, producers, spotlight.
- `CallProvider` context exposes: `joinCall`, `startCall`, `leaveCall`, `toggleMute`, `setSpotlight`.
- Supports features: mute/unmute, video on/off, screen sharing, spotlight mode, HD toggle, audio-only mode, stage slots (for larger calls).

### wagmi + RainbowKit (Wallet Connection)

**Used in:** `src/App.tsx`, various wallet-related components

Blockchain wallet integration:
- **wagmi** (v2): Ethereum library for wallet connection, chain management, contract interactions. Its hooks are TanStack Query queries, so a `QueryClientProvider` wraps the tree.
- **RainbowKit** (v2): Pre-built wallet connection modal UI; `getDefaultConfig` builds the wagmi config, connectors included.
- **viem** (v2): the underlying Ethereum client. The frontend has no `ethers` dependency — the few remaining unit conversions use viem's `formatUnits`/`parseUnits`, and the Lukso UP and MetaMask paths talk to the injected EIP-1193 provider directly.
- Configured chains are derived from the active-chain set (`activeChains`), which can be narrowed by the runtime instance config for self-hosted deployments (§9).
- RPC providers: on official instances an Alchemy provider with a public fallback; on self-hosted instances keyless public RPC endpoints (per chain id) with a public fallback.
- Used for: wallet-based login (SIWE), token-gated roles, community tokens, and **staking** (`StakeTab` reads/writes the staking contract via wagmi hooks).

### Farcaster AuthKit

**Used in:** `src/App.tsx`

Farcaster decentralized social protocol integration:
- `AuthKitProvider` with an Optimism RPC endpoint.
- Used for Farcaster-based login.

### recharts (Charts)

**Used in:** `src/views/TokenSale/StakeTab/LockDurationSlider.tsx`

Used to draw the reward-curve preview in the staking UI (`AreaChart` of previewed Spark vs. lock duration, with a reference dot for the selected duration).

### framer-motion (Animations)

Used across the codebase for animations and transitions:
- `AnimatedContainerVertical`: expand/collapse animations.
- `AnimatedTabPage`: page transition animations.
- Various modal enter/exit animations.
- List item animations.

### Other Notable Libraries

| Library | Purpose |
|---|---|
| `dexie` + `dexie-react-hooks` | IndexedDB wrapper + React reactive queries (`useLiveQuery`) |
| `react-markdown` | Markdown rendering for chat messages and articles |
| `recharts` | Charts (staking reward curve) |
| `react-router-dom` + `history` | Client-side routing |
| `dayjs` | Date formatting/manipulation (with plugins: isToday, isYesterday, isTomorrow, advancedFormat, utc, timezone) |
| `lodash` | Utility functions (debounce, isEqual, etc.) |
| `react-dropzone` | Drag-and-drop file upload (`noPaste` is set — `EditField` has its own paste-to-attach handler) |
| `viem` / `ethers` | EVM operations (unit formatting, SIWE signing, mnemonic wallets) |
| `boring-avatars` | Generated default avatars (the `Jdenticon` component's `marble` variant) — there is no `jdenticon` package |
| `emoji-regex` | Large-emoji detection in message rendering |
| `@floating-ui/react` | Positioning + interaction hooks behind `Tooltip`/`Popover`, `UserProfilePopover` and the message hover toolbar |
| `@phosphor-icons/react` / `@heroicons/react` | Icon sets (used e.g. in bot management UIs) |

---

## 7. Responsive Layout System

The app has three layout modes, selected by `WindowSizeProvider`:

| Layout | Component | Menu Style |
|---|---|---|
| Desktop | `DesktopLayout` | `ExpandedMenu` (full sidebar, collapsible on community pages) |
| Tablet | `TabletLayout` | Compact menu |
| Mobile | `MobileLayout` | `MobileMenu` (bottom navigation) + `MobileLayoutProvider` context |

Layout components wrap the route content and provide the navigation menu. On community pages (`/c/...`), the desktop layout collapses the main menu since the `CommunityViewSidebar` takes its place.

---

## 8. Multi-Tab Architecture

The app coordinates behavior across multiple open tabs. A single service worker (`src/service-worker.ts`) acts as the **referee** for which tab owns the live WebSocket connection, which makes the handoff robust across tab open/close, visibility changes, and service-worker restarts.

1. **WebSocket (active-tab election).** Each tab reports its state and document visibility over `BroadcastChannel('CG_WEBSOCKET_STATE')`. The service worker tracks the set of tabs and their states (`active` / `active-throttled` / `passive` / `passive-throttled`, plus a `visible` flag) and elects exactly one active tab:
   - It waits for a full picture (heartbeats from known tabs) before reassigning roles, so a half-informed referee does not promote a second active tab.
   - When no active tab exists, it prefers a **visible** passive tab (visible tabs are never timer-throttled).
   - Collisions between two tabs both claiming the active role are broken deterministically in favor of the visible tab.
   - If the active tab's connection is stuck in `connecting` far beyond normal, the role is handed to a fresh, non-throttled passive tab.
   - Ghost tabs (e.g. banned during an initial service-worker install) are re-registered rather than left stranded.

2. **Login.** The `LoginManager` uses `BroadcastChannel('CG_LOGIN_STATE')` to synchronize login/logout across tabs. Passive tabs can delegate `LOGIN_REQUIRED` errors to the active tab.

3. **Channel data.** The `ChannelDatabaseManager` uses `BroadcastChannel('channelDatabaseManager_events')` (and per-database `chunkedDatabase-<name>` channels) to coordinate channel subscriptions and chunk updates across tabs.

4. **localStorage.** Used for cross-tab state sync (`StorageEvent` listener) for current user, last WebSocket connection time, and various preferences.

---

## 9. Build, Entry Points, and Instance Configuration

### Toolchain

The frontend is built with **Vite 7** (`vite.config.ts`). It replaced
Create React App + craco + webpack; nothing of that stack remains. Vite **7,
not 8**, on purpose: Vite 8 swaps Rollup for Rolldown and esbuild for Oxc —
a bundler swap, not a version bump — and the chunking setup below was measured
and tuned under Rollup 4. Vite 8 is its own later workstream with its own
measurements; the Node floor (≥ 20.19) is the same, so the builder image
(`node:24.18-bookworm`) already covers that jump too.

`build.target` is explicit (`BUILD_TARGET` in `vite.config.ts` — `chrome67,
edge79, firefox68, opera54, safari14`), so Vite 7's new default target
(`'baseline-widely-available'`, ≈ Safari 16.0) never applies. Keeping the floor
at **`safari14`** is deliberate, and a product call rather than a build call:
it is what keeps plain browsing and login working on iOS 14–15, while web push
is gated at iOS ≥ 16.4 anyway (`src/context/NotificationProvider.tsx`;
user-facing copy in `src/components/molecules/PWA/PWA.tsx`). If the floor is
ever raised, two places must move together: `BUILD_TARGET` (esbuild notation)
and the `browserslist.production` key in `package.json` (consumed by
autoprefixer via `postcss.config.js`) — nothing derives the JS target from
browserslist; `vite.config.ts` duplicates the floors by hand.

| Concern | Where |
|---|---|
| Build / dev server | `vite.config.ts`. Multi-page: both HTML shells are rollup inputs and are emitted at the dist root under their own names. Dev server is pinned to host `0.0.0.0`, port **3000** — load-bearing, because `src/data/appstate/serviceWorker.ts` disables SW registration on that origin, which is what keeps dev SW-free. |
| `baseUrl: "src"` imports | `vite/baseUrlResolve.ts`. `tsconfig.json` sets `baseUrl: "src"` and no `paths` map, backing ~1945 bare-specifier import lines (`components/…`, `common/util`, but also file-level ones like `'App'` and `'service-worker'`). The plugin reimplements webpack's precedence: node_modules wins, `src/` is the fallback. |
| SVG components | `vite-plugin-svgr`, behind a `?react` query — `import Icon from './icon.svg?react'`, **default** export. `svgo: false` is load-bearing (svgr's default svgo pass strips `viewBox`). Typed by `src/types/svg-react.d.ts`. |
| Service worker | `vite/serviceWorker.ts` — a nested Vite build plus `workbox-build`'s `injectManifest`; deliberately **not** `vite-plugin-pwa`, because the worker and its registration manager are hand-written. Fails the build if the worker bundle is not a single file or if any emitted JS/CSS chunk is missing from the precache. |
| Entry `<script>` tags | `vite/htmlEntryScripts.ts` — the shells carry no `<script src>`; the config declares which module belongs to which shell. |
| Social preview meta | `vite/absoluteSocialMeta.ts` — makes `og:image`/`twitter:image`/`og:url` absolute when `PUBLIC_URL` is set (only the legacy Azure pipelines set it). |
| Node polyfills | `vite-plugin-node-polyfills`, scoped to `buffer`/`stream`/`assert` + global `Buffer`, for transitive web3 dependencies only. `process` and `global` are deliberately **not** polyfilled: `src/common/` is dual-runtime (the backend consumes it through the `srv/common` symlink) and reads env through a `globalThis` indirection that must keep resolving to nothing in the browser. |
| Dependency aliases | Two exact-match `resolve.alias` entries in `vite.config.ts`, both load-bearing. `altcha-widget-element` → `altcha` loads the widget bundle under a stub module name so its `.d.ts` (which augments `react/jsx-runtime` and would shadow the whole JSX namespace under @types/react 18) never enters the TS program; the stub is `src/types/altcha-widget-element.d.ts`. altcha 3 moved that augmentation out of the default types entry into `altcha/types/react`, so the hazard is narrower now, but the alias is what keeps it out for good. `@metamask/sdk` is pinned to its browser UMD file, because the package declares both `browser` (UMD) and `module` (its **node** ESM build) and Vite's resolver prefers the ESM entry — which drags `fs`/`child_process`/`tls`/… into the browser bundle. Keep the alias when the dependency is upgraded. |
| Chunking | `build.rollupOptions.output.manualChunks` in `vite.config.ts`: nine vendor groups (`vendor-web3`, `vendor-icons`, `vendor-charts`, `vendor-mediasoup`, `vendor-emoji`, `vendor-editor`, `vendor-dnd`, `vendor-react`, `vendor-shared`) split what Vite's default chunking put into one ~5.4 MiB `App` chunk (a Vite 6 measurement; the groups carried over unchanged in the Vite 7 bump — same chunk set, every chunk same-size or marginally smaller). `node_modules` only — `src/` keeps the default behavior, because splitting first-party modules is what turns an import cycle into a TDZ crash. `assertCgidEntryChunks` (same file) fails the build if the CG ID entry ever statically reaches a group other than `vendor-react`/`vendor-shared`. Details and the rules the table follows: [docs/infrastructure](../infrastructure/README.md#frontend-build-steps). Changing it needs a browser pass. |
| Sourcemaps | `build.sourcemap: true` on every build path (the app is AGPL). **JS only** — Vite/Rollup emit no `.css.map`, unlike CRA. The service worker excludes maps from the precache, so they only cost bandwidth when devtools opens them. |
| CSS | `postcss.config.js` (`tailwindcss/nesting` → `tailwindcss` → `autoprefixer`), `tailwind.config.js`. |
| Type-check | `yarn typecheck` — `tsc --noEmit` over `src/**` plus `tsconfig.node.json` over the Vite-side files. TypeScript 5.9 (4.5 could not even *parse* viem's TS-5 `.d.ts` files, which silently disabled semantic checking). `tsconfig.json` targets **es2018**, not es5: TS 5.5+ grammar-checks regex syntax against the target and rejects the `u` flag + `\p{…}` escapes in `src/common/validators.ts`. Nothing emits from this tsconfig — shipped output is transpiled by Vite against `build.target`, which mirrors the `browserslist` floors. |
| Lint | `yarn lint` — `eslint.config.mjs` (ESLint 9 flat config: typescript-eslint + react + react-hooks), calibrated to the severities the old `react-app` preset enforced. Errors fail, warnings do not. |
| Tests | `yarn test` — Vitest (`vitest.config.ts`), one smoke test so far. |

Neither type-check nor lint happens during `vite build`, which is why the docker
build scripts run them as explicit steps — see
[docs/infrastructure](../infrastructure/README.md#frontend-build-steps).

### Entry points

- **Main entry**: `src/index.tsx` -- the primary web app entry point.
- **CG ID entry**: `src/index_cgid.tsx` -- alternative entry point for the CG Identity service.
- **Service Worker**: `src/service-worker.ts` -- handles caching, push notifications, and multi-tab active-socket refereeing (§8).
- **Config**: `src/common/config.ts` -- deployment configuration (dev/staging/prod), feature flags, URLs, chain set.
- **Docker**: `docker/.env` -- environment variables for containerized deployment.

### Runtime Instance Configuration (`src/common/instance.ts`)

Historically the app inferred its deployment mode and URLs from a hardcoded list of official domains; any other domain silently ran with dev semantics. To support self-hosting, an instance now declares who it is at serve time: the server injects a `window.__CG_INSTANCE__` object into `index.html` / `index_cgid.html`, and `src/common/instance.ts` is the single validated accessor for it (`getInstanceConfig()`).

Recognized fields include:

| Field | Purpose |
|---|---|
| `deployment` | Semantic mode (`prod` / `staging` / `dev`) — drives feature flags, chains, captcha |
| `appUrl` | Public base URL of the instance |
| `cgidUrl` | Base URL of the CG ID app (including hash-router prefix) |
| `recaptchaSiteKey` | reCAPTCHA v2 site key for this instance |
| `activeChains` | Chains the instance supports (keys of the available-chain set) |
| `features` | Capability flags (`email`, `twitterAuth`, `calls`) derived from which server secrets/services are configured; an absent flag means the feature is available. `calls: false` (no mediasoup service) hides the call section in `CallList` / `StartCallButton` and the call-typed event paths in `ScheduleEventModal` / `AttendEventButton` |
| `giphyApiKey` | Giphy key for the GIF picker (empty disables it) |
| `walletConnectProjectId` | WalletConnect Cloud project id for this instance |

When the global is absent (official app and local dev), callers fall back to the legacy domain-based detection, so those environments are unaffected. `config.ts`, `data/util/urls.ts`, and `App.tsx` read this config to select URLs, the active chain set, wallet RPC providers, and captcha keys.

### Client-Side Wallet Keys

Wallet-related client keys (RPC provider key, WalletConnect project id, Farcaster RPC URL) are baked into the client bundle by design — they are public, origin-scoped keys used from the browser. Self-hosted instances override them through the instance config above rather than sharing the official-instance defaults, which also makes rotation a configuration change rather than a code change.

# Common Ground Frontend Documentation

> Status: verified against commit 7224927 plus the local-data recovery and mobile
> account-scrolling working-tree changes, 2026-11-08; other sections verified
> against commit 4a9754f8f, 2026-08-04; ConnectionManager,
> WebSocketManager, LoginManager cross-tab behaviour, `ConnectionStatusIndicator`, the
> `x-cg-socket-id` header and §8 items 1–2 (independent tabs) against commit 964f6b3,
> 2026-11-02; `data/index.ts`, the database table, "Chat runtime and
> `data.channelManager`", the read-state paragraph and §8 item 3 against commit
> 50d27f2 (chat-sync/wiring) and its review fixes, 2026-11-02; NSFW pre-check
> section against the fix/image-filter-review-53 branch, 2026-08-15; wallet,
> motion, drag & drop and toolchain notes plus "Dependency pins and
> constraints" against commit 935232158, 2026-10-31; dev env file pointer
> against commit 64e5ab573 (chore/env-template), 2026-10-31; builder image
> (Node 26) against commit 5f73578, 2026-10-31; "Dependency pins and
> constraints" verified against commit ff0da06, 2026-10-31; session keepalive,
> the `passkeyRpId` / `features.passkeys` instance fields, `cgidUrl`, the auth
> UI (AuthFlow, `/login`, passkeys, step-up, plugin origin guard, §10) and the
> dnd-kit strategy/transform/trailing-click/ordering notes against commit
> 54e2d73, 2026-10-31; the TypeScript 6 / joi 18 notes (type-check row,
> project-relative imports, "Dependency pins and constraints") against commit
> d604544, 2026-10-31; the `/e/*` route note against commit fe3937f, 2026-10-31;
> the `cuer` resolution and the WalletConnect QR note against commit 816d046,
> 2026-11-01;
> transfer links, the account-security step, the email confirmation flows and
> `/verify-email` (§10) against commit 9fc05a9, 2026-11-01; limit messages, "send
> again" countdowns, the form checks and the 8-digit codes (§10 "Limits and input
> checks") against commit 2fad7d3, 2026-11-01; "Sign out other devices", the signed-out
> notice and the password snackbar (§10 "Other devices") against commit 23a4c1e, 2026-11-01;
> Vite 8 / Rolldown (§9 "Toolchain", "Dependency pins and constraints", wave M3)
> against commit 3e8b08e, 2026-11-01; react-router 7 (§5 SuspenseRouter, top-level
> routes, "Routing on react-router 7", the dependency table and pins, wave M3)
> against commit 3e8b08e, 2026-11-01; "Service worker and module scripts" (§9) against commit
> 3e8b08e, 2026-11-01; Tailwind CSS 4 (§9 "Styling: Tailwind CSS 4", the CSS row, the
> build-target paragraph, "Dependency pins and constraints", wave M4) against commit
> 440c779, 2026-11-02; inline background images (§9) against commit 591e6cf, 2026-11-02;
> the service worker's part in multi-tab coordination (§4 WebSocketManager and
> ServiceWorkerManager, §8, §9 entry points) against commit 79187d2, 2026-11-02;
> "Writers of the shared entity databases" (§ Dexie) against commit 212bbce, 2026-11-02;
> `signedOutElsewhere()` during the own logout against commit f97ef1b, 2026-11-02;
> `data.notification`, `NotificationProvider` and `NotificationsBrowser` (unread count,
> list, marking read) against commit f9f6327, 2026-11-02; the message/comment lists on
> chat-sync windows (`GenericMessageList`, `CommentList`, `Message`, `ArticleCommentSection`,
> `useChannelReadMarking`) against commit caf7b67, 2026-11-03; the data layer after the
> chat-sync removal (database table, `dbTracker` and the obsolete-database cleanup, "Chat
> runtime and `data.channelManager`", "Chat stores", ConnectionManager,
> §8) against commit 1e6a0d4, 2026-11-03; why memory + server and the open
> persistence item ("Chat stores", chat-sync close-out) against commit 3567377, 2026-11-03; `Message`'s
> `data-send-status` against commit dea7c6a, 2026-11-03; the logout across tabs
> (`CG_LOGOUT_IN_PROGRESS`, the signed-out re-check), the session take-over's channel
> access, the deferred DM re-init and `WINDOW_ERROR.NO_ACCESS` against commit 9d00729, 2026-11-03; `SendStatusNotice` and
> `GenericMessageList`'s failed-jump level against commit c5f74d3, 2026-11-03; the socket's
> drop of a signed-out device (`deviceSignedOut`) and the device check of a late sign-out
> against commits 1b9948c and d386911, 2026-11-03; the predefined-role helpers (`src/util/predefinedRoles.ts`)
> against commits 138c630 and 8bb443a, 2026-11-03;
> the gateway page (`GatewayView`, `gatewayTargetUrl`, `AuthFlow allowSignup`, §10) and the Farcaster
> SIWE domain against commit 696102b, 2026-11-06; the gateway page's untouched old page data
> (entity databases never opened, no clearing, no obsolete-database cleanup) and its
> continuation only after a sign-in in the same tab (`signedInInThisTab`) against commit 696102b,
> 2026-11-07;
> the scroll-down helper level of `GenericMessageList` and `Scrollable`'s position report and
> `autoScroll` against commit a67ef53, 2026-11-07; the composer's send block during image uploads
> (`isAttachmentBusy`) against commit 63e944a, 2026-11-07; the replacement service worker of a gateway
> ("Service worker on a gateway", the entry-point note) against commit 050245d, 2026-11-07;
> the transfer page's account identifier and "This isn't me" against commit 04c72b2, 2026-11-07;
> the step-up dialog's methods (`reauthMethods`) against commit 53aba9b, 2026-11-08;
> Home footer destinations against f5981cb plus working changes, 2026-11-08
> Migration roadmap references closed out against commit 5d0df48, 2026-11-08.
> Passkey migration setup and email reauthentication verified against 556a989
> plus working changes and regression tests, 2026-11-08.

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
| `Message` | Single chat message display (text, attachments, reactions). Its `MessageTooltip` sub-component hosts the per-message actions incl. the **Report** action. Re-renders on every change of the message object (edits, reactions, `sendStatus`); a pending own send is faded and offers no tooltip actions or swipe-to-reply while `sendStatus` is `sending` / `error-send`, a failed send or edit shows Retry and Discard / Undo edit (`retrySend` / `discardPending` of the channel store) through `SendStatusNotice`. Every item carries `data-timestamp` (scroll anchoring); `data-send-status` (the `sendStatus` value) is set only while a send or edit is in flight or failed, so an item without it shows the stored server version (the e2e suite relies on it). |
| `MesssageBodyRenderer` | Renders message/article body content into React elements. Note the triple-`s` directory name. See §6 for the markdown pipeline. Exports `MessageBodyRenderer`, `AllContentRenderer`, and (in `MarkdownContent.tsx`) `MarkdownContent` + `toMarkdownSource`. |
| `CommentMessage` | Article/post comment display; a failed comment shows `SendStatusNotice` |
| `SendStatusNotice` | Notice of a failed own send or edit (`sendStatus` `error-send` / `error-update`) with Retry and Discard / Undo edit, for `Message` (through `MessageBodyRenderer`) and `CommentMessage`. A polite `role="status"` region (a remounted failed item does not interrupt again); the buttons' accessible names start with the visible label and quote a message excerpt, and they are described by the notice text. Discard moves focus to the composer of the same list (`.generic-message-list` / `.comment-list`), or to the list itself on touch devices and without a composer, when the button had focus. |
| `CommentList` | List of comments: one chat-sync window (`chat.channels.openWindow`), newest first, "load more" via `loadOlder`; failed comments offer Retry/Discard. `ArticleCommentSection` joins the article event room while the transport is live and again on every `onLive`; the room is ref-counted per access (`articleEventRooms.ts`), so it is left only when the last section of that article unmounts. |
| `Dialog` | Confirmation/action dialog |
| `Dropdown` | Dropdown menu |
| `EmojiPickerTooltip` | Emoji picker in a tooltip popover |
| `LinkPreview` | URL preview card (OG metadata); `LinkPreviewLoader` fetches previews for internal links |
| `MediaAttachment` | Image/video/file attachment display |
| `GiphyAttachment` | Giphy GIF attachment |
| `UserProfilePhoto` | User avatar with optional status indicator |
| `UserProfileV2` | Compact user profile card |
| `UsernameWithVerifiedIcon` | Username with optional verification badge |
| `ConnectionStatusIndicator` | Shows websocket/network connection status banner. "Connected" means live (socket logged in, rooms joined). Right after a (re)load the socket starts out disconnected until the tab is live; "Disconnected" is held back for the first 10 s (unless the tab had been live already), so a slow first connect is no outage banner. "Connecting"/"Disconnected" appear only after 3 s and only while the page is visible (a hidden tab closes its socket on purpose); an account in the security step shows no connection problem. The state logic is the pure `indicatorState.ts` (tested) |
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
| `Scrollable` | Custom scrollbar wrapper (used extensively). `positionCallback` gets the content's real scroll position, read after a scroll lock is applied (a lock's target outside the scroll range is clamped by the browser), and is not called once the `Scrollable` has unmounted. With `autoScroll` (the message list), a change of the content or viewport height since the last recompute keeps a list that was at the bottom there, whichever event (ResizeObserver, mutation, scroll, mouse) runs the recompute, unless the user scrolled up in the same recompute (`shouldStickToBottom`, `scrollPosition.ts`). |
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
| `GenericMessageList` | Reusable message list container. Opens one chat-sync `ChannelWindow` per channel and inits it once its list is mounted (`recent`, or `atItemId` for a focus target; `jumpToLatest` after a send or the scroll-down helper while detached). The window listener sets the `Scrollable` lock from `WindowChange.kind` before rendering (`scrollAnchoring.ts`): older/newer pages and trims at the top lock by the visible item's `data-timestamp`, an own send or a live message while at the bottom scrolls to the bottom, a jump scrolls to its target, a catch-up reset keeps the position. A change that adds items below without scrolling to them (a page appended below, a reset that keeps the position or goes to an element) clears the list's at-bottom level until the `Scrollable` reports its position again, so new items are never marked read unseen. A jump to a message outside the window (`scrollToMessage`) clears it as well; when the jump does not apply (not found, network) the previous level is restored and a position report requested, so read marking does not pause. Read marking via `useChannelReadMarking` (no IntersectionObserver). The scroll-down helper (`.scroll-helper`, in the composer area) shows while the list is more than 30 px from the bottom (`SCROLL_BOTTOM_THRESHOLD`, also the list `Scrollable`'s `topAndBottomThreshold`, so stick-to-bottom, the helper and read marking agree), the inverse of the at-bottom level; its level is kept in `scrollHelper.ts` and applied through a callback ref to every helper node that mounts, because the composer area re-mounts independently of the list (e.g. the join button replaced by the composer after joining). Reply parents and pinned messages use `watchMessage` (no window needed). |
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
| `UserOnboarding` | Onboarding modal: `AuthFlow` (step `start`), then the tail steps in `Splash` ("Welcome back" after a login; newsletter, push, PWA install, finished after a sign-up). Opened by every login / sign-up entry point via `setUserOnboardingVisibility(true)`. See §10. |
| `AuthFlow` | Login and sign-up (§10): one login form, sign-up with email verification before the account exists. Rendered by `UserOnboarding` and `LoginView`. |
| `ReauthDialog` | "Confirm it's you to {action}" step-up dialog (passkey, password, sign-in wallet, verified email code), hosted by `StepUpProvider` (§10). |
| `UserSettingsModalContent/PasskeySettings` | The account's passkeys on this instance: name, created, last used, synced; rename, remove, add (§10). |
| `UserSettingsModalContent/AccountsPage/SignOutOtherDevices` | "Sign out other devices" at the end of Settings → Accounts: confirm dialog → step-up → `User/signOutOtherDevices`, then "Signed out N other devices." (§10). |
| `SignedOutNotice` | "You were signed out" dialog after this device was signed out from elsewhere ("Sign in" / "Not now"), mounted next to `ConnectionStatusIndicator` (§10). |
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

Home's privacy, terms and help links point to the official community articles on
`https://cg.box` (`src/views/Home/Home.tsx`). Their contents remain community
articles; configurable per-instance legal pages are still deferred.

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
| `NotificationsBrowser` | `/notifications/`, `/notifications/:notificationShortUuid/` | Notification list (optionally focused on one notification): one `data.notification.openList()` window, first page once `loginState` is `loggedin`, older pages via `loadOlder`; one `markAsRead` per click or selection (the selection marks an id once; a click on an unread item always marks, so it retries after a failure); a "Mark all read" button (`markAllAsRead`) while the count is > 0; spinner until the first page is there, then the empty state |

### Auth and Verification

| View | Route | Purpose |
|---|---|---|
| `LoginView` | `/login` (`?mode=signup`, `?next=<same-site path>`) | The login / sign-up flow (`AuthFlow`) as a page (rendered outside main layout); after a sign-up the onboarding modal continues with its tail steps |
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

The `Inner()` stack (outer → inner) is, in order: `IsolationModeProvider`, `WagmiProvider`, `QueryClientProvider` (TanStack Query, required by wagmi 2), `RainbowKitProvider`, `AuthKitProvider` (Farcaster), `WindowSizeProvider`, `SnackbarContextProvider`, `OwnDataProvider`, `PasskeyProvider`, `StepUpProvider`, `MobileLayoutProvider`, `NotificationProvider`, `CommunitySidebarProvider`, `ExternalModalProvider`, `UserOnboardingProvider`, `CreateCommunityModalProvider`, `LoginWithKeyphraseProvider`, `CopiedToClipboardDialogProvider`, `CallDevicesProvider`, `CallProvider`, `CommunityProvider`, `CommunityListViewProvider`, `UserSettingsProvider`, `CommunityModerationProvider`, `ReportModalProvider`, `SidebarDataDisplayProvider`, `PluginDetailsModalProvider`, `UniversalProfileProvider`, `TwitterLoginProvider`, `RoleClaimedProvider`, `EmailConfirmationProvider`, `CommunityJoinedProvider`, `CommunityOnboardingProvider`, `CaptchaContextProvider`, `UserOnchainProvider`, `PluginIframeProvider` (innermost), which renders `UserInfoManager`, `ConnectionStatusIndicator`, and `RoutedContent`.

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
| `UserOnboardingProvider` | Onboarding modal state: visibility, step (`start` = AuthFlow, then the tail steps), newsletter state; `continueAfterSignup(email)` opens the tail steps after a sign-up on `/login`. |
| `UserSettingsProvider` | User-level settings state. |
| `UserOnchainProvider` | User's on-chain (blockchain) data. |
| `PasskeyProvider` | Passkeys for the UI (§10): `supported`, `autofillSupported`, `status`, `register`, `login`, `armAutofill`, `reauthenticate`; actions resolve to `ok` / `cancelled` / `error`. On a legacy CG ID instance it wraps `LegacyCgIdPasskeyProvider` (`LegacyCgIdPasskey.tsx`, the CG ID popup) and only `login` works. |
| `StepUpProvider` | Hosts `ReauthDialog`; registers it with `stepUpManager` (used by `BaseApiConnector` on `REAUTH_REQUIRED`) and offers `useStepUp().ensureRecentAuth(action)` for screens that must confirm before a ceremony of their own. |
| `LoginWithKeyphraseProvider` | 12-word recovery phrase input state (legacy CG ID instances only, AuthFlow "More"). |
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
| `NotificationProvider` | Push subscription / PWA state and the unread notification count (subscribed via `data.notification.subscribeUnreadCount`, always a number). |

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
| `useChannelReadMarking` | Level-triggered read marking of a mounted message window: reports `{atLatest, atBottom, newest server item}` to a `chat.readState` marker on every change; the store marks the channel read while a marker has all three, the tab is visible and logged in. None for call chats and article comments. |
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
  notification: notificationDB, // façade over chat.notifications (NotificationStore)
  user: userDB,               // UserDatabase
  signedUrls: signedUrlsDB,   // SignedUrlsDatabase
  chats: chatsDB,             // ChatsDatabase
  channelManager,             // façade over the chat stores (channel.ts)
};
```

| Database | File | Tables | Purpose |
|---|---|---|---|
| `CommunityDatabase` | `community.ts` | `communities`, `areas`, `channels`, `roles`, `calls`, `communityListViews`, `communityMembers`, `status` | Stores community detail views, areas, channels, roles, calls, and member data. Handles retrieval by ID and URL. Manages staleness checks (120s TTL). |
| `UserDatabase` | `user.ts` | `userData`, `status` | Stores user profile data. Batch-retrieves missing user data by ID. |
| `channelManager` (`data.channelManager`) | `channel.ts` | none (memory) | Façade over the tab's chat stores, see "Chat runtime and `data.channelManager`" below. |
| `ChatsDatabase` | `chats.ts` | Chat conversations and last messages. |
| `data.notification` | `notification.ts` | none (no Dexie) | Thin façade over the tab's `NotificationStore` (`chat.notifications`, `src/data/chat/notificationStore.ts`): memory + server only. The unread count is always a number and comes from the server only (login value, `unreadCount` of `cliNotificationEvent`, `getUnreadCount` after a resync or a mark-read), `subscribeUnreadCount` is multi-subscriber; `openList()` gives an item window (`init`, `loadOlder`, `destroy`) on one list kept in memory while no window is open (live events still apply; after a resync without an open window the next `init` reloads the newest page); `markAsRead` is a no-op for read or in-flight items; `setupAfterLogin(count)` is synchronous; `clear()` on logout. |
| `SignedUrlsDatabase` | `signedUrls.ts` | Cache for signed asset URLs. |
| `UniqueDatabase` | `unique.ts` | Key-value store for singleton data (`OwnData`, `CommunityDetailViewUpdateTimestamps`, etc.). |

#### dbTracker (`src/data/databases/dbTracker.ts`)

Tracks all registered IndexedDB databases, their creation time, and app version, in `localStorage` (`CG_KNOWN_INDEXEDDBS`, synced between tabs by the `storage` event). `knownDatabaseNames()` lists them; `forgetDatabase(name)` drops a deleted one.

#### Obsolete databases (`src/data/databases/obsoleteDatabases.ts`)

Messages and notifications are not stored in IndexedDB (memory + server, see "Chat stores"). The databases of the removed client caches are deleted on startup: `commonGroundDB_chunked_databases` (the chunked message/notification cache), every other `commonGroundDB_chunked_*` (per-name databases of older builds) and `commonGroundDB_messages` (an older message cache). `connectionManager` runs `deleteObsoleteDatabases()` once per page, 10 s after startup (`OBSOLETE_DATABASE_CLEANUP_DELAY_MS`), in every tab (deleting is idempotent), fire-and-forget: names come from the fixed list, `dbTracker` and `indexedDB.databases()` where supported; the call never rejects and only logs failures; a `blocked` delete (a page of an older build still has the database open) is not waited for — the browser finishes it once that page closes the database; a request that reports nothing within 10 s is left to the browser. Deleted names are dropped from `dbTracker`. No data is migrated: the server is the source of truth.

#### Writers of the shared entity databases

The `communities`, `chat` and `users` databases are shared by all tabs of an origin, and any tab may apply the same socket event, possibly late (a throttled or frozen tab catches up). Their writers are therefore idempotent and order-safe:

- **Entity events** (`cliCommunityEvent update`, area/role/channel/call events, `cliUserData`, `cliUserOwnData`) are skipped when the stored row has a newer `updatedAt` (`guardedPut` / `guardedUpdate` in `abstractDatabase.ts`, one rw transaction each); payloads without `updatedAt` apply as before. `cliPluginEvent new` upserts by plugin id.
- **Server snapshots** (login data, detail-view fetches, `startChat`): areas, roles, channels and calls with an older `updatedAt` than the stored row do not replace it (their stamps come from the database). Communities and list views are not guarded this way and stay authoritative, because some community events are stamped with the API process clock rather than the row's `updatedAt`. Snapshots do not delete rows (chats, channels, areas, roles, calls) that an event wrote after the snapshot's request started: event writers stamp rows with a client-clock `localWrittenAt`, and callers may pass `requestStartedAt` (default: 60 s before the merge).
- **Accepted narrow window**: a partial event skipped as older loses the fields only it carries (there are no per-field stamps), and an API-clock stamp ahead of the database clock can make a newer database-stamped event look older. Both last until the next snapshot of that community (detail-view refresh or login).
- **Community URL change**: on every event that carries a `url`, each tab compares the URL in its own path with the URLs it has seen for that community (not with the shared row, which another tab may already have updated) and navigates to the URL the row holds now, unless another stored community holds the URL in its path now (a URL a renamed community gave up can be taken over). This also holds for a tab that replays an older URL change late.
- **Read state** (`unread`, `lastRead`, `lastMessageDate` of community channels and DMs) is only written through `mergeReadState` (`src/data/chat/mergeReadState.ts`) inside the writer's transaction (`readStateRows.ts`): `lastRead` and `lastMessageDate` only move forward, a snapshot's `unread` is taken only if it knows at least the local `lastRead`, and a live message is counted once per `syncSeq` (older servers: only if newer than every message seen). The rows carry extra non-indexed fields: `readSeq`, `readCounted` and `serverLastRead`; DM rows also `lastMessageDate`. `serverLastRead` is the highest `lastRead` the server is known to hold (from snapshots, server answers with a count, and own messages); it is kept on the rows and passed to `registerAccessForChannel`, but the send decision is the in-memory `ReadStateStore`'s (the only sender of `setChannelLastRead`), from its own server-acknowledged value. After every merge (page load, login, `getOwnCommunities`/`getChats`, community/chat events, `startChat`) `community.ts`/`chats.ts` hand the merged rows' read state to that store (`data.channelManager.applyStoredReadState` → `ReadStateStore.applyStored`: memory only, with the rows' `readSeq`/`readCounted` so a message counted in the row is not counted again, and never treated as server-acknowledged), so a snapshot is applied to the rows once and mirrored in memory. The schema versions are unchanged (no `versionchange` for open tabs of an older build). `readStatePersistence.ts` exposes this as the `ReadStatePersistence` of the chat-sync contract.

#### Chat runtime and `data.channelManager`

`src/data/chat/runtime.ts` builds the tab's three chat-sync stores once (contract `src/data/chat/types.ts`): `chat.channels` (`ChannelStore`: messages in memory, ref-counted windows, sends/edits with `sendStatus`), `chat.readState` (`ReadStateStore`: read state plus level-triggered marking, persisted through `readStatePersistence.ts`) and `chat.notifications` (`NotificationStore`). Their `chat.events` (`ChatEventSource`) is made of the `cliMessageEvent`/`cliChannelLastRead`/`cliNotificationEvent` handlers (`connectionManager.registerClientEventHandler`), `webSocketManager` `live`/`onLive`/`onResume`, `connectionManager` visibility, and the account `login.ts` sets via `data.channelManager.userId`, which counts as the stores' user only while the login state is `loggedin` (own messages are classified by the account, also while the login settles). The runtime starts when `channel.ts` loads, before the socket connects. The socket usually goes live before the login settles (page load, interactive login); stores do not catch up without a user, so when the user becomes known while the socket is live the event source fires `onLive('user')` (the read-state store's own user-change trigger is debounced into the same `getSyncState`; while the socket is not live it waits for the next `onLive`, so each login costs one `getSyncState`). Notification counts are not fetched without a user.

- **Login hook-up** (`login.ts`): `setupChatAfterLogin(count)` with the login response's notification count (also for a login adopted from another tab); `clearChat()` on a logout in another tab; the tab's own logout clears through `data.channelManager.clear()`. Clearing empties all three stores, reports `undefined` to message watchers (then refetches them) and re-inits the channel windows that had been initialised (`init({ type: 'recent' })`) — DM windows only once a user is logged in again (their requests need a login); channel access stays registered. A login superseded by another tab's login or logout also clears. A login taken over from another tab registers the access and read state of the stored chat and channel rows (`chatDatabase.registerStoredChats`, `communityDatabase.registerStoredChannels`); channels and DMs `getSyncState` reports without a known access are registered from its `chatId`/`communityId` as well. A window whose channel access stays unknown rejects its `init` with `WINDOW_ERROR.NO_ACCESS` after 30 s (`ACCESS_WAIT_MS`); the store re-inits it by itself (the usual `reset`) once the access is registered. The take-over does not wait for the row registration.
- **DMs**: a received or own DM message is written to the chat row by `chatDatabase.newMessageReceived` (read state plus `lastMessage`, one transaction); the store's persistence skips message inputs of DMs, so each input reaches the row once. Article comments and call chats have no read state.
- **Edits** are sent without image metadata (`imageData`/`largeImageData`), as the message validators accept only the ids; the shown overlay keeps it.
- **`data.channelManager`** passes through to the stores: `registerAccessForChannel`, `getAccessForChannel`, `openWindow`, `watchMessage`, `createMarker`, `createMessage` (resolves once the pending item is shown, never rejects), `retrySend`, `discardPending`, `editMessage`, `deleteMessage`, `setReaction`, `unsetReaction`, `deleteChannelDatabase` (= `forgetChannel`), `clear`. The list components use the stores directly (`chat.channels.openWindow`, `chat.channels.watchMessage`, `chat.readState.createMarker`).

#### Chat stores (`src/data/chat/`)

Contract and normative rules: the doc comments in `src/data/chat/types.ts` (summary in `src/data/chat/README.md`); transport contract `src/data/appstate/transport.ts`. The store cores are pure TypeScript with injected API, event source and clock, unit-tested in vitest against a scripted fake server (`src/data/chat/testing/fakeServer.ts`). The server is the source of truth for messages, read state and unread counts; everything in the stores is per tab and may be dropped at any time.

Why memory + server (2026-11, chat-sync): the stores replace a chunked message/notification cache in IndexedDB (`ChunkedItemDatabase`) that tabs kept in sync over BroadcastChannel and Web Locks. Its cross-tab chunk protocol caused the worst defects — one missed broadcast left inconsistent chunk links and a channel empty for good, an empty "complete" server page arriving after a live message deleted that message, a list stopped following new messages after a reconnect, stale snapshots overwrote newer local state — and repairing it in place was judged riskier than replacing it. A cache that may be dropped at any time and a server-side catch-up cursor make all of these impossible by construction instead of by coordination.

- **Messages (`ChannelStore`).** Per channel: a contiguous "latest" segment (at most `LATEST_SEGMENT_MAX` = 200 server messages, live-updated), detached segments created by jumps (merged when they meet the latest one), pending sends, edit overlays, tombstones, and a loose map for reply parents and pinned messages (`watchMessage` works without a window). A channel stays in memory while it has an open window, a watcher or a pending/failed send; at most `CHANNEL_LRU_SIZE` = 20 others are cached (LRU). Memory only — after a reload the history needs a round trip. (A latest-N snapshot per channel in IndexedDB would be a pure add-on — one writer per transaction, LRU, whole-store wipe on logout, a cache-schema constant — and is not built; it is an open item in `docs/todo/TODO.md`, to be decided on the reload timings of the e2e flow `cs-login-time`.)
- **Windows** are ref-counted, any number per channel, and keep the `Models.ItemList.ItemListState` shape. Listeners get `(state, change)` synchronously, `change.kind` ∈ `reset` (cause `init`/`jump`/`latest`/`resync`) | `prepend` | `append-page` | `append-live` | `update` | `trim`, so the list sets its scroll lock before rendering.
- **Version rule** (every source: pages, `getChanges`, live events, HTTP responses): a full message replaces the stored one when its `syncSeq` is `>=`, a partial update applies only when `>`; a version with `syncSeq` beats one without unless the one without has a strictly newer `updatedAt`; tombstones are terminal. A page (`loadMessages`, `messagesById`) is authoritative only for its own range and never removes items, so a snapshot cannot delete a newer live message.
- **Sending:** the pending item is inserted synchronously before the API call (`sendStatus: 'sending'`); failure or 20 s without answer → `error-send`, shown with Retry/Discard; a retry reuses the client UUID (the server's `createMessage` is idempotent on it). An edit is an overlay until its response is applied; success clears `sendStatus`, failure → `error-update`.
- **Read state (`ReadStateStore`)** for community channels and DMs (call chats and article comments have none): every input goes through `mergeReadState` — `lastRead` and `lastMessageDate` are max-merged, a snapshot's `unread` is taken only if its `lastRead` is at least the local one, and an unread count for a channel without an open window starts from the `getSyncState` snapshot at seq S and counts a live `new` event (not own, newer than `lastRead`) only if its `syncSeq` is above S (counted seqs are kept, so several tabs applying the same event count it once). Marking read is level-triggered: while a window is at the latest segment, scrolled to the bottom, the document visible and the user logged in, the store marks up to the `createdAt` of the newest server message received (`useChannelReadMarking` → `createMarker(...).update({atLatest, atBottom, newest})`); re-evaluated on every change of these inputs, deferred until login, retried with a backoff (2/5/15/60 s), the first call immediate then a 1 s trailing throttle. It is the only sender of `setChannelLastRead`.
- **Notifications (`NotificationStore`):** memory + server; the first page when the list opens and again on resync while it is open; live `new`/`update`/`delete`/`allread` applied idempotently. The unread count comes from the server only (login response, `unreadCount` of each event, `getUnreadCount({ withTime: true })` on resync and after marking; the newest `unreadCountAt` wins); there is no client-side `++`/`--`.
- **Catch-up.** On `onLive` (socket login ack after a connect or reconnect, or a user change on a live socket) and `onResume` (the socket stayed live but the tab was away: visible again after ≥ 30 s hidden, `pageshow` from bfcache, `resume`, `online`), each store resyncs, debounced (50 ms): the read-state store calls `getSyncState` (all readable channels and DMs, plus the notification count), the channel store calls `getChanges` from each open window's cursor (`"1:<seenSeq>"`, the contiguous applied high-water mark of `syncSeq`s; following `hasMore`), the notification store refetches its count and open list. Live events that arrive meanwhile are applied too. A cached channel without a window catches up when a window opens again. A live event whose `syncSeq` leaves a gap that is still open after 1.5 s triggers a `getChanges` for that channel (some seq bumps have no event, so false gaps are possible and cheap). A null or too-old cursor gets `reset: true` with the latest page: the latest segment is replaced, keeping local items with a higher `syncSeq` and pending sends; windows whose slice is off the new segment re-init (`reset`, cause `resync`). Catch-up never plays sounds or shows alerts.
- **Entity data** (communities, chats, own user) has no sync cursor: after a `restored` live the login manager refreshes its snapshot (§4 ConnectionManager), and the Dexie writers are monotonic (see "Writers of the shared entity databases").
- **Old server** (a short window during a deploy): a 404 on `getChanges` falls back to a `loadMessages` reconcile, a 404 on `getSyncState` to the login/`getOwnCommunities`/`getChats` snapshots, for the rest of the page load; `setChannelLastRead`'s optional `messageId` is sent only once the server has shown chat-sync support and dropped after a validation error.
- **Logout:** `chat.channels.clear()`, `chat.readState.clear()` and `chat.notifications.clear()` (via `clearChat()`), then initialised windows re-init (DM windows at the next login). A `LOGIN_REQUIRED` while the tab logs out does not start a login.

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
- Sends `x-cg-socket-id` (`SOCKET_ID_HEADER`) on every request: the tab's connected socket id, else a random per-tab id in the same format (`src/data/appstate/requestSocketId.ts`), read per request.
- On `LOGIN_REQUIRED` error, automatically triggers `loginManager.loginRequiredErrorHandler()` and retries the request once.
- On `REAUTH_REQUIRED` (a sensitive action, docs/auth-identity §8), asks `stepUpManager` (`src/data/auth/stepUp.ts`) to open the "Confirm it's you" dialog and retries the request once after a confirmation; when cancelled (or no dialog is mounted) the call rejects with `REAUTH_REQUIRED`. Concurrent requests share one dialog. Pinned by `baseConnector.test.ts`.

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
| `passkeyApi` | `passkey.ts` | Passkey | `registrationOptions`, `verifyRegistration`, `authenticationOptions`, `list`, `rename`, `remove` (main-origin passkeys; not mounted on a legacy CG ID backend) |
| `cgidApi` | `cgid.ts` | CG Identity | Legacy CG ID app calls (served only by a legacy CG ID / gateway backend); the session keepalive is `userApi.ensureSession()` (`User/ensureSession`) |

### App State Managers (`src/data/appstate/`)

These are singleton classes that manage non-UI application state. They are NOT React components -- they run independently and notify the UI via listener callbacks.

#### ConnectionManager (`connection.ts`)

The central state coordinator. Manages:
- **WebSocket state**: `disconnected` | `connecting` | `connected` (`connected` only while the tab is live: socket logged in, rooms joined; a newer build on the server is `updateAvailable`, not a socket state)
- **Update available**: `updateAvailable` (+ `updateAvailableChange` listener) — a newer build is deployed
- **Login state**: `pending` | `anonymous` | `loggingin` | `loggedin` | `loggingout`
- **Service worker state**: `pending` | `none` | `installing` | `installed` | `update-available` | etc.
- **Visibility state**: mirrors `document.visibilityState`
- **Online state**: `online` | `offline`

Provides a typed listener system (`addListener` / `removeListener`) and a client event handler system (`registerClientEventHandler` / `unregisterClientEventHandler`) for real-time server events.

Key behaviors:
- Starts the `WebSocketManager` once the login manager is loaded; on the first socket connect of the page it runs `loginManager.autoLogin()` (the HTTP device login, once per page load).
- Emits `cliConnectionEstablished` / `cliConnectionRestored` when the tab becomes live (`onLive` `established` / `restored`), not on the raw socket connect. After `restored` a visible tab calls `loginManager.refreshAfterReconnect()` (random 1–3 s debounce; a hidden tab does it when it becomes visible): it re-runs the device `User/login` for its snapshot (own communities, chats, own data, unread count) under the login lock without a login-state change, and passes `requestStartedAt` to the community/chat snapshot merges.
- On `updateAvailable`: triggers the service worker update.
- On `disconnected`: emits `cliConnectionLost`.
- On becoming visible or online: `loginManager.checkLoginStatus()`.
- Deletes the IndexedDB databases of removed caches 10 s after the page load, fire-and-forget (in every tab; see "Obsolete databases" in §3).

#### WebSocketManager (`webSocket.ts`)

Manages this tab's Socket.IO connection and implements `Transport` (`src/data/appstate/transport.ts`, the contract for the data layer):
- Uses `socket.io-client` with polling + websocket transports (websocket only in dev).
- **One socket per tab**, no tab roles (see §8). `live`, `onLive(kind)`, `onLiveChange`, `onResume(reason)`, `updateAvailable`/`onUpdateAvailable`, `holdSocket('call')`, `getRequestSocketId()`. Details: [docs/realtime](../realtime/README.md#socketio-client).
- Hidden-tab policy: closes the socket after 5 min hidden (not while a hold is active), at once on `freeze`/`pagehide`; reconnects on visible, `pageshow` (persisted), `resume`, `online`.
- Socket authentication: emits `getSignableSecret`, signs with device keypair, emits `login`; `login(deviceId)` resolves on the `"OK"` ack (20 s ack timeout, retries with a randomised backoff, a new connection only after two timeouts in a row). A reconnect logs the socket in again; no HTTP login.
- Handles `buildId` events: a different build sets `updateAvailable`; the socket keeps working.
- Ping/pong for disconnect detection.
- All server events prefixed with `cli` are forwarded to `ConnectionManager.eventHandler`.

#### LoginManager (`login.ts`)

Manages authentication:
- Stores current user (`userId`, `deviceId`) in `localStorage`.
- Uses WebCrypto API for device keypair generation and signing (ECDSA P-384).
- Supports multiple login methods: device keypair, password, wallet (SIWE), Twitter, LUKSO, Farcaster, passkey (`{ account: 'passkey', authenticationResponse }` → `User/login {type:'passkey'}`; `{ account: 'passkey-legacy' }` → `passkey-success` on a legacy CG ID instance), email verification code.
- An interactive login and `createUser` mark the session as freshly authenticated for `stepUpManager`; a device-key re-login, `logout()` and a logout in another tab clear it.
- `autoLogin()`: attempts login with the stored device keypair; the deprecated mnemonic re-login (`CRYPTOGRAM_USER_MNEMONIC`) only runs on a legacy CG ID instance — elsewhere the stored phrase is removed.
- `setupAfterLogin()`: merges user, community and chat snapshots and checks every result before marking the login successful. A failed merge preserves existing cache data; it does not clear and retry a still-running operation. Each database retains its actual in-flight promise until settlement.
- `localData` tracks local login/logout work and device-key transactions. After 30 seconds, or a storage failure, `LocalDataRecovery` covers the app with a Reload action. The current attempt rejects; further attempts in this page do not start competing writers. Reload preserves website data and starts a fresh page. A late completion does not dismiss recovery or mark the failed login successful.
- Update-triggered reloads wait for the whole login/transfer/logout and all tracked local work, including operations whose UI wait timed out. They do not force a reload on a short timer. A user can explicitly reload from the recovery screen if a storage operation never settles.
- Device-key writes resolve on transaction completion, not on the individual put request. Connections close after success or failure and on `versionchange`. Optional push registration runs separately from successful local login setup.
- `logout()`: clears all databases, removes device keypair, resets state, then broadcasts the logout.
- Every tab has its own login state. HTTP logins (device, interactive, `createUser`, transfer link) run under the Web Lock `cg:login` (wait at most 15 s); a device login holds it for secret, signature and request (one signable secret per session). After 10 s (`LOGIN_LOCK_HOLD_MAX_MS`) the lock is released for the other tabs, but the holder keeps waiting for its own request; it only starts no further step (signature, request) without the lock — it queues again once. A device login answered `INVALID_SECRET` (a late secret request of another tab replaced the secret) is repeated once under the lock with a fresh secret. Inside the lock a tab compares the stored current user with the device it is about to log in and follows the stored user if they differ. A page device login that fails with anything but `NOT_FOUND` or a local-data recovery error is retried with a backoff (5/15/60 s, ±50 %) and on the next visibility/online check (never sooner than 5 s after the failure); `User/logout` also runs under the lock. A tab that had to wait for the lock and then finds the session logged in as the stored user takes it over instead of a second login. Logins and logouts are broadcast on `BroadcastChannel('cg:auth')` (`authBroadcast.ts`), with the `storage` event on `CG_CURRENT_USER` (and a re-check when the tab becomes visible) as fallback: another tab's logout drops this tab's login without a second `User/logout`; another tab's login is taken over after `User/checkLoginStatus` (no HTTP login); another user's login counts as a logout first. A logout also posts `'anonymous'` on the legacy `CG_LOGIN_STATE` channel for one release (older pages still open); nothing listens there.
- `loginRequiredErrorHandler()` (any tab): under the login lock re-checks the session with `User/checkLoginStatus`; only if it is not this tab's user any more it runs `autoLogin()`.

#### ServiceWorkerManager (`serviceWorker.ts`)

Manages service worker lifecycle: registration, updates, installation, and communication (`reload` after a new worker activates, `navigate` from a notification click, `channelVisited` to close a channel's push notifications). Handles push notification setup. It takes no part in tab roles.

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

A custom `BrowserRouter` replacement that wraps navigation state updates in `startTransition()` for concurrent rendering. It renders react-router's low-level `<Router>` (declarative mode: no data router, no loaders/actions/fetchers, no framework mode or file-based routing) with a `history` v5 `BrowserHistory` as its `navigator`. It:
- Creates a `BrowserHistory` instance (`history` package — react-router has not depended on it since 6.x; it is a direct dependency for this file only).
- Listens to history changes and updates state inside `startTransition`.
- Shows a "You have unsaved changes" confirmation when `isDirty` is true.
- Tracks page views in Matomo analytics.
- Exposes `useNavigationContext()` with `isDirty`, `setDirty`, `setUpdateOnNavigate`.

### Top-Level Routes (`src/App.tsx` - `RoutedContent`)

The `RoutedContent` component defines all top-level routes inside a responsive layout wrapper:

- **Layout selection**: Based on `isMobile` / `isTablet` from `WindowSizeProvider`, wraps routes in `MobileLayout`, `TabletLayout`, or `DesktopLayout`.
- **Routes outside layout**: `TwitterCallbackView` (`/twitter-login`), `VerifyEmailView` (`/verify-email`) and `LoginView` (`/login`) render without the main layout.

Key route structure (paths are derived from `getUrl(...)` / `config.URL_*`):
```
/token/                       -> TokenSale
/e/*                          -> redirect to / (legacy ecosystem URLs; the edge's shell rule
                                 only matches one segment, so /e/x/y 404s before React)
/feed/                        -> ContentBrowser
/c/:communityUrl/*            -> CommunityRouter
/u/:idOrUrl/*                 -> ProfileProvider > ProfileRouter
/chats/:chatShortUuid/        -> ChatView
/notifications/               -> NotificationsBrowser
/notifications/:notificationShortUuid/ -> NotificationsBrowser
/learn-more                   -> LearnMore
/profile/settings/            -> ProfileManagementView
/profile/settings/account-and-wallets/ -> WalletManagementView
/profile/settings/calls/      -> AudioDevicesManagementView
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

### Routing on react-router 7

The app runs **react-router 7** (7.18.4, wave M3, 2026-11-01; before that
`react-router-dom` 6.30) in **declarative mode**: `<Routes>`/`<Route>` elements,
nested `<Routes>` below splat routes (`/c/:communityUrl/*`, `/u/:idOrUrl/*`,
`settings/*`, `channel/:channelIdOrUrl/*`), `useNavigate`/`useLocation`/
`useParams`/`useSearchParams`, `<Navigate>` and one `<NavLink>`. There is no data
router (`createBrowserRouter`/`RouterProvider`), no loaders, actions, fetchers or
`<Form>`, no framework mode and no `@react-router/dev`. All imports name
`react-router`; `react-router-dom` is not installed.

The v6 future flags, none of which the app ever set, and what v7 changed:

| Flag | Effect here |
|---|---|
| `v7_relativeSplatPath` | Relative paths inside splat routes now resolve against the full URL including the splat. **No effect**: every navigation target is absolute (`getUrl(...)`, `isLocalUrl()`, `safeNextPath()`, `/…` literals) or search-only (`navigate({ search })`, `setSearchParams`, the `?modal=` routes), which resolve against the current location in both versions; the only other forms are `navigate(-1)`. Checked by grep over `navigate(`, `<Navigate to>`, `<NavLink to>` (no `<Link>`, `useHref`, `useResolvedPath` or `.`/`..` paths exist). |
| `v7_startTransition` | `BrowserRouter`/`HashRouter`/`MemoryRouter` now wrap their state updates in `React.startTransition`. The main app does not use them: `SuspenseRouter` has always done that itself, around a plain `<Router>`, so nothing changes there. The CG ID mini-app's `HashRouter` (`src/index_cgid.tsx`) now navigates in a transition; its three routes have no lazy parts. |
| `v7_fetcherPersist`, `v7_normalizeFormMethod`, `v7_partialHydration`, `v7_skipActionErrorRevalidation` | Data-router/SSR only — not applicable. |

Also not applicable: the removed `json`/`defer` helpers, `RouterProvider`'s
`fallbackElement`, and the `react-router-dom` → `react-router/dom` split
(`RouterProvider`/`HydratedRouter` only). `useNavigate()` now returns
`void | Promise<void>`; no caller uses the return value. react-router 7 is
one 39 KiB chunk in the build; the CG ID entry's static closure grew from 901
to 916 KiB with it (the main shell loads the router lazily with `App`).

Verified on 2026-11-01 with the e2e suite and a dedicated navigation smoke
(deep links into every top-level and nested route on a fresh page load, signed
in and anonymous; back/forward through community → channel → article →
profile → settings; the 404 and `/e/*` routes; the auth routes; links between
the nested community routes; opening, closing and re-opening a `?modal=`
route): 63 of 67 checks pass, and the same smoke against a1460cb (react-router
6.30, Vite 7) fails the same three pre-existing ones (`/store/`, the roles page,
a non-existent profile article — see `docs/todo/TODO.md`). The fourth was an
occasional start-up failure on fresh loads, which came from the Vite 8 step
(not from the router) and is fixed in the service worker (§9 "Service worker
and module scripts").

---

## 6. Key Libraries

### Slate.js (Rich Text Editor)

**Used in:** `src/components/organisms/EditField/EditField.tsx`

The `EditField` organism is the primary rich text input for messages and articles. It uses:
- `slate` (core editor model)
- `slate-dom` (the DOM layer slate-react ≥0.111 split out and peer-requires —
  a required direct dependency, and part of the `vendor-editor` chunk group)
- `slate-react` (React bindings: `Slate`, `Editable`, `withReact`)
- `slate-history` (`withHistory` for undo/redo)

Custom features built on Slate:
- **Mentions** (`@user`): Custom `MentionElement` type. Suggestion dropdown (`MentionSuggestion`). Inserted via `insertMention` helper.
- **Link detection**: Automatic URL detection via regex. Custom link element type.
- **Formatted text**: Bold, italic, etc. via `HoveringToolbar` (floating toolbar on text selection).
- **Embeds**: YouTube and other embeds via `FieldEmbed`.
- **Attachments**: Image/file attachments via drag-and-drop (`react-dropzone`), `MediaPickerDropdown`, `AttachmentDropdown`.
- **GIF support**: Giphy integration via `GiphyPicker`. GIFs load straight from Giphy's CDN and are never stored server-side, so the NSFW gate cannot see them; `gf.search()`/`gf.trending()` therefore request `rating: 'g'` explicitly instead of relying on the API default.
- **Emoji**: Emoji picker via `EmojiPickerTooltip`.
- **Link previews**: Automatic URL preview generation via `LinkPreview` / `LinkPreviewSkeleton`.
- Helper functions in `EditField.helpers.ts`: `convertToMessageBody`, `clearEditor`, `recalculateNodeTypes`, `findAndSetWordType`, etc.

### NSFW Pre-Upload Check (`nsfwjs` + trimmed TensorFlow.js)

The client-side half of the image filter (the server-side gate in
`srv/moderation/imageFilter.ts` is the authority — see
[docs/backend](../backend/README.md#srvmoderationimagefilterts--nsfw-image-gate)).
A courtesy check that warns **before** upload; it never blocks.

- **Entry point:** `src/moderation/checkImageBeforeUpload.ts` — called by every
  path where a `File` enters upload state: the four picker molecules
  (`ImageUploadField`, `HeaderImageUpload`, `CommunityLogoUpload`,
  `ProfilePhotoField`), the four inline `<input type=file>` components
  (`UserProfileInner`, `UserProfileV2`, `RolePhoto`, `UserProfilePhoto`),
  the two EditField funnels `addFiles` / `addImageMedia` (covering file
  picker, drag & drop and paste for chat attachments and Slate inline
  images), and the `FieldMediaImage` "Replace" input. Chat attachments render
  immediately in a `precheckPending` state — the upload starts only once the
  check clears; declined files are removed. The send button stays blocked
  ("Uploading…") until the upload and the loading of the uploaded image are
  done (`isAttachmentBusy`, `EditField/attachmentState.ts`); a failed upload
  shows its error, stops blocking and is left out of the sent message.
  The confirm dialog renders into its own portal node above every modal
  layer (nested-modal safe; see the rationale in
  `SuspiciousImageModalProvider.tsx`).
- **Gating:** returns immediately when `config.IMAGE_FILTER_ENABLED` is false
  (instance config `features.imageFilter`) or the file is not a raster image —
  before any code is fetched. The classifier itself
  (`src/moderation/imagePrecheck.ts`) is only ever reached via dynamic
  `import()` and lives in its own lazy chunk; the model
  (MobileNetV2Mid graph model, ~4.4 MB, self-hosted under
  `public/models/nsfw/` — see the README there for pins/sha256s/licensing) is
  fetched on first use. Nothing here may be added to `VENDOR_GROUPS`.
- **Runtime:** trimmed tfjs (`tfjs-core` + `tfjs-converter` +
  `tfjs-backend-webgl`, CPU backend as a lazily imported fallback chunk). The
  `@tensorflow/tfjs` meta package is not installed; a vite `resolve.alias`
  maps it to the re-export stub `src/moderation/tfjs.ts` for `nsfwjs/core`.
- **Verdict → UX:** the `Porn` and `Hentai` probabilities are **summed** and
  compared against this instance's own `IMAGE_MODERATION_THRESHOLD`, shipped
  to the browser as `imageFilterThreshold` (default `0.8`) — the same
  aggregation and the same knob the server uses, so tightening the server
  threshold moves the browser warning with it. The two models still differ
  (MobileNetV2 here, ViT server-side), so verdicts can diverge; the
  aggregation no longer does. `Sexy`/`Drawing`/`Neutral` are ignored
  entirely. Every internal failure resolves `'ok'` (never break an upload),
  and a failed model load is retried on the next file rather than
  remembered — one flaky fetch used to disable warnings for the whole page
  session. A suspicious verdict opens
  the queue-based confirm dialog hosted by
  `src/context/SuspiciousImageModalProvider.tsx` (module-level bridge in
  `src/moderation/suspiciousImageDialog.ts`, same imperative pattern as
  `ReportModalProvider`); "Upload anyway" always proceeds.
- **Server rejections:** `FileApiConnector.uploadImage` throws
  `Error('IMAGE_CONTENT_REJECTED')` on the filter's `{status:'ERROR'}` reply.
  Every callsite runs `notifyIfImageRejected()`
  (`src/moderation/imageUploadError.ts`), which shows one shared
  rejection-notice dialog hosted by the same provider as the pre-upload
  confirm (queued, never stacked; repeated rejections coalesce). Chat
  attachments additionally remove the rejected tile from the composer;
  generic (non-rejection) upload errors keep each site's local handling.
  `imageUploadErrorText()` additionally maps the two *transient* refusals —
  `RATE_LIMIT_EXCEEDED` from the upload route's rate limit and
  `SERVICE_UNAVAILABLE` from the classifier shedding load — to one
  "try again shortly" message (`isUploadTemporarilyRefused()` exposes the same
  test for callsites that build their own text), so those wire enums do not
  reach a snackbar verbatim. Sites that only ever show a generic
  "unknown error" (`RolePhoto`, `UserProfilePhoto`) keep it; they have no text
  channel worth differentiating.

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
- **The wallet list is spelled out** in `getDefaultConfig({ wallets })` (injected, Safe, Rainbow, Coinbase, MetaMask, Rabby, Brave, WalletConnect — the set RainbowKit 1 offered plus Rabby and Brave). RainbowKit 2's default set differs (it drops Coinbase Wallet for Base Account and the generic injected entry). The connect modal only lists wallets that have an entry here — an extension missing from the list does not show up as its own option.
- **The WalletConnect QR code** ("Scan with your phone" in the connect modal) is drawn by RainbowKit through `cuer` → `qr`; RainbowKit's own `cuer` pin is overridden to 0.0.4 because 0.0.3 crashes against current `qr` — see "Dependency pins and constraints" below.
- **The Lukso UP login signs through the raw EIP-1193 provider on purpose.** `UniversalProfileProvider` signs the SIWE message with `eth_sign`; viem's `signMessage` would send `personal_sign` instead, which that verification path rejects. Do not "modernise" it onto viem's wallet client. `signatureHelper` also talks to `window.ethereum` directly (its `eth_signTypedData_v4` method `metamaskSignData` is dead code, see `docs/todo/TODO.md`; `getFractalSignature` uses `personal_sign`).
- **Transaction receipts:** viem 2 defaults `waitForTransactionReceipt` to a 180 s timeout (viem 1 waited forever), so every receipt wait (`UserOnchainProvider`, `StakeTab`, `PaySpark`) passes an explicit 30-minute timeout. Raw viem calls resolve reverted transactions instead of throwing, so `UserOnchainProvider` (and `StakeTab`) check `receipt.status`; wagmi's `useWaitForTransactionReceipt` throws on a revert, which is what `PaySpark`'s `isSuccess` relies on.
- wagmi stays on **v2** because RainbowKit 2 targets wagmi 2. Two viem copies ship: WalletConnect's `@walletconnect/utils` exact-pins its own (it loads only with the lazily split WalletConnect connector), which cannot be collapsed without force-resolving an exact transitive pin. `ethers` is not a frontend dependency but still resolves transitively (v6, via `@farcaster/auth-kit`).
- viem behaviour that differs from the former ethers 5 code: `parseUnits` rounds over-precise input instead of throwing (see `docs/todo/TODO.md` for the token-rule editor consequence); `formatUnits` drops a trailing `.0`; `mnemonicToAccount` (deprecated mnemonic login) accepts a mnemonic with a bad BIP-39 checksum where ethers rejected it (valid mnemonics derive byte-identically); viem 2 changed several chains' default public RPCs, i.e. the second leg of every `fallback`; and Lukso UP addresses come back in whatever casing the extension returns rather than EIP-55 (backend lookups are `LOWER()`-normalised, so this is cosmetic).

### Farcaster AuthKit

**Used in:** `src/App.tsx`

Farcaster decentralized social protocol integration:
- `AuthKitProvider` with an Optimism RPC endpoint.
- Used for Farcaster-based login.

### recharts (Charts)

**Used in:** `src/views/TokenSale/StakeTab/LockDurationSlider.tsx`

Used to draw the reward-curve preview in the staking UI (`AreaChart` of previewed Spark vs. lock duration, with a reference dot for the selected duration).

### motion (Animations)

`motion` v12 (the successor of `framer-motion`; imports come from `motion/react`).
Direct usage is narrow — three files, and only `motion.div` + `AnimatePresence`:

| File | What it animates |
|---|---|
| `src/components/atoms/Tooltip/Tooltip.tsx` | tooltip/popover enter + exit (fade + scale spring) |
| `src/components/atoms/Tooltip/UserProfilePopover.tsx` | user popover enter + exit |
| `src/components/molecules/Message/Message.tsx` | the message hover toolbar |

Indirectly it also drives `react-modal-sheet` (v5 peer-depends on `motion >= 11`),
which is the bottom sheet behind `BottomSliderModal` — see `ScreenAwareModal` /
`ScreenAwarePopover` for how mobile falls back to it.

Two `react-modal-sheet` props in `BottomSliderModal` are deliberate:
`avoidKeyboard={false}` (v5's own keyboard avoidance would double-compensate
against `WindowSizeProvider`'s `--visualHeight` mechanism) and
`dragVelocityThreshold={500}` (v5 raised the flick-to-dismiss threshold to
1200 px/s; 500 keeps the earlier swipe-to-close feel).

The mobile user-settings sheet opts into `contentOwnsScroll`: its own bounded
`Scrollable` handles the account list, while `Sheet.Content` disables its extra
scrolling and dragging. The sheet header still drags to close. Mobile content
uses its natural height up to the viewport limit; it does not feed the measured
list height back into its flex parent.

`AnimatedContainerVertical` and `AnimatedTabPage` are **not** motion-based despite
their names — they animate with a plain CSS transition and CSS keyframes respectively.

### dnd-kit (Drag & Drop)

`@dnd-kit/core` + `sortable` + `utilities` replaced the dead
`react-beautiful-dnd` in 2026-08 (React 19 blocker). Every use is a sortable
list — `ChannelManagement` (the nested area → channel tree), `GroupsMenu`,
`MultiEntryField`, `OwnCommunitiesBrowser` — which is why dnd-kit's sortable
preset was chosen over Atlassian's pragmatic-drag-and-drop.

- `src/hooks/useDragSensors.ts` reproduces rbd's ergonomics for all sites:
  mouse drags start after 5 px, touch after a 120 ms long press (5 px
  tolerance, so a swipe still scrolls), plus a keyboard sensor
  (Space/arrows/Esc). Sensor options are hoisted constants — inline objects
  would defeat `useSensor` memoisation.
- Collision detection follows rbd's list-first model (container by pointer →
  row by pointer → row by dragged-rect overlap → container); a drop outside
  every target cancels, and drops in the gaps between rows land at the right
  slot. Screen-reader announcements are positional, fed by per-item
  `data.label`.
- Every list is a single column with rows of different heights, so all of
  them use `verticalListSortingStrategy` (`rectSortingStrategy` is for grids
  of equal cells: it moves each row onto its neighbour's rect *and scales it
  to that size*), and every sortable applies `CSS.Translate`, never
  `CSS.Transform` — dnd-kit transforms carry `scaleX`/`scaleY`, which
  squashed/stretched the sidebar icons mid-drag.
- dnd-kit's guard against the click that trails a pointer drop only stops its
  propagation; the browser's default action survives. On draggables that
  contain links (`GroupsMenu`'s `NavLink`s) that default is a native
  navigation — a full page reload after a drop — so such surfaces call
  `suppressClickAfterDrag(event.activatorEvent)` from `onDragEnd`/
  `onDragCancel`.
- `GroupsMenu` and `OwnCommunitiesBrowser` share `useSortableOwnCommunities`:
  they render `useOwnCommunities()` as is (stored order, communities missing
  from it appended); a move is laid over that locally at once, saved
  debounced, and stays until the stored `communityOrder` matches it — or the
  save fails, or the stored order changes to something else while no save is
  scheduled or in flight (no snap-back while saving, no stuck local order).
  Moves are applied to the *rendered* list and mapped back onto
  `communityOrder`, which may hold ids that are not rendered and lack ids
  that are (`util/communityOrder.ts`).
- Known deviation from rbd: there is no `DragOverlay`, so the dragged row is
  transformed in place and can be clipped by a scrolling ancestor.

### Other Notable Libraries

| Library | Purpose |
|---|---|
| `dexie` + `dexie-react-hooks` | IndexedDB wrapper + React reactive queries (`useLiveQuery`) |
| `react-markdown` | Markdown rendering for chat messages and articles |
| `recharts` | Charts (staking reward curve) |
| `react-router` (7) + `history` | Client-side routing (declarative mode; see "Routing on react-router 7") |
| `dayjs` | Date formatting/manipulation (with plugins: isToday, isYesterday, isTomorrow, advancedFormat, utc, timezone) |
| `lodash` | Utility functions (debounce, isEqual, etc.) |
| `react-dropzone` | Drag-and-drop file upload (`noPaste` is set — `EditField` has its own paste-to-attach handler). `getInputProps()` spreads caller props *after* its defaults, so the hidden input's `style` must carry the full hiding style, not just a tweak — see the CAUTION comment in `EditField.tsx` |
| `ua-parser-js` (v2) | Device/browser detection. v2 reports the mobile builds of desktop browsers as `"Mobile Chrome"` / `"Mobile Firefox"` (also Chrome on iOS) — compare against both spellings, as `NotificationProvider` does |
| `short-uuid` | Short IDs in URLs; existing links depend on its default flickrBase58 alphabet (see docs/backend, `getRoutes.ts`) |
| `viem` | EVM operations (unit formatting, SIWE signing, mnemonic wallets — `ethers` left the frontend in the 2026-08 web3 wave) |
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

Every tab is independent: it owns its WebSocket connection, its login state and its in-memory data. There are no tab roles, no leader tab and no referee; the page never opens `BroadcastChannel('CG_WEBSOCKET_STATE')`, and the service worker takes no part. Correctness does not depend on cross-tab coordination: a background tab only has to be correct once it is visible again, and every tab catches up from the server after a (re)connect (§3 "Chat stores", [docs/realtime → Tab Coordination](../realtime/README.md#tab-coordination-1) for the reasons behind this model).

1. **WebSocket (one per tab).** Every tab connects its own socket (`WebSocketManager`, §4). Visible tabs — also several side by side — are always connected; a hidden tab closes its socket after 5 minutes unless it is in a call, and on `freeze`/`pagehide` at once; it reconnects when it comes back. The cost is one socket per open, non-idle tab. For one release the service worker still answers role requests of pages of the previous build with `active` (`src/serviceWorkerLegacyTabs.ts`, marked `COMPAT — remove one release after chat-sync`), see [docs/realtime → Tab Coordination](../realtime/README.md#tab-coordination-1).

2. **Login.** Each tab tracks its own login state. HTTP logins (for a device login: secret, signature and request) run one at a time across tabs under the Web Lock `cg:login`; logins and logouts are broadcast on `BroadcastChannel('cg:auth')` with the `CG_CURRENT_USER` storage event as fallback, and every tab follows them itself (§4, LoginManager). A `LOGIN_REQUIRED` is handled in the tab that got it.

3. **Channel data.** Messages and notifications are held in memory per tab (`chat.channels`, `chat.notifications`, §3 "Chat stores"); tabs do not exchange them, each catches up on `onLive`/`onResume`. Since the server sends a message created in one tab to the sender's other tabs too (only the sending socket is excluded, [docs/realtime → Socket-scoped targeting](../realtime/README.md#socket-scoped-targeting)), they see it live. Read state is shared through the community/chat rows (`mergeReadState`, idempotent across tabs) and from the server (`cliChannelLastRead`, `getSyncState`).

4. **Alerts.** No tab plays sounds or shows desktop notifications for messages; desktop notifications come only from Web Push in the service worker, and the only sounds are call sounds in the tab that is in the call. So "exactly one tab alerts" needs no election. A later feature with in-tab alerts would need one (e.g. a Web Lock, keeping in mind that a frozen tab keeps its locks).

5. **localStorage.** Used for cross-tab state sync (`StorageEvent` listener) for the current user and various preferences.

---

## 9. Build, Entry Points, and Instance Configuration

### Toolchain

The frontend is built with **Vite 8** (`vite.config.ts`; 8.3.5 since wave M3,
2026-11-01, before that Vite 7). It replaced Create React App + craco +
webpack; nothing of that stack remains. Vite 8 is a bundler swap, not just a
version bump: **Rolldown** (1.2.x) bundles instead of Rollup 4, **Oxc**
transforms and minifies JS instead of esbuild, **Lightning CSS** minifies CSS
instead of esbuild, and the dev server pre-bundles dependencies with Rolldown.
esbuild is no longer in the root lockfile at all. The plugins moved with it:
`@vitejs/plugin-react` 6 (React Refresh through Oxc, no Babel any more),
`vite-plugin-svgr` 5 (transforms through Oxc) and `vite-plugin-node-polyfills`
0.28 (Vite 8 support). Node floor `^20.19 || >= 22.12`; the builder image runs
Node 26. A production build takes ~4–5 s of bundling instead of ~23 s.

What the swap changed, and what it did not (measured against the Vite 7 build
of a1460cb):

- **Chunking** is now `build.rolldownOptions.output.codeSplitting` with one
  group per vendor group and explicit priorities — see the "Chunking" row
  below. The vendor chunks hold the same packages as before, with three
  deliberate shifts (`lodash`, `idb-keyval`, `fast-safe-stringify` no longer
  pulled into `vendor-web3`; `vendor-charts` also holds `d3-brush`/
  `victory-vendor`) and two new pins in `vendor-shared`: Oxc's lowering
  helpers (virtual `\0@oxc-project+runtime@…` modules) and the `global` shim.
  Unpinned, the Oxc helpers landed in `vendor-charts` and made `web-vitals`,
  `AuthFlow`, `vendor-mediasoup` and others import that chunk.
- **First-party code is split more finely.** Rolldown's automatic chunking
  splits `src/` along dynamic-import boundaries where Rollup kept one ~2 MiB
  `App` chunk: loading the app now takes 48 static chunks instead of 21, at
  the same total size (~7.9 MiB). Chunk names follow the first module of a
  chunk, so they changed too (`util`, `MobileLayout`, `AuthFlow`, …).
- **CSS**: Lightning CSS is stricter than esbuild — it refuses invalid CSS
  instead of passing it through (the one case was an `@property` whose
  `initial-value` did not match its `syntax`, which browsers had silently
  dropped; fixed in `Splash.css`) — and it lowers for `build.cssTarget` (the
  JS target), so some rules gain fallbacks (+3.5 % CSS). It also minifies the
  inline `<style>` blocks of both HTML shells; inline **scripts** stay
  verbatim, so the CSP hash of the dark-mode script did not change.
- **The service worker** now hands precached scripts over fully read instead
  of streaming them out of Cache Storage: with the Vite 8 chunk graph Chrome
  otherwise cancelled module-script requests on ~1.5 % of fresh loads and the
  app showed its error screen — see "Service worker and module scripts" below.
- **CommonJS interop** follows Rolldown's consistent `default` rule; no
  import needed a change (build, dev server and the e2e suite run clean).
- Vite prints a notice that the config uses features the future
  `configLoader: 'native'` default will not support (ESM syntax in `.ts`
  files of a package without `"type": "module"`). Harmless today; see
  `docs/todo/TODO.md`.

`build.target` is explicit (`BUILD_TARGET` in `vite.config.ts` — `chrome104,
edge104, firefox97, opera90, safari15.4`), so Vite 8's default target
(`'baseline-widely-available'`, ≈ Safari 16.4) never applies. Vite 8 still
takes the target in esbuild notation and converts it for Oxc and Lightning
CSS; `build.cssTarget` defaults to it, so the CSS is lowered and
vendor-prefixed for the same floor. `BUILD_TARGET` is the only place the floor
is defined (the `browserslist` key in `package.json` is gone: its last
reader, autoprefixer, left with Tailwind 4).

The floor is a product decision (2026-11-02, wave M4): **Safari 15.4 (iOS
15.4), Chrome/Edge 104, Firefox 97** (Opera 90 is Chromium 104). Until then it
was `chrome67, edge79, firefox68, opera54, safari14`. Tailwind CSS 4 set the
new values: preflight and the `@tailwindcss/forms` base styles sit in a
cascade layer (Safari 15.4, Firefox 97, Chrome 99), and the transform
utilities use the individual `translate`/`rotate` properties (Chrome 104).
iOS 14 and iOS 15.0–15.3 are below the floor. Web push is gated at iOS ≥ 16.4
anyway (`src/context/NotificationProvider.tsx`; user-facing copy in
`src/components/molecules/PWA/PWA.tsx`).

| Concern | Where |
|---|---|
| Build / dev server | `vite.config.ts`. Multi-page: both HTML shells are bundler inputs (`build.rolldownOptions.input`) and are emitted at the dist root under their own names. Dev server is pinned to host `0.0.0.0`, port **3000** — load-bearing, because `src/data/appstate/serviceWorker.ts` disables SW registration on that origin, which is what keeps dev SW-free. |
| Project-relative bare imports | `vite/baseUrlResolve.ts`. ~1945 import lines use bare specifiers that are really `src/`-relative (`components/…`, `common/util`, but also file-level ones like `'App'` and `'service-worker'`). For the type checker, `tsconfig.json` maps them with `paths: { "*": ["./src/*"] }` (until TypeScript 6 this was `baseUrl: "src"`, which TS 6 deprecates and TS 7 removes); for Vite and Vitest the plugin reimplements webpack's precedence: node_modules wins, `src/` is the fallback. (tsc tries `src/` first and then `node_modules` — with `paths` exactly as it did with `baseUrl`; Vite the other way round, unchanged.) |
| SVG components | `vite-plugin-svgr` (5.x), behind a `?react` query — `import Icon from './icon.svg?react'`, **default** export. `svgo: false` is load-bearing (svgr's default svgo pass strips `viewBox`). Typed by `src/types/svg-react.d.ts`. |
| Service worker | `vite/serviceWorker.ts` — a nested Vite build plus `workbox-build`'s `injectManifest`; deliberately **not** `vite-plugin-pwa`, because the worker and its registration manager are hand-written. Fails the build if the worker bundle is not a single file or if any emitted JS/CSS chunk is missing from the precache. |
| Entry `<script>` tags | `vite/htmlEntryScripts.ts` — the shells carry no `<script src>`; the config declares which module belongs to which shell. |
| Social preview meta | `vite/absoluteSocialMeta.ts` — makes `og:image`/`twitter:image`/`og:url` absolute when `PUBLIC_URL` is set (only the legacy Azure pipelines set it). |
| Node polyfills | `vite-plugin-node-polyfills` (0.28), scoped to `buffer`/`stream`/`assert` + the globals `Buffer` and `global`, for transitive dependencies only. `process` is deliberately **not** polyfilled: `src/common/` is dual-runtime (the backend consumes it through the `srv/common` symlink) and reads env through a `globalThis` indirection that must keep resolving to nothing in the browser. `global` is provided since Vite 8 (shim = `globalThis`, injected only into modules that reference it): Rollup's commonjs plugin had rewritten a bare `global` in CommonJS dependencies, Rolldown does not, and e.g. `randombytes` and `@walletconnect/environment` would throw `ReferenceError: global is not defined`. |
| Dependency aliases | Two exact-match `resolve.alias` entries in `vite.config.ts`, both load-bearing. `@tensorflow/tfjs` → `src/moderation/tfjs.ts` is described in the NSFW pre-check section above. `altcha-widget-element` → `altcha` loads the widget bundle under a stub module name so its `.d.ts` (which augments `react/jsx-runtime` and would shadow the whole JSX namespace — first observed under @types/react 18) never enters the TS program; the stub is `src/types/altcha-widget-element.d.ts`. altcha 3 moved that augmentation out of the default types entry into `altcha/types/react`, so the hazard is narrower now, but the alias is what keeps it out for good. (An earlier third alias pinning `@metamask/sdk` to its browser UMD file was removed in the 2026-08 wagmi-2 migration: the SDK is no longer a direct dependency — wagmi's `metaMask` connector imports it dynamically — and 0.33's `browser`/`module` fields both point at the browser ESM build, so Vite resolves it correctly unaided; measured, the precache is 60 KB smaller without the alias.) |
| Chunking | `build.rolldownOptions.output.codeSplitting` in `vite.config.ts`: nine vendor groups (`vendor-web3`, `vendor-icons`, `vendor-charts`, `vendor-mediasoup`, `vendor-emoji`, `vendor-editor`, `vendor-dnd`, `vendor-react`, `vendor-shared`) split what Vite's default chunking put into one ~5.4 MiB `App` chunk (a Vite 6 measurement; the groups carried over unchanged in the Vite 7 bump — same chunk set, every chunk same-size or marginally smaller). Since Vite 8 they are one Rolldown group each, with `vendor-react` and `vendor-shared` at a higher `priority` than the feature groups — not the function-form `manualChunks` (deprecated; Rolldown emulates it as a single group whose members claim shared dependencies in alphabetical order, which put `vendor-charts` into the CG ID entry). Same packages per vendor chunk as under Rollup, except that `lodash`, `idb-keyval` and `fast-safe-stringify` are no longer pulled into `vendor-web3` and `vendor-shared` additionally pins Oxc's lowering helpers and the `global` shim (`SHARED_HELPERS`) — bundler-generated or injected modules every feature group shares, which otherwise land in whichever group reaches them first. `node_modules` only — `src/` keeps the default behavior, because splitting first-party modules is what turns an import cycle into a TDZ crash. `assertCgidEntryChunks` (same file) fails the build if the CG ID entry ever statically reaches a group other than `vendor-react`/`vendor-shared`. Details and the rules the table follows: [docs/infrastructure](../infrastructure/README.md#frontend-build-steps). Changing it needs a browser pass. |
| Sourcemaps | `build.sourcemap: true` on every build path (the app is AGPL). **JS only** — Vite emits no `.css.map` (neither under Rollup nor under Rolldown), unlike CRA; and since Vite 8 the small `modulepreload-polyfill` chunk, which also carries Rolldown's runtime helpers, has no `.map` either. The service worker excludes maps from the precache, so they only cost bandwidth when devtools opens them. |
| CSS | Tailwind CSS 4 through the `@tailwindcss/vite` plugin (`vite.config.ts`); setup and configuration in `src/tailwind.css` — there is no `tailwind.config.js` and no PostCSS config any more (see "Styling: Tailwind CSS 4" below). Nesting is native CSS nesting, lowered by Lightning CSS. Minified by Lightning CSS (Vite 8 default), which also adds the vendor prefixes for `build.cssTarget` (autoprefixer's job until wave M4) and rejects invalid CSS that esbuild passed through — a build error from `[lightningcss minify]` means a real CSS bug. |
| Type-check | `yarn typecheck` — `tsc --noEmit` over `src/**` plus `tsconfig.node.json` over the Vite-side files. TypeScript 6.0 (wave M1, 2026-10-31; before that 5.9 — and 4.5 could not even *parse* viem's TS-5 `.d.ts` files, which silently disabled semantic checking). The tsconfigs use no option TS 6 deprecates (no `ignoreDeprecations`), so they are ready for TS 7: `moduleResolution: "bundler"` (Vite resolves the imports; this also enforces package `exports`, hence `mediasoup-client/types` instead of the unexported `mediasoup-client/lib/types`), the `paths` mapping above instead of `baseUrl`, no `dom.iterable` (part of `dom` since TS 6) and no `esModuleInterop`/`allowSyntheticDefaultImports` (always on since TS 6). `tsconfig.json` targets **es2020**: not es5, because TS 5.5+ grammar-checks regex syntax against the target and rejects the `u` flag + `\p{…}` escapes in `src/common/validators.ts`; and not es2018 any more, because viem 2 and its `ox` dependency ship `.ts` sources with BigInt literals, which tsc rejects below ES2020. Nothing emits from this tsconfig — shipped output is transpiled by Vite against `build.target` (`BUILD_TARGET`). |
| Lint | `yarn lint` — `eslint.config.mjs` (ESLint 9 flat config: typescript-eslint + react + react-hooks), calibrated to the severities the old `react-app` preset enforced. Errors fail, warnings do not. |
| Tests | `yarn test` — Vitest 4 (`vitest.config.ts`; it already ran on its own Vite 8 copy before wave M3, now it shares the app's) over `src/**/*.test.{ts,tsx}`; a small unit suite so far (instance config, the image-filter client modules, the upload connector, an EditField helper). Not part of the build scripts yet. |

Neither type-check nor lint happens during `vite build`, which is why the docker
build scripts run them as explicit steps — see
[docs/infrastructure](../infrastructure/README.md#frontend-build-steps).

### Styling: Tailwind CSS 4

The app styles with ~320 plain stylesheets next to their components (most of
them `@apply` Tailwind utilities), utility classes in JSX, styled-components
in some places, and a color scheme of CSS variables in `src/index.css`
(`body.light` / `body.dark`, switched by `DarkModeProvider`). **Tailwind CSS 4**
(4.3.3 since wave M4, 2026-11-02; before that 3.4) runs as the
`@tailwindcss/vite` plugin. The `@tailwindcss/postcss` route was not taken:
nothing else needs PostCSS, and with the Vite plugin `postcss.config.js`,
`autoprefixer` and the direct `postcss` dependency are gone (Lightning CSS
prefixes, see the CSS row above).

**Inline background images** go through `cssBackgroundImage(url)`
(`src/util/cssBackground.ts`): `style={{ backgroundImage: cssBackgroundImage(imageUrl) }}`.
It returns a quoted, escaped `url("…")`, or `none` while the URL is missing
(a signed URL that is still loading, a user without a profile picture). A
template like `` `url(${imageUrl})` `` renders `url(undefined)` in that case,
which the browser resolves against the current path — on a route ending in
`/` such as `/c/<community>/call/<id>/` it requests `…/<id>/undefined`. The
e2e suite fails a flow on any same-origin request with an `undefined` or
`null` path segment (`e2e/README.md`).

**Predefined roles** (Admin, Member, Public) are recognised by type and title, never by the
title alone (`src/util/predefinedRoles.ts`): `isPredefinedRole`/`isPublicRole` for role objects,
`isPredefinedRolePermission`/`isPublicRolePermission` for `rolePermissions` entries (by
`roleType`; by title only where a list has no `roleType`). The lists the client builds carry `roleType` too, and a community refresh treats a changed `roleType` as a changed channel. A custom role with such a title is an
ordinary role.

**Configuration lives in `src/tailwind.css`** (CSS-first; `tailwind.config.js`
is gone): `@theme` (the `palette-*` colors, the fonts), `@utility` (the
`cg-*` typography, radius and shadow classes, in v3 a plugin's
`addComponents`), `@plugin` (`@tailwindcss/forms`; `@tailwindcss/aspect-ratio`
is gone, v4 has `aspect-*` built in, and so is `@tailwindcss/typography`,
which no `prose` class used), `@source`
(the v3 `content` globs, and the v3 `safelist` as `@source inline(...)`) and
`@custom-variant dark` (the `.dark` class, not the OS preference — no utility
uses `dark:` today). It is used two ways:

- `src/index.css` and `src/index_cgid.css` `@import` it at the top — it emits
  the theme variables, preflight and the utilities there, before the entry's
  own rules, like v3's three `@tailwind` lines did.
- Every other stylesheet that uses `@apply` (or `theme()`) starts with
  `@reference '<relative path>/tailwind.css';`. Each stylesheet is compiled on
  its own, and without the reference it does not know the utilities: the
  build fails with `Cannot apply unknown utility class`. A new stylesheet
  needs the line too.

**The cascade is kept as under v3**, which is why the file does not
`@import 'tailwindcss'`:

- The utilities and the theme variables are **unlayered**. Stock Tailwind 4
  puts utilities into `@layer utilities`, and an unlayered rule beats every
  layered rule regardless of specificity: the element rules in
  `src/index.css` (`svg { display: inline-block }`, `h1`…`h5`, `label span`)
  and any component rule against a `hover:` utility would suddenly win.
  Unlayered, utilities and the app's stylesheets compete by specificity and
  order as before (the CSS chunks and the order the app loads them in are
  unchanged — the `App` chunk with `src/index.css` comes after the chunks
  of `Button`, `Modal`, `MobileLayout`, … that the entry pulls in first).
- Preflight, the plugins' base styles (`@tailwindcss/forms`) and a small
  compatibility block are in `@layer base`, below every unlayered rule. The
  compatibility block restores what v4's preflight changed visibly: the
  default border color (v3's gray-200, v4: `currentColor`) and the pointer
  cursor on buttons. The placeholder color needs nothing: `@tailwindcss/forms`
  sets it after preflight, as under v3. Being layered also changes
  `!important`: preflight's `[hidden] { display: none !important }` (new in
  v4) beats every unlayered `!important`, because for important declarations
  the layer order is reversed — an element with the `hidden` attribute stays
  hidden whatever the app's CSS says.
- **Layer order** is fixed in `src/tailwind.css` and only there:
  `@layer properties, base;` (Tailwind's `@property` fallbacks, then
  preflight). Component stylesheets never open a layer — whichever stylesheet
  names a layer first fixes the order, and the CSS chunks load in the order
  the app imports them. Apart from the layers, the cascade follows the chunk
  load order, as under v3. (In the built files Lightning CSS drops the
  statement as redundant: the main and CG ID entries open `@layer properties`
  and then `@layer base`, in that order. The only other layered output is the
  `@layer properties` block Tailwind adds to a component chunk whose `@apply`
  uses a `@property`-based utility, e.g. `MobileLayout` — it names
  `properties` only, so the order holds.)
- Under v3 preflight and the forms base styles were unlayered rules in the
  `App` chunk, so they **won ties** against element rules in stylesheets that
  load before it. `TextAreaField.css` (part of an entry chunk) had a
  `textarea { … }` rule whose margin, padding, color, background, border
  color, `resize`, focus and placeholder styles therefore never took effect;
  in v4 they would. They are removed; what did take effect (width, cursor,
  overflow, border style, the hover and `autogrow` rules) stays. A new bare
  element rule for form controls has to reckon with this the same way.
- Third-party widgets that reset with `all: revert-layer` now fall back to
  the `base` layer instead of the browser defaults. ALTCHA does
  (`.altcha * { … }`); the compatibility block reverts that layer for it too
  (`div.altcha *`), otherwise the widget's logo turns `display: block` and
  the captcha box shrinks by 4 px. ALTCHA is the only bundled code that uses
  `revert-layer`.
- The theme is `inline` (`theme(inline)`, `@theme inline`): a utility carries
  its value (`.px-4 { padding-left: 1rem; padding-right: 1rem }`) instead of
  `var(--spacing)`. Lightning CSS cannot lower a declaration with `var()` in
  it, so with references v4's logical properties (`padding-inline`, …) would
  reach browsers below `build.cssTarget` unlowered. The palette is also
  `static`: always emitted as variables, because `src/index.css` and a few
  components use `var(--color-palette-…)`, which Tailwind does not count as a
  use when it decides which variables to emit.
- The default-palette families the app uses (`gray`, `red`, `yellow`,
  `blue`) are pinned to their v3 hex values — v4's oklch palette is visibly
  more saturated — and so are v3's fixed line heights of `text-xs`…`text-4xl`
  (v4 uses ratios, which children with a font size of their own inherit
  differently). The v3 config replaced the font families instead of
  extending them, so `font-sans`/`font-serif`/`font-mono` still do not exist.
- The `cg-*` classes are utilities now, sorted among all utilities by the
  properties they set and how many, no longer in their definition order (the
  v3 components layer kept that). So among themselves the text classes now
  come in Tailwind's order (`cg-heading-1`…`3`, `cg-text-lg-*`,
  `cg-text-md-*`, `cg-caption-md-600`, then `cg-heading-4`/`5`,
  `cg-text-sm-*`): where an element carries two of them, the winner may have
  changed. Against core utilities they still come before `text-*`/`font-*`
  and `cg-border-*` before `rounded-*`, but `cg-box-shadow-*` comes *after*
  `shadow-*`. No element combines a shadow pair today.

**Native CSS nesting** replaced `tailwindcss/nesting` (postcss-nested), and it
differs in three ways that matter here:

- `@keyframes` inside a style rule is invalid there and was **dropped
  silently**, rule and all (the mobile menu's fade animations, the skeleton
  shimmer). Keyframes go at the top level of the file.
- A nested rule under a **selector list** (`&.active, &.active:hover { .btnText
  { … } }`) becomes `:is(…) .btnText`, which takes the specificity of the
  most specific entry for all of them; postcss-nested produced one selector
  per entry. Where the entries differ in specificity (state lists in
  `Button.css`, `MenuButton.css`, `ReactionEmojiItem.css`) the child rules
  are spelled out per entry. Lists of equal specificity (the twelve `.btn*`
  classes) are fine.
- Sass-style suffixes (`&-title`) do not exist in native nesting; the
  stylesheets never used them.

**v4 syntax** the migration needed (the official `@tailwindcss/upgrade` 4.3.3
did the JSX part; its output was reviewed, and two of its renames were wrong
because the class names are also the app's own: `blur` in `PreviewCards`
and `rounded` on `TextInputField`'s `inputClassName`, which
`.input.rounded` styles): `flex-grow`/`flex-shrink` → `grow`/`shrink`,
`rounded` → `rounded-sm`, `shadow` → `shadow-sm`, `outline-none` →
`outline-hidden`, `overflow-ellipsis` → `text-ellipsis`, `break-words` →
`wrap-break-word`, `bg-gradient-to-t` → `bg-linear-to-t`, `aspect-3` (from
the aspect-ratio plugin) → `aspect-3/1`, `@apply x !important` → `@apply x!`,
`theme('colors.palette.…')` → `var(--color-palette-…)`, `theme('screens.xl')`
→ the literal `1280px` (v4's breakpoint is `80rem`). The app's own
`@keyframes spin` (`App.css`, `.spinner`) is `cg-spin` now: Tailwind 4 emits a
`spin` of its own, and Lightning CSS merged the two.

**Measured against the v3 build** (e857ee5): every CSS file flattened to
(selector, property) pairs, `:is()` expanded, shorthands and logical
properties normalized — the only differences in the app's own rules are
`outline-hidden` (a transparent outline only in forced-colors mode instead of
always) and `rounded-full` (`calc(infinity * 1px)`); an invalid declaration
Lightning CSS dropped (`width: 'auto !important'` in `MenuButton.css`) is
deleted. Preflight differs where v4 changed it (it resets margin and
padding on every element, buttons and inputs get `font: inherit`,
`border-radius: 0`, a transparent background, `[hidden]` is `!important`,
…). CSS output with the raised floor: 476 KB instead of 481 KB (75 KB instead
of 73 KB gzipped; with the old `safari14`/`chrome67` floor it was 526 KB / 77 KB,
mostly `:-webkit-any()` copies of lowered nested selector lists). The JS shrank
by ~120 KiB (~30 KiB gzipped), Oxc lowering less for the new floor. The build prints 9
`SOURCEMAP_BROKEN` warnings for the Tailwind plugin's CSS transforms;
harmless, Vite emits no CSS source maps anyway. **Visual check:** 30 key views
(home, explore, lobby, channel with messages/reactions/image/link, article
and editor, login/sign-up incl. error and limit messages, user settings incl.
"Sign out other devices", community settings, `?modal=` dialogs, the
start-call dialog, stake, app store, DMs, notifications, the phone menu) at
1280 px and 400 px in light and dark, both builds served by the same
instance with the same data: 114 screenshot pairs, pixel-identical after the
two fixes above (ALTCHA, `TextAreaField.css`; the layer-order and
`TextAreaField.css` rework after review re-checked on the affected views) apart from one anti-aliased
pixel; a second baseline pass showed no run-to-run noise. Not covered:
hover/focus states beyond a message hover, the in-call UI, old browsers.

**Browsers between the floor and Tailwind's own target.** Tailwind 4 is
built for Safari 16.4+, Chrome 111+, Firefox 128+; the floor
(`BUILD_TARGET`, see "Toolchain") is Safari 15.4, Chrome/Edge 104,
Firefox 97. In that range the utilities carry plain values, Lightning CSS
lowers nesting and colors, cascade layers work, and the utilities built on
registered custom properties (`@property`: `shadow-*`, `ring`, the style of
`border`, `blur`, `translate-*`/`rotate-*`, gradients) get their start values
from Tailwind's fallback (`@layer properties`, applied where `@property` is
missing). Below the floor the layout breaks: without cascade layers the
whole `base` layer (preflight, the forms base styles) and that fallback are
ignored.

### Dependency pins and constraints

Constraints in the root `package.json` that are not self-explanatory. The
2026-08 dependency refresh brought everything to a current in-major release
(React 19, wagmi 2 / viem 2 / RainbowKit 2, slate 0.126, motion 12, dnd-kit),
and the 2026-10-31 refresh (F6) moved every package to its newest in-major
release that has passed the 7-day age gate (except `mediasoup-client`, which
moves together with the backend's `mediasoup` and its pinned worker); the
deferred majors came in waves (the completed cg.box roadmap, retained in git at `5d0df48`): TypeScript 6
and joi 18 with wave M1 (2026-10-31), Vite 8 (with `@vitejs/plugin-react` 6,
`vite-plugin-svgr` 5 and `vite-plugin-node-polyfills` 0.28) and react-router 7
with wave M3 (2026-11-01), Tailwind CSS 4 with wave M4 (2026-11-02).

- **`resolutions`**: `@types/react` → `"19"` keeps every `@types/react@*`
  consumer on one copy; a second copy makes components from other packages fail
  with `TS2786`.
- **`resolutions`**: `@rainbow-me/rainbowkit/cuer` → `"0.0.4"`. RainbowKit
  2.2.11 draws the WalletConnect QR code with `cuer`, which it pins exactly to
  0.0.3; cuer depends on `qr: "~0"`, and the lockfile resolves that to a qr
  ≥ 0.6 (0.6.0 since the RainbowKit 2 move on 2026-08-04, 0.7.2 since the F6
  refresh). qr ≥ 0.6 rejects cuer 0.0.3's `border: 0` with
  `RangeError: invalid border=0`, thrown while the connect modal renders, so
  clicking "WalletConnect" crashed the app to its error page. cuer 0.0.4 asks
  for `border: 1` and slices the ring off (same module matrix as before).
  `src/common/walletConnectQr.test.ts` guards it (it resolves cuer/qr from
  RainbowKit's location and decodes the matrix back to the URI). Drop the
  entry once RainbowKit depends on cuer ≥ 0.0.4 itself.
- **`react-router: "^7.18.4"`** (wave M3, 2026-11-01) replaced
  `react-router-dom` 6.30.6. In v7 `react-router-dom` is only a re-export of
  `react-router`, so every import names `react-router` and `react-router-dom`
  is not installed any more. The floor is security-motivated: 7.18.0+ closes
  the two advisories 6.30.6 still had (GHSA-wrjc-x8rr-h8h6,
  GHSA-337j-9hxr-rhxg), and 7.18.4 is the release the lockfile resolves. 7.18.5 was 5 days old at the
  time (age gate); its changes are SSR/RSC-only. react-router 8 exists; it is
  a separate major for the Renovate dashboard.
- **`tailwindcss` and `@tailwindcss/vite`** (`^4.3.3`, wave M4, 2026-11-02)
  move together: the plugin depends on exactly its own version of
  `tailwindcss` (and of `@tailwindcss/node`/`@tailwindcss/oxide`, whose
  native binaries come as optional per-platform packages — no install
  script, so `enableScripts: false` is fine). `@tailwindcss/forms` `^0.5.11`
  is the release the lockfile already resolved; it works as a v4 `@plugin`. `@tailwindcss/node` pins its
  own `lightningcss` 1.32.0, so the tree holds that and Vite's copy.
- **`history`** is a direct dependency because `SuspenseRouter` imports
  `createBrowserHistory` from it; react-router has not depended on it since
  6.x, so without the declaration it would be a phantom dependency.
- **`react-is: "19"`** is direct because recharts 3 demoted it to a peer; the
  nested 16.x copy left in the tree cannot recognise React 19 elements.
- **`slate-dom`** is direct because slate-react ≥ 0.111 peer-requires it.
- **`@hapi/tlds` stays on 1.x** (both workspaces — `src/common/validators.ts`
  is shared with the backend via the `srv/common` symlink). 2.x is ESM-only
  and its `types` field pointed at a file the tarball did not ship, so with the
  frontend's former `moduleResolution: "node"` it did not resolve at all. The
  frontend is on `"bundler"` since TypeScript 6 (wave M1); the move to 2.x is a
  separate follow-up (see `docs/todo/TODO.md`). joi 18 itself depends on
  `@hapi/tlds` `^1.1.1`.
- Exact pins are kept exact: `altcha`, `dexie`, `dexie-react-hooks`,
  `mediasoup-client`, `protoo-client`, `socket.io-client`, `typescript`,
  `workbox-precaching`, `workbox-routing`, and in `devDependencies`
  `@tsconfig/node24`, `@types/node`, `workbox-build`.
  `socket.io-client` moves together with the backend's exact `socket.io`
  (likewise `protoo-client` with `protoo-server`). (`react`, `react-dom` and
  `react-is` are pinned to the major only, `"19"`.) Ranged packages keep their range style; a security-motivated
  bump raises the range floor to the fixed version.
- `@types/react-router-dom` (v5 types) is gone with wave M3; react-router 7
  ships its own types.

### Entry points

- **Main entry**: `src/index.tsx` -- the primary web app entry point.
- **CG ID entry**: `src/index_cgid.tsx` -- alternative entry point for the CG Identity service.
- **Service Worker**: `src/service-worker.ts` -- handles caching, push notifications and notification clicks, the update/reload flow, and a one-release compat answer to old pages' tab-role requests (§8). A gateway serves a small replacement worker at the same URL instead ([Service worker on a gateway](#service-worker-on-a-gateway)).
- **Config**: `src/common/config.ts` -- deployment configuration (dev/staging/prod), feature flags, URLs, chain set.
- **Docker**: `docker/.env` -- environment variables of the dev compose stack (gitignored, generated from the tracked `docker/.env.example` on first `./run.sh`; see [docs/infrastructure §4](../infrastructure/README.md#4-environment-variables)).

### Service worker and module scripts

The worker precaches every emitted chunk and answers their requests from
Cache Storage (Workbox `PrecacheController`). It hands **scripts** over with
the body read into memory first (`bufferCachedScripts` in
`src/service-worker.ts`) instead of streaming it out of Cache Storage. Found in
wave M3 (2026-11-01): with the Vite 8 build, whose app import pulls ~45 chunks
at once (the Vite 7 build ~20), Chrome cancelled (`net::ERR_ABORTED`) some of
those module-script requests now and then although the worker had answered
them with a 200; the module graph failed ("Failed to fetch dynamically
imported module"), the browser keeps that failure for the URL — a second
`import()` failed in 5 of 5 measured cases — and the app showed its error
screen. Measured with repeated fresh loads in the e2e image's Chrome: streamed
from Cache Storage ~1.5 % of loads (7 of 480), the same from the network via
the worker 0 of 480, from the cache with the body read first 0 of 480, without
the worker 0 of 80, the Vite 7 build 0 of 208; with `bufferCachedScripts` 0 of
600. Removing the JS `modulepreload` links did not help (3 of 480), so preloads
were not the cause. The Chromium-side mechanism is not identified; re-measure
before removing the plugin. Fonts, audio and images still stream.

### Runtime Instance Configuration (`src/common/instance.ts`)

Historically the app inferred its deployment mode and URLs from a hardcoded list of official domains; any other domain silently ran with dev semantics. To support self-hosting, an instance now declares who it is at serve time: the server injects a `window.__CG_INSTANCE__` object into `index.html` / `index_cgid.html`, and `src/common/instance.ts` is the single validated accessor for it (`getInstanceConfig()`).

Recognized fields include:

| Field | Purpose |
|---|---|
| `deployment` | Semantic mode (`prod` / `staging` / `dev`) — drives feature flags, chains, captcha |
| `appUrl` | Public base URL of the instance |
| `cgidUrl` | Legacy CG ID (gateway) instances only: base URL of the CG ID app (including hash-router prefix) |
| `passkeyRpId` | WebAuthn RP ID of the passkeys on this origin (absent on a legacy CG ID instance) |
| `recaptchaSiteKey` | reCAPTCHA v2 site key for this instance |
| `activeChains` | Chains the instance supports (keys of the available-chain set) |
| `features` | Capability flags (`email`, `twitterAuth`, `calls`, `imageFilter`, `passkeys`) derived from which server secrets/services are configured; an absent flag means the feature is available. `calls: false` (no mediasoup service) hides the call section in `CallList` / `StartCallButton` and the call-typed event paths in `ScheduleEventModal` / `AttendEventButton` |
| `giphyApiKey` | Giphy key for the GIF picker (empty disables it) |
| `walletConnectProjectId` | WalletConnect Cloud project id for this instance |

When the global is absent (official app and local dev), callers fall back to the legacy domain-based detection, so those environments are unaffected. `config.ts`, `data/util/urls.ts`, and `App.tsx` read this config to select URLs, the active chain set, wallet RPC providers, and captcha keys.

`src/data/auth/authMode.ts` derives the passkey mode from it: an instance is a **legacy CG ID** (gateway) instance only when it carries `cgidUrl` (without an instance config: the app.cg / staging.app.cg hosts); every other instance runs passkeys on its own origin, bound to `passkeyRpId` — unless `features.passkeys: false`, which means passkeys are unavailable there (`PasskeyProvider.supported` is false). `urlConfig.CGID_URL` is only set on a legacy instance (empty elsewhere — there is no CG ID fallback any more).

### Client-Side Wallet Keys

Wallet-related client keys (RPC provider key, WalletConnect project id, Farcaster RPC URL) are baked into the client bundle by design — they are public, origin-scoped keys used from the browser. Self-hosted instances override them through the instance config above rather than sharing the official-instance defaults, which also makes rotation a configuration change rather than a code change.

---

## 10. Authentication UI

Backend contract: [docs/auth-identity](../auth-identity/README.md) §6 (sign-up with email verification), §7 (passkeys), §8 (step-up).

### AuthFlow (`src/components/organisms/AuthFlow/`)

One organism for login and sign-up, rendered inside the onboarding modal (`UserOnboarding`, step `start`; all `setUserOnboardingVisibility(true)` call sites keep working) and as a page on `/login` (`LoginView`). The step machine is a pure reducer (`authFlowMachine.ts`, unit-tested in `authFlowMachine.test.ts`); the steps live in `LoginSteps.tsx` and `SignupSteps.tsx`.

**Login — one form.** Email or username + password. The username field has `autocomplete="username webauthn"`: while the form is shown, a conditional (autofill) passkey request is armed (`PasskeyProvider.armAutofill`), so the browser offers passkeys in the field's autofill. It is renewed every 9 minutes (abort, then arm — the challenge lives 10), re-armed a few times after a failure, and never started while a modal ceremony runs or after it was disarmed in the meantime. Below the form: "Email me a code instead" (only with `features.email`), "Sign in with a passkey" (modal ceremony, from the click), "Wallet" (SIWE, `WalletSignature` molecule), "More" (Universal Profile, Farcaster, X — login only, for accounts that already have them linked; the 12-word recovery phrase only on a legacy CG ID instance), and "New here? Create an account". A wrong identifier and a wrong password get the same message.

After a **password** login, if the account has no passkey on this instance: once per account and browser, a conditional create (`useAutoRegister`, only where `PublicKeyCredential.getClientCapabilities()` reports `conditionalCreate`) lets the password manager add a passkey silently; otherwise, once, the step `offer-passkey` asks "Sign in faster next time — Add a passkey". Both flags live in `localStorage` (`cg-passkey-offer-*:<userId>`).

**Sign-up.** (1) display name (doubles as username, `^[a-z0-9_-]{3,30}$`), email and — when the email code follows — the captcha (`SignupCaptcha` molecule: ALTCHA / reCAPTCHA / off), which `User/requestSignupEmailCode` checks → (2) the 8-digit code, checked by `User/verifySignupEmailCode` — skipped when the instance sends no mail (`features.email: false`) or on a legacy CG ID instance; there the captcha sits on the step that calls `createUser`, so no token has to survive several steps. Going back from the method step returns to the details, which skip the used-up code for the already confirmed address → (3) "How will you sign in?": **Create a passkey** (primary; `Passkey/registrationOptions` + `verifyRegistration` while logged out, then `createUser {usePreparedPasskey}` right away), **Use a password** (policy hints, `autocomplete="new-password"`), **Use a wallet** (SIWE, `createUser {usePreparedWallet}`). No X / LUKSO / Farcaster sign-up and no recovery phrase. `EMAIL_VERIFICATION_REQUIRED` returns to the details for a new code; `CAPTCHA_FAILED` asks to solve the captcha again where it is. When a passkey sign-up fails after the ceremony, the new credential is reported with `signalUnknownCredential` so the authenticator can drop it. On an instance without mail the typed address is stored after `createUser` (unverified). Then the onboarding tail steps follow (`Splash`: newsletter — for the account's address, push, PWA install, finished).

### Passkeys (`src/data/auth/passkeyCeremony.ts`, `src/context/PasskeyProvider.tsx`)

`passkeyCeremony.ts` wraps `@simplewebauthn/browser`: `registerPasskey`, `authenticateWithPasskey(purpose, {conditional})`, `abortPasskeyCeremony`, and the Signal API (`signalUnknownCredential`, `signalAcceptedCredentials`, `signalUserDetails`, each only where the browser has it). Every browser call is inside a `try`; failures become a `PasskeyCeremonyError` with `kind` `cancelled` (dismissed, timed out or replaced — never shown), `already-registered` ("This device already has a passkey for your account"), `unsupported` or `failed` (with the server code when the API refused). Pinned by `passkeyCeremony.test.ts`.

`PasskeyProvider` turns this into UI actions that resolve to `ok` / `cancelled` / `error`. A login with an unknown or deleted credential (`NOT_FOUND` / `DELETED`) calls `signalUnknownCredential`. On a legacy CG ID instance the provider wraps `LegacyCgIdPasskeyProvider` (`src/context/LegacyCgIdPasskey.tsx`, the former popup flow, unchanged) and only `login` works (`loginManager.login({ account: 'passkey-legacy' })`).

**Settings → Passkeys** (`PasskeySettings`) lists `Passkey/list` (name, created, last used, synced vs. one device), renames, removes (confirm dialog → step-up → `Passkey/remove`; `LAST_LOGIN_METHOD` gets its own message) and adds a passkey. Adding requests registration options from the server, which applies the confirmation policy, including the first-passkey transfer exception (see [auth-identity §8](../auth-identity/README.md)). If a confirmation dialog was needed, it shows "Create the passkey now" — the ceremony needs a click of its own (Safari refuses one after an async dialog). `registerPasskey` enforces this: when getting the options went through the dialog (`stepUpManager.confirmations` changed), it does not start the ceremony and reports `reauthenticated` (also used by the post-login "Add a passkey" offer). Whenever the list is loaded it is reported with `signalAllAcceptedCredentials` (per WebAuthn user handle, `Models.Passkey.Info.userHandle`) and `signalCurrentUserDetails`.

### Other devices (`SignOutOtherDevices`, `SignedOutNotice`, `src/data/auth/signedOut.ts`)

**Settings → Accounts → Sign out other devices** asks first ("Sign out other devices? Every other browser and app signed in to your account is signed out and has to sign in again. This device stays signed in."), then confirms it's you (`ensureRecentAuth`, like removing a passkey) and calls `User/signOutOtherDevices`. What it did shows below the button and as a snackbar: "Signed out 3 other devices." / "Signed out 1 other device." / "No other device was signed in." (`signedOutDevicesText`), or "Other devices will be signed out within a minute." when the server answers `delayed`. A replaced password (`EmailPage`, `EmailEditor`) adds the same sentence from `setPassword`'s `signedOutDevices` to "Password updated"; removing a passkey or an X/LUKSO/Farcaster account says "Your other devices were signed out." (docs/auth-identity §2).

The device that was signed out learns it from the socket event `cliSignedOut`, or — when it was offline or closed — from the `NOT_FOUND` of its device key at the next automatic login. `LoginManager.signedOutElsewhere()` raises `signedOutNotice` and signs out locally (`logout()`); `SignedOutNotice` then shows "You were signed out — Your account was signed out on this device from another device, or its password, email address or sign-in methods were changed there. Sign in again to continue." with **Sign in** (opens the login modal) and **Not now**. A logout in another tab of the same browser (which deletes this device's key as well) shows no notice: the server's `cliSignedOut` reaches the other tabs before that tab is done, so a logging-out tab writes `CG_LOGOUT_IN_PROGRESS` (user, tab, time) to localStorage before its `User/logout`, and a tab that sees it — or a changed stored current user, or the `cg:auth` broadcast — follows that logout without a second `User/logout`. Without any of these the tab re-checks for 1 s (an older page writes no marker) and then decides under the login lock, so of several tabs signed out from elsewhere normally one calls `User/logout` (its marker says `elsewhere`) and the others follow it; each of them shows the notice (localStorage is only eventually consistent across processes, so a second `User/logout` can happen; it is harmless, the session is gone). A tab whose logout never finishes is followed for at most 10 s; then the marker counts as a leftover (that tab closed or reloaded) and the sign-out as one from elsewhere, with the notice. Signing in again — in this tab or in another one this tab takes over — dismisses the notice. While a tab follows another tab's logout, a `LOGIN_REQUIRED` starts no device login. A `cliSignedOut` that arrives while the tab's own logout is in flight is ignored (the server could not tell the requesting socket apart, docs/realtime "Socket-scoped targeting"). In every case — also during that re-check — the device's session and key are gone on the server, so the tab drops the device from its socket at once (`webSocketManager.deviceSignedOut`): the reconnect after the server's disconnect, and any reconnect on a return of the tab, is anonymous, never a socket login with the revoked key; nor does a refresh after a restored live run a device login while the tab is signing out. A socket login answered `ERROR` for a device the socket no longer wants is not reported as an error. A sign-out refers to one device — for `cliSignedOut` (which names none) the one the socket's login was acked for when it arrived, for a `NOT_FOUND` the one that login used — and is ignored when that is no longer the tab's current device (a late event after a switch to another user or device must not end the new session); a `cliSignedOut` during a socket login still waiting for its ack is not acted on either (a device that is really gone shows up at its next HTTP device login).

The X popup page (`/twitter-login`, `TwitterCallbackView`) shows "Too many attempts to connect X from this network. You can try again in …" when `Twitter/startLogin` was refused by its limit (`?error=rate-limited&retryAfter=`).

### Step-up (`src/data/auth/stepUp.ts`, `StepUpProvider`, `ReauthDialog`)

The server answers protected actions (password, email change, passkey add/remove, sign-in wallets, X/LUKSO/Farcaster accounts, bot tokens, …) with `REAUTH_REQUIRED` when the last authentication is older than 5 minutes. `BaseApiConnector` then calls `stepUpManager.request(...)` (also after a `LOGIN_REQUIRED` device re-login — at most one re-login and one step-up per request); `StepUpProvider` shows `ReauthDialog` — "Confirm it's you to {action}" with the account's own methods: a passkey (if the account has one here), the password (hidden once `User/getSecurityStatus` says the account has none; `reauthMethods`, `src/components/organisms/ReauthDialog/reauthMethods.ts`), a sign-in wallet, or an email code to the current verified address when `getSecurityStatus.canReauthenticateWithEmail` is true — and the request is retried once (`User/reauthenticate`). The action text comes from the route (`stepUpRequestForRoute`). The wallet option is hidden while `User/addPreparedWallet` waits (a wallet confirmation would replace the prepared wallet); the settings pages that add a sign-in wallet therefore call `useStepUp().ensureRecentAuth(...)` before the wallet signature. `stepUpManager` tracks a client-side freshness estimate (interactive login, `createUser`, `reauthenticate`) so screens can confirm before starting a WebAuthn ceremony. A cancelled dialog surfaces as `REAUTH_REQUIRED`, which `securityActionErrorMessage` (`src/data/auth/authErrors.ts`) maps to "show nothing".

### Transfer links (`/transfer`, `TransferView`)

A link from another instance (`/transfer#<token>`, [auth-identity §11](../auth-identity/README.md#11-transfer-links-and-the-account-security-step)).
`captureTransferToken()` (`src/data/auth/transferToken.ts`) runs at the top of `src/index.tsx`,
before the app loads anything: it takes the token out of the address bar (`history.replaceState`)
and keeps it in memory only — a reload drops it. `TransferView` (outside the layouts, like `/login`)
shows the account the link signs in to (`User/previewTransferLink`: display name, profile image —
`Jdenticon` when there is none — and a unique identifier, `transferIdentityText`
(`src/views/TransferView/transferIdentity.ts`): `@<cg name>`, else `X @<handle>`,
`Farcaster @<username>` or `Universal Profile <address>`, else the start of the account id) and asks
"Continue as …?"; if another account is signed in, it says that continuing signs it out, and does
so (`loginManager.logout()`) before `loginManager.redeemTransferLink(token)`. Then it goes to the
link's `nextPath` (`safeNextPath`) or home. "This isn't me" uses the link (and the account's other unused links) up on the server
(`User/declineTransferLink`, fire and forget) and leaves; the same account already signed in just
continues.

### The gateway page (`GatewayView`)

On a gateway ([auth-identity §12](../auth-identity/README.md#12-gateway-mode)) the instance config
carries `gatewayTargetUrl` (`isGatewayInstance()`, `src/common/gateway.ts`). The data layer then
keeps no local data of its own, leaves the data an old page of the app stored on that origin as it
is, and has no realtime connection, at these choke points:

- **No data socket**: `WebSocketManager.createSocket` (`src/data/appstate/webSocket.ts`), the only
  place the socket is created, returns early. Without a socket there is no socket login and no
  `onLive`/`onResume`, so neither the chat stores' catch-up (`getSyncState`, `getChanges`, the
  notification resync) nor the snapshot refresh after a reconnect ever runs. The transport's
  session keepalive (`User/ensureSession`) stays.
- **No setup after a login**: `setupAfterLogin` and the take-over of another tab's login
  (`takeOverSession`) in `src/data/appstate/login.ts` return after the login state — no entity
  snapshots in IndexedDB, no own wallets, no chat stores, no unread count, no socket login, no push
  subscription.
- **No chat stores**: `data.channelManager` (`src/data/databases/channel.ts`) neither starts the
  chat runtime nor passes anything from the entity databases on to it, so the stores are never
  created.
- **Entity databases never opened**: `AbstractDatabase` (`src/data/databases/abstractDatabase.ts`;
  community, chat, user, signed URLs) constructs its Dexie with `autoOpen: false` and does nothing
  else — no schema, no version-upgrade clear, no entry in `CG_KNOWN_INDEXEDDBS` (`dbTracker`), no
  socket event handlers — and the subclasses skip their start-up work (reading the stored chats,
  channels and calls; deleting stale signed URLs) when `localData` is false. Any other access to
  such a database fails (no tables are declared, and the database never opens by itself) instead
  of reading, writing or deleting. `uniques` is not registered in `CG_KNOWN_INDEXEDDBS` either.
- **No clearing**: the logout's `_clear` (also after a failed automatic sign-in or a sign-out from
  elsewhere) clears none of these databases, and the ConnectionManager does not schedule the
  obsolete-database cleanup (`cleanUpIndexedDbs`).

What a gateway page does touch is the sign-in state, as on any instance: the device keys (read for
the automatic sign-in, a new one stored by a sign-in, the device's key deleted by a sign-out),
`CG_CURRENT_USER`, and — when no `CG_CURRENT_USER` names the device (a browser of an old page) —
a read of the stored account (`uniques` `OwnData`) to find which device key to sign in with.
`src/data/databases/gatewayLocalData.test.ts` opens the real database modules on a fake IndexedDB
holding an old page's data and checks that a gateway page neither opens, registers nor changes it.

The first socket connect normally starts the page's device login (ConnectionManager); on a gateway
`GatewayView` starts the automatic device-key sign-in itself. The CG ID popup's result comes over a
minimal socket of its own (`src/views/GatewayView/cgIdResultSocket.ts`, used by
`LegacyCgIdPasskey` on a gateway) or the popup's `postMessage`. No connection indicator is mounted.
`App` renders `GatewayInner` instead of the app: only the providers the sign-in methods need
(wagmi/RainbowKit, Farcaster AuthKit, window size, snackbar, passkeys incl. the legacy CG ID popup,
recovery phrase, LUKSO, X — no own-data provider) and two routes — the X popup's
`twitter-login` page and `GatewayView` for every other path. Signed out, `GatewayView` says "Common
Ground has moved to <host>" and shows `AuthFlow` with `allowSignup={false}` (no "Create an account";
the flow machine ignores `SHOW_SIGNUP` with `signup: false`). After a sign-in with a sign-in method
in this tab (`loginManager.signedInInThisTab`: password, code, passkey, wallet, … — set with the
login state) it continues by itself; a page that opens signed in (device key) and a tab that took
over another tab's sign-in (`takeOverSession`) show "Continue to <host>" and "Sign out". Continuing calls `User/createTransferLink` with the path the page was opened with
(`nextPath`, `safeNextPath`; not `/` or `/login`) through its own connector
(`src/views/GatewayView/gatewayApi.ts`, a `BaseApiConnector` for `User`) and opens the link, which
the new instance's `TransferView` redeems.

The Farcaster sign-in sends `window.location.host` as the SIWE domain (the server checks domain and
URI against its own origin, [auth-identity §5.8](../auth-identity/README.md#58-farcaster-type-farcaster)).

### Service worker on a gateway

The old app on the gateway's domain registered its worker at `/service-worker.js` with scope `/`
(`ServiceWorkerManager`, `src/data/appstate/serviceWorker.ts`; the only URL it ever used — the
production build of app.cg serves its Workbox worker there, registered by
`navigator.serviceWorker.register("/service-worker.js",{scope:"/"})`, checked against the live site
on 2026-11-07). That worker precached the old app and answered every navigation with the cached
shell (`createHandlerBoundToURL`), so a browser that has it — an installed app above all — would
keep starting the old app from Cache Storage on the gateway's domain.

The gateway's site therefore serves a different file at that URL:
`docker/caddy/gateway-service-worker.js`, copied into the Caddy image as
`/etc/caddy/gateway/service-worker.js` and served only by `cg_gateway_app` (`common.caddy`) with
`Cache-Control: no-cache` and `text/javascript`. The build's own worker (`build/service-worker.js`,
in `/srv`) is never served there; the main instance keeps serving its own worker, unchanged. The
replacement is a few lines of plain JavaScript without imports or build step:

- `install`: `skipWaiting()` — it replaces the old worker at once, with old pages still open.
- `activate`: lists the window clients the registration already controls (the pages of the
  previous worker), deletes every Cache Storage cache of the origin (the old precache), calls
  `clients.claim()` and navigates each of those pages to its own URL (if `navigate()` is missing or
  refused, it posts `{action:'reload'}`, on which the old app reloads itself). Pages that no worker
  controlled are not reloaded. The navigations are started but not awaited: a navigation of a page
  the worker controls waits until the worker is activated, so awaiting it inside `activate` holds
  both up and freezes the page (measured with Chrome 151 in the e2e flow).
- no `fetch` handler: from then on every request goes to the network, so the reloaded pages get the
  gateway page with the path they were on, and `GatewayView` takes that path along.
- `push` / `notificationclick`: a push in the old app's format (`{action:'new', data}` with
  `extraData.type: 'generalData'`) shows its title and text, anything else a fixed "Common Ground
  has moved" notice; a click opens the given path on the gateway's own origin (else `/`). This keeps
  old push subscriptions usable for a one-off notice after the worker was replaced.
- IndexedDB and localStorage stay as they are: the gateway signs in with the device key stored
  there.

How an old installation gets it: every navigation in the worker's scope runs an update check
(soft update), and the old app calls `registration.update()` every 30 s (every 3 s while an update
is in progress); both fetch the script past the HTTP cache (the default `updateViaCache:
'imports'`). A `register()` with the unchanged URL by itself checks nothing. So the first start
after the domain points at the gateway installs the replacement, which reloads the page into the
gateway.

No loop: the gateway page is the same web app, so its `ServiceWorkerManager` registers
`/service-worker.js` as well — on the gateway that is the replacement itself. On a first visit that
installs it once: the page that registered it was not controlled, so it is not reloaded; afterwards
the script is byte-identical and nothing is installed again. The gateway therefore never has the
app's precaching worker, and no worker caches anything there. `VERSION` in the file changes with
every change to it (a changed file is installed once more and reloads the pages it controls once).

`src/gatewayServiceWorker.test.ts` runs the file in a fake worker scope; the e2e `gateway` flow
checks the served headers and replaces a stand-in for the old worker in Chrome (e2e/README.md). The
procedure for a browser with the real old app installed is in
[docs/deployment §3.13](../deployment/README.md#313-the-gateway-of-a-moved-instance).

### Account-security step (`SecurityStepView`, `SecurityStep`)

`securityStepState` (`src/data/auth/securityStep.ts`, `useSecurityStepRequired`) is set from the
login response's `securityStepRequired` and by `BaseApiConnector` on `SECURITY_STEP_REQUIRED`, and
remembered per account in `localStorage` (`CG_SECURITY_STEP`): after a reload it is known before the
automatic re-login answers, so the normal app never mounts first (`showSecurityStep`, unit-tested).
While it is set and the user is signed in or being signed in again, `RoutedContent` renders `SecurityStepView` on every
route except `/login`, `/transfer`, `/verify-email` and `/twitter-login`; the realtime login and
the push subscription are skipped. `Home` no longer sends confirmation mails or opens the
newsletter-confirmation modal on its own (the step owns the address; only a legacy CG ID instance
keeps that behaviour), the modal is never shown over the step, and a loader whose request is refused
with `SECURITY_STEP_REQUIRED` is no page error (a global `unhandledrejection` filter in
`src/index.tsx`). The organism `SecurityStep` (AuthFlow building blocks and
styles) loads `User/getSecurityStatus` and asks, in this order: confirm an email address (code,
`requestEmailVerification`, then the `EmailCodeConfirm` molecule → `verifyEmail`), choose a new password (when the old one is below the
policy — the server's step-up asks for the current one first), set up how to sign in (create a
passkey, use a password, or use a wallet — a new wallet is added as a sign-in wallet, an already
linked one gets sign-in switched on). "Sign out" is always there. If the account has no sign-in method
here and the session's sign-in is older than an hour (`recentSignIn: false`), the step instead asks
to sign out and sign in again, or to get a new link from the old site. A socket login refused with
`SECURITY_STEP_REQUIRED` also switches the app to the step. When nothing is missing any more, the
page reloads, so the app starts normally.

### Email address changes

With mail (`features.email`), settings (`EmailPage`, `EmailEditor`), the newsletter prompt
(`EmailConfirmationModal`) and the onboarding newsletter step (`Splash`) no longer write `email`
through `updateOwnData`: they call `User/requestEmailVerification` and then show the
`EmailCodeConfirm` molecule (`src/components/molecules/EmailCodeConfirm/`, also used by the security
step) for the code; the address changes once the code or the link comes back. `/verify-email`
(`VerifyEmailView`) waits for the automatic sign-in and then confirms with the link's code while
signed in to that account; signed out it offers "Sign in" (`/login?next=…`). Without mail the old
direct update stays.

An address that was never confirmed gets "Send confirmation again" (with a 60-second countdown,
or the server's wait after a refusal) in the settings email page (`ConfirmEmailAgain` molecule,
then the code field), in the account-security step and in the newsletter prompt — always for the
signed-in account only. The login form's code step tells logged-out users that codes only go to
confirmed addresses and how to get theirs confirmed.

### Limits and input checks

Decision 21 of the cg.box roadmap: nobody who makes a mistake is locked out, and every limit
message says when it works again and what else the person can do now.

- **Wait.** `BaseApiConnector` throws `ApiRequestError` (`src/data/api/apiError.ts`): the message is
  the server code as before, plus `retryAfterSeconds` and `limit` (`accounts` / `mail` /
  `attempts`, `limitKindOf`) from the envelope
  ([auth-identity §4 "Limits"](../auth-identity/README.md#limits)). `rateLimitMessage(e, { what,
  alternative })` (`src/data/auth/authErrors.ts`) turns it into "What happened. You can try again
  in 4 minutes / at 15:01 / tomorrow at 09:30. Alternative." (`formatRetryAfter`; clock times in the
  browser's locale, the words are English — the app has no translations). `securityActionErrorMessage`
  uses it, so the settings and the account-security step show the wait, too.
- **Alternatives** per place: password login → a code by email, a passkey or a wallet; code login
  → the last code, the password or a passkey; sign-up code request and "Send a new code" → for
  `limit: accounts` the account message below, otherwise another network (mobile data) or "Log
  in instead"; account creation refused at the end (`accountLimitMessage`,
  `authFlowMachine.ts`) → the time, another network, "Log in instead"; transfer links → logging in
  directly.
- **"Send again" countdowns** (`useCooldown` / `cooldownLabel`, `src/hooks/useCooldown.ts`): the
  sign-up code, the login code, "Send confirmation again" and the account-security step's code
  count down `EMAIL_CODE_RESEND_SECONDS` (60, the server's per-address minute, shared in
  `src/common/authInputRules.ts`) after a send and the server's `retryAfterSeconds` after a
  refusal; the button is disabled meanwhile ("Send a new code (42 s)"). The countdown is kept per
  address across steps, so going back and forth does not re-enable it.
- **Codes.** The forms count wrong guesses of the current code (the server allows
  `EMAIL_CODE_GUESSES` = 5, the same for an address that got no code, so nothing leaks): "2 tries
  left", then "send a new one" without another request; only wrong or expired codes count, not
  network or server errors. Going back from the sign-up code step with the same address reuses the
  code mailed in the last 10 minutes (no second mail, no captcha) — unless a code check failed or
  the server asked for the captcha again; then "Continue" requests a new code with the captcha.
- **Input checks before anything is sent**, with the server's rules (shared constants in
  `src/common/authInputRules.ts` and `passwordPolicy.ts`, used by `srv/validators` as well): email
  format (`validateEmailInput`), the username rule on sign-up and on the login identifier
  (`identifierProblem`, `src/data/auth/loginInput.ts`: an email address or a username), 8-digit
  codes (spaces and dashes dropped, `inputMode="numeric"`), passwords of at least 8 characters on
  sign-up.
- After the second wrong password the login form points to "Email me a code instead".

### Plugin origin guard

`IframePluginPortal` does not render a plugin whose URL is on this instance's host, the passkey RP ID or a subdomain of either (`src/data/auth/pluginOrigin.ts`; not enforced in dev, like the server-side check in `srv/validators/api/plugin.ts`).

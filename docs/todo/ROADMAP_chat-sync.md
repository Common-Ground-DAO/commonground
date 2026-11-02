# Roadmap: chat sync — replace the chunked client cache and the tab/socket hand-off

> Replaces the client-side message/notification cache (`ChunkedItemDatabase` in
> `src/data/databases/channel/`) and the service-worker-refereed "one active tab
> owns the socket" scheme with a simpler model whose correctness does not depend
> on cross-tab coordination. Living document; delete it when P5 is merged and the
> lasting insights are in `docs/frontend` and `docs/realtime`.
>
> Works on the integration branch `feature/chat-sync`; nothing reaches `develop`
> until the whole package is reviewed and accepted. Independent of the cg.box
> move (`ROADMAP_cg-box.md`): if it is not finished by the dress rehearsal, the
> move goes ahead without it (and the hotfixes under "Fallback" go into
> `develop` instead). G6 of the cg.box roadmap (the replacement service worker
> on app.cg) waits for this package.

## Why

The current cache (~2,300 lines: `chunkedDatabase.ts`, `chunkedDatabase.helpers.ts`,
`itemList.ts`, plus the chunk parts of `channel.ts`) keeps a linked list of chunks
per channel in IndexedDB and syncs it between tabs over BroadcastChannel and Web
Locks. An analysis on 2026-11-02 reproduced its main defects against the real code
(Dexie + fake-indexeddb):

- **B1** an empty "complete" server page that arrives after a live message deletes
  that message (first message in a call chat missing until refresh);
- **B2** after a reconnect the open list stops showing new messages;
- **B3** one missed cross-tab broadcast leaves inconsistent chunk links; the
  channel stays empty for good and nothing repairs it (the version-based clear
  never fires, `APP_VERSION` never changes);
- **B4** the notifications flush waits 5–10 s on every page load and races a 7 s
  login timeout;
- **B5–B8** stale snapshots overwrite newer local state; edits/deletes during a
  disconnect are never fetched; one failing job rejects its whole batch; a
  successful edit stays `sendStatus: "sending"`;
- plus unbounded storage, production debug logging, partial logout cleanup.

Related symptoms outside the component: a tab that never gets a role from the
service worker stays "Disconnected" (no fallback when the worker doesn't answer);
the socket state freezes after a `version-update`; marking as read is
edge-triggered (once per message when it scrolls into view) and dropped before
login; the notification unread counter is a per-tab `++/--` counter that drifts.

The cross-tab chunk protocol is the source of the worst failures, and it serves a
need that no longer exists: background tabs only have to be correct when they
become visible, not live.

Not in this package (fixed on `develop` as G13 of the cg.box roadmap): the
`…/undefined` image requests, calls that are never ended, the server-side
monotonic last-read time, two call SQL/time bugs. Merge `develop` in when G13
lands.

## Decisions

1. **Replace, don't repair** the chunked cache (2026-11-02, maintainer). Fixing in
   place was estimated at 3–4 weeks with high risk.
2. **Research and design first (Phase 0), with a maintainer gate** before any
   implementation. The design decides the tab/socket model (see below).
3. **Server is the source of truth** for messages, read state and unread counts;
   the client cache is an optimisation that may be dropped at any time.
4. **Backend changes are allowed if additive** (new endpoints/fields/events);
   existing API contracts keep working for old clients during a deploy.
5. **Delivery:** a coordinator session on `feature/chat-sync`, sub-tasks in
   parallel worktrees branched from it; one review + acceptance of the whole
   package before it is merged into `develop`.

## Tab and socket model (settled in Phase 0, see Design)

Requirements the model must meet, whatever it is:

- Split view: two visible tabs side by side both stay live.
- Background tabs: timers are throttled (≈1/s hidden, ≈1/min after ~5 min
  hidden and silent); incoming WebSocket events are not, but browsers may
  **freeze or discard** hidden tabs (Android, energy saver, iOS) — a frozen tab
  processes nothing and may still hold locks.
- No event may be lost or applied twice in a way the user can see; every
  server write the client makes is idempotent or monotonic.
- Reconnects (network loss, sleep, mobile background) recover without reload.
- Exactly one tab plays notification sounds / shows desktop notifications.
- Multiple devices of the same user behave like multiple tabs.
- Online presence counts users, not sockets.

Candidates:

- **(a) Independent tabs + catch-up** (preferred going in): every visible tab
  holds its own socket and its own in-memory state; a hidden tab may close its
  socket after a while and catches up on becoming visible ("everything since
  cursor X"). No hand-off, no shared state; only side effects that must happen
  once (sounds, desktop notifications, optional IndexedDB writes) use a Web
  Lock. Cost: one connection per open tab.
- **(b) Leader tab via Web Locks**, events relayed to other tabs over
  BroadcastChannel (today's model with Web Locks instead of the service worker
  as referee).
- **(c) Server-mediated takeover:** a newly active tab claims the session, the
  server moves the event stream to it and disconnects the old one. Still needs
  catch-up for the tab that lost the stream; split view needs a rule.
- **(d) SharedWorker** holding one socket for all tabs (not available on
  Chrome for Android; at most a supplement).

Whatever is chosen, a reliable catch-up ("since cursor X") is required — it is
what makes reconnects correct.

## Design (Phase 0, approved by the maintainer 2026-11-02)

Evidence: four research reports (browser behaviour, server, client transport,
client data layer) kept outside the repo with the coordinator's notes; the
claims below that matter were checked against code at `d718c0a`. Numbers in
brackets refer to the decisions list at the end of this section.

### Findings that shape the design

- **Browsers:** Chrome closes every open WebSocket when a page is frozen, not
  only on bfcache; Chrome Android freezes every hidden tab after about 1 min;
  iOS suspends a backgrounded tab almost at once; Firefox never freezes. A
  frozen tab keeps its Web Locks, so a lock alone is not a safe leader
  election; `steal` works but the old holder keeps running. SharedWorker is
  not on the browser floor (Safari 16, Chrome Android 148). Socket.IO
  connection state recovery is not supported by the classic Redis adapter in
  use and does not cover reloads or new tabs. Every model therefore ends up in
  "socket gone → reconnect → catch up"; only (a) needs nothing else.
- **There are no in-tab sounds or desktop notifications today.** Desktop
  notifications come only from Web Push in the service worker; the only sounds
  are call sounds in the tab that is in the call. "Exactly one tab alerts"
  holds already and needs no election.
- **The socket counts as connected too early:** `state='connected'` and
  `cliConnectionEstablished/Restored` fire before the socket login ack; events
  emitted between `connect` and the login ack (room join) are lost on the
  server, nothing buffers them.
- **Every reconnect runs a full device login and `setupAfterLogin`** in the
  active tab — today's only catch-up for community/chat/user data, and a
  source of stale snapshots overwriting newer local state.
- **Server delivery:** create/edit (and chat start/close, community
  join/create/pin) exclude the sender's whole *device* room, so other tabs of
  the same browser never get the sender's own message live; article rooms are
  joined per device. Call-chat messages go only to role rooms, and nobody joins
  a Public role room, so users who can see a call only through Public get no
  live call chat (another cause of the "first call-chat message" symptom).
- **Server data:** timestamps come from the DB clock; deletes are soft;
  `messages` has `UNIQUE(channelId, createdAt)` (so equal-`createdAt` paging,
  B15, cannot happen for messages); `createMessage` is a plain INSERT, not
  idempotent; `markAsRead` emits an update even when already read; counts come
  back as strings. A cursor on `updatedAt` is not exact: commit order is not
  timestamp order and lock waits are unbounded.
- **Presence** is one column per user, flipped to offline when the user's last
  socket on a wsapi process disconnects; every flip is broadcast to all the
  user's communities. A hidden tab that drops and re-opens the user's only
  socket would make the status flap.
- **Shared Dexie entity DBs** (community, chats, user) have non-idempotent or
  order-unsafe writers: `unread++` on every new message, `plugins.push` without
  id check, plain `update()` calls that let an older event overwrite newer
  data. Today only the active tab writes; with independent tabs every tab does.
- **UI data layer:** the UI touches the chunked cache only through
  `channelManager` → `createItemList` (two importers); error states of failed
  sends are never rendered (memo keyed on `updatedAt`) and there is no retry
  UI; `PinnedMessage` likely misses on the first visit of a channel
  (TODO(verify)); `CommentList` has a DESC+`createdAfter` branch the data layer
  rejects; the legacy `messages.ts` is dead but opens an IndexedDB on import.
  vitest already exists (node environment).

### Tab and socket model: independent tabs + catch-up (candidate a) [1]

- Every tab owns its socket, its login state and its in-memory message state.
  No roles, no relay, no tab-state BroadcastChannel, no service-worker referee.
- **Visible tabs are always connected** (split view works by construction).
- **Hidden tabs** keep their socket for 5 min, then disconnect — unless the tab
  is in a call (the call keeps the socket, as today). On `freeze` and
  `pagehide` the tab closes its socket itself. Hidden tabs never reconnect on
  a timer; Android/iOS kill hidden sockets anyway.
- **Catch-up triggers** (all go through one debounced `resync`): socket login
  ack after (re)connect; becoming visible with the socket down or after the
  hidden threshold; `pageshow` with `persisted`; `resume`; `online`; a sequence
  gap seen in a live event. Catch-up never plays sounds or alerts.
- **"Live" means logged in and rooms joined:** `cliConnectionEstablished` /
  `Restored` fire only after the socket login ack. `version-update` becomes a
  separate `updateAvailable` flag instead of a terminal socket state.
- **Reconnect ≠ device login:** a reconnect does the socket login only, then
  catch-up; the HTTP device login runs once per page load. Concurrent HTTP
  logins of several tabs are serialised with a Web Lock (`cg:login`), because
  an anonymous→user login regenerates the session id. This is the only Web
  Lock in the design; nothing waits on it beyond a login request.
- **Logout** is broadcast to all tabs (BroadcastChannel + the existing
  `storage` event as fallback); each tab drops its socket and memory.
- **Cost:** one socket per open, non-idle tab. Browsers allow 200–255 per host;
  each tab login costs ~5 DB queries on the server.

### Catch-up protocol [2]

- **Cursor = per-channel commit-ordered sequence.** A `BEFORE INSERT OR UPDATE`
  trigger on `messages` upserts `channel_sync_state(channelId, seq)` and writes
  the new value into `messages.syncSeq`. The row lock serialises writers per
  channel until commit, so commit order equals seq order: no clock, no overlap
  window, tombstones (soft deletes are updates) included, and writes by old API
  processes during a deploy are covered. Cursor on the wire: opaque string
  `"1:<seq>"`. Fallback if the trigger is rejected: `updatedAt` cursor returned
  by the server, 60 s overlap, `(updatedAt, id)` paging, dedupe.
- **`POST /Message/getChanges {access, cursor|null, limit≤200}`** →
  `{cursor, reset, hasMore, serverTime, messages(+syncSeq), deletedIds}`. A null
  or too-old cursor (>500 behind) returns `reset: true` with the latest page and
  the cursor taken in the same statement.
- **`POST /Message/getSyncState {channelIds?}`** → per readable channel/DM
  `{channelId, communityId|chatId, syncSeq, lastMessageDate, lastRead, unread
  (capped)}` plus `notificationUnreadCount`. Read-only (unlike
  `getOwnCommunities`/`getChats`, which write missing read-state rows).
- **Events:** `cliMessageEvent` gains `syncSeq` (new/update/delete).
- **Client order after login ack:** `getSyncState` + `getChanges` for every open
  window; live events that arrive meanwhile are applied too.
- **Merge rule:** a message is replaced only by a version with a higher
  `syncSeq` (state, not deltas). A `reset` replaces the window but keeps local
  items whose `syncSeq` is above the reset cursor and pending own sends. A
  server page is authoritative only for its own range, so a snapshot can never
  delete a newer live item (B1 impossible by construction).
- **Gaps:** a live event with `syncSeq > cursor + 1` schedules a debounced
  `getChanges`. A cached channel that is re-opened catches up from its cursor.
- **Entity data** (communities, chats, user): on reconnect the existing data
  refresh of `setupAfterLogin` still runs (it is the only catch-up for those),
  but every merge becomes monotonic (see [5]). No new protocol for them in this
  package.

### Server changes (all additive) [3]

- Sync sequence: migration (table `channel_sync_state` with GRANTs, nullable
  `messages.syncSeq`, index `(channelId, syncSeq)`, trigger), `syncSeq` in
  events; `getChanges`; `getSyncState`.
  - The trigger runs as the `writer` role the app processes use: check owner
    and privileges; `SECURITY DEFINER` only if really needed, then with a fixed
    `search_path` (as `session_generation_of` from cg.box G12).
  - The migration runs on the real production dump during the cg.box move
    (G5 import, then the develop migrations), so it must stay cheap on a large
    `messages` table: nullable column without default and without backfill
    (existing rows get a seq on their next write; a `null` cursor means
    `reset`), and the index build time checked. Its runtime is measured in
    the dress rehearsal.
- `setChannelLastRead`: clamp to server `now()`, `GREATEST` and echoing the
  stored value in `cliChannelLastRead` arrive with develop's G13; this package
  adds `unread` to the response and the event, and an optional `messageId`
  field (the server uses its `createdAt`).
- Notifications: mark read only when unread, emit only on a real change,
  `markAllAsRead` only unread rows, `unreadCount` as a number in every
  notification event and in the login response.
- `createMessage` idempotent on the client UUID (`ON CONFLICT (id) DO NOTHING`;
  a retry by the same creator returns the stored message without events or
  notifications); one retry on the `(channelId, createdAt)` collision.
- Socket-scoped targeting: new clients send `x-cg-socket-id`; the server then
  excludes only that socket (instead of the device) and joins/leaves article
  rooms per socket. Without the header, today's device behaviour stays for old
  clients. The header name is fixed: the cg.box G1 gateway adds it to its
  CORS/origin allowlist, so a rename must be reported to the main line.
- Call chat and `cliCallEvent new` additionally reach the call's active members.
- Presence: grace period (30 s) before going offline on the last disconnect,
  checked cluster-wide; `cliUserOwnData` only on a real change.
- Bots: unaffected (fixed route allowlist; added event fields are compatible
  with `docs/BOT-API.md`).

### Messages in the client [4]

- A `ChannelStore` (keeps the name `data.channelManager`) with ref-counted
  `ChannelWindow`s that keep the `ItemListState` shape. Per channel: a bounded
  contiguous "latest" segment (≤200), detached segments for jumps (merged when
  they meet), pending sends, tombstones, a loose map for reply parents and
  pins (works without an open window). LRU of 20 channels per tab, memory only.
- Listeners get `(state, change)` with `change.kind` in `reset | prepend |
  append-page | append-live | update | trim`, so the list sets its scroll lock
  before rendering.
- Send: the pending item is inserted synchronously before the API call;
  failures render as an error with retry/discard (the memo fix); retry reuses
  the UUID (idempotent server create). Edit success clears `sendStatus` (B8).
- The core is pure TypeScript with injected API and event source, tested
  against a scripted fake server.

### Read state [5]

- One `ReadStateStore` for channels and DMs; `lastRead` is merged by `max` from
  every source (events, snapshots, own marks). A snapshot's `unread` is trusted
  only when its `lastRead` is at least the local one.
- **Level-triggered marking:** while a window is at the latest segment, scrolled
  to the bottom, the document visible and the user logged in, the client marks
  read up to the `createdAt` of the newest server message received. Re-evaluated
  on every change of these inputs; deferred until login instead of dropped;
  retried on failure. No IntersectionObserver edge, no dependency on rendering.
- **Unread counts for non-open channels:** start from the `getSyncState`
  snapshot at seq S; a live `new` event (not own, newer than `lastRead`) counts
  only if its `syncSeq` is above the channel's stored seq, updated in the same
  Dexie transaction — idempotent when several tabs process the same event.
- All other Dexie entity writers become idempotent or `updatedAt`-guarded
  (plugins by id, guarded `update()`s, monotonic `lastMessageDate`).

### Notifications [6]

- A `NotificationStore` in memory + server: the first page on opening the list
  and on resync, live `new/update/delete/allread` events applied idempotently.
- The unread count comes from the server: login response, `unreadCount` in each
  event, `getUnreadCount` on resync. No `++/--` counter, no 7 s setup, no
  clear-and-retry; `markAsRead` is called once per interaction and is a no-op
  for read items.

### Persistence [7]

- None for messages and notifications in this package (option D). Message
  history needs a round trip after reload; measured by E7.
- P4 (latest-N snapshot per channel in IndexedDB) is decided after E7 numbers;
  it would be a pure add-on with a single writer per transaction, LRU,
  whole-store wipe on logout and a cache-schema constant.
- The community/chats/user Dexie DBs stay as they are (not part of the cache
  being replaced), with the idempotent writers from [5].

### Migration and deploy [8]

- On startup the new client deletes `commonGroundDB_chunked_databases` and
  `commonGroundDB_messages` (no data to migrate; the server is the source of
  truth) — independent of any tab role.
- Service worker: the role referee is removed (heartbeats, bans, tab states);
  precache, push, `notificationclick`, update/activate-reload, instance config
  stay. For one release the new worker answers an old page's `tabState`
  message with `active`, so old pages still open after the update connect
  instead of showing "Disconnected" until they reload.
- New client against an old server (short window during a deploy): a missing
  `getChanges`/`getSyncState` (404) falls back to `loadMessages` and the
  existing snapshot paths.

### Test strategy [9]

- **Unit (vitest, node):** store core against a scripted fake server —
  snapshot vs live, reset vs live, out-of-order and duplicate events, gaps,
  tombstones, pending sends, jumps; read-state merges; notification counts;
  Dexie entity writers with two Dexie instances on one fake-indexeddb
  (cross-tab idempotency; `fake-indexeddb` as a dev dependency, age gate
  checked); transport state machine with a fake socket.
- **Server (jest):** a real-PostgreSQL spec (opt-in `CG_TEST_PG_HOST`) for the
  trigger's commit order under concurrent writers, plus specs for
  `getChanges`, `getSyncState`, idempotent create, read state, notifications.
- **e2e:** E1–E8 (below) written first and red where today's code is buggy; a
  same-user multi-tab harness helper; CDP for offline, response delays, clock
  offset, `Page.setWebLifecycleState frozen`, stopping the service worker; a
  new reload mode with a cold service worker that fails on `hidden`.

### Work breakdown [10]

Each slice runs in its own worktree on `chat-sync/<slice>`, gets an
independent review, and is merged into `feature/chat-sync`. File ownership is
exclusive within a wave.

| Wave | Slice | Owns | Content |
|---|---|---|---|
| 0 | **contracts** | `src/data/chat/types.ts`, transport contract types, new API/event types in `srv/common/types/` | interfaces from [2], [4]–[6]; compiles, no behaviour |
| 0 | **test-infra** | `package.json` (dev deps), `vitest.config.ts`, `src/test/**`, `e2e/src/lib/harness.ts` + CDP helpers | data test project, fake socket, multi-tab helper |
| 1 | **srv-sync** | `srv/api/messages.ts`, `srv/repositories/messages.ts`, migrations, `srv/entities/{messages,channel-sync-state}.ts`, validators | sync seq, `getChanges`, idempotent create, read-state hardening |
| 1 | **srv-state** | new `srv/repositories/syncState.ts` + route, `srv/api/notifications.ts`, `srv/repositories/notifications.ts`, login count cast | `getSyncState`, notifications |
| 1 | **srv-presence** | `srv/wsapi.ts`, new `srv/util/presence.ts`, presence parts of `srv/repositories/users.ts` | grace period, change-only own-data events |
| 1 | **store-core** | new `src/data/chat/**` | `ChannelStore`, `ChannelWindow`, `ReadStateStore`, `NotificationStore` cores + unit tests |
| 1 | **transport** | `webSocket.ts`, `connection.ts`, `login.ts`, `baseConnector.ts`, connection UI, call hold in `CallProvider` | model [1], live signal, login lock, logout broadcast |
| 1 | **sw** | `src/service-worker.ts`, `src/data/appstate/serviceWorker.ts` | remove the referee, compat answer, dead `CHANNEL_VISITED` path |
| 1 | **entity-dbs** | `community.ts`, `chats.ts`, `user.ts`, `abstractDatabase.ts`, `typing.ts` | idempotent/guarded writers, read-state merge, seq-guarded unread |
| 1 | **e2e** | new flows in `e2e/src/flows/`, reload mode | E1–E8, red first |
| 2 | **srv-targeting** | `srv/repositories/event.ts`, exclusion sites in `srv/api/{messages,chats,community}.ts`, `srv/repositories/calls.ts` | socket-scoped echo, article rooms, call-chat delivery |
| 2 | **messages-ui** | `channel.ts` (rewrite), `data/index.ts`, `GenericMessageList`, `ScrollingMessageList`, `CommentList`, `MessageViewInner`, `Message`, `MessageBodyRenderer`, `TextChannel`, `CallPage`, `ArticleCommentSection`, read-marking hook | wire the store into the UI, scroll locks, retry UI |
| 2 | **notifications-ui** | `notification.ts`, `NotificationsBrowser`, `NotificationProvider`, `MenuButton` | wire `NotificationStore` |
| 3 | **removal** | old cache files, `messages.ts`, `dbTracker.ts`, docs | delete code and stores, `docs/frontend` + `docs/realtime` |

Order inside wave 1 where files meet: `srv-sync` before `srv-targeting`
(same `srv/api/messages.ts`); `transport` and `sw` agree on the compat message
through the contracts slice.

Ordering with develop's G13 (runtime fixes; touches `setChannelLastRead`, the
`lastRead` upserts in `communities.ts`/`chats.ts`, `srv/repositories/calls.ts`,
`e2e/src/lib/harness.ts`, `07-call.ts`, ~21 components via a new
`src/util/cssBackground.ts`, and adds a migration): `develop` is merged into
`feature/chat-sync` as soon as G13 lands there, and `srv-sync`, `srv-targeting`
and the harness part of `test-infra` start only after that merge. Contracts,
store core, transport, sw, entity-dbs, srv-state, srv-presence and the e2e
flows (outside `07-call.ts`) can start before.

### Decisions for approval

1. Tab model: independent tabs + catch-up; hidden tabs disconnect after 5 min
   (not in a call), and on `freeze`/`pagehide`.
2. Catch-up cursor: per-channel `syncSeq` set by a DB trigger (fallback:
   `updatedAt` + overlap).
3. Server additions as listed, including presence grace and socket-scoped
   targeting via `x-cg-socket-id`.
4. Messages: in-memory `ChannelStore` with ref-counted windows, `ItemListState`
   kept.
5. Read state: max-merge, level-triggered marking, seq-guarded unread counts.
6. Notifications: memory + server count.
7. No message persistence in this package; P4 only after E7 numbers.
8. Migration: old stores deleted on startup; service-worker referee removed
   with a one-release compat answer.
9. Test strategy as above.
10. Work breakdown in four waves, as above.
11. No notifier election and no in-tab alerts in this package (push stays the
    only alert path); the browser research's election recipe is kept for a
    later feature that adds in-tab sounds.

## Phases

- [x] **Phase 0 — Research and design.** Approved 2026-11-02 (Design section above). A "Design" section in this file:
  requirements above checked against the codebase (`webSocket.ts`,
  `service-worker.ts` role assignment, `channel.ts`, `community.ts`,
  `chats.ts`, `notification.ts`, `GenericMessageList` and friends, `srv/`
  socket/presence/memberlist), the tab/socket model with rationale, the
  catch-up protocol (cursor type, gaps, ordering, clock independence),
  read-state model, notification model, what persists (if anything),
  migration (old IndexedDB stores deleted), test strategy, work breakdown for
  parallel execution. **Gate: maintainer approval.**
- [ ] **P0 — Tests first.** vitest project for the data layer (fake-indexeddb,
  Node `navigator.locks`, global `BroadcastChannel`); characterization tests of
  today's behaviour where useful; e2e scenarios E1–E8 (below), red where the
  current code is buggy.
- [ ] **P1 — Server side.** Catch-up endpoint/events, server-authoritative
  unread counts (channels, DMs, notifications), idempotent read events, any
  socket/presence changes the chosen model needs.
- [ ] **P2 — Notifications** off the chunked cache: memory + server, count from
  the server, idempotent event handling, no 7 s setup race.
- [ ] **P3 — Messages:** per-channel latest window in memory + server paging +
  live events + reconcile on (re)connect/activation; `updatedAt`-guarded
  merges; temp items keyed by the client UUID; the `ItemListState` shape kept
  so `GenericMessageList` / `ScrollingMessageList` / `CommentList` change
  little. Read marking level-triggered (newest received message while the list
  is at the bottom and visible), deferred until login instead of dropped.
  New tab/socket model; the service-worker role referee removed or reduced.
- [ ] **P4 — Optional persistence** of the latest N messages per channel, only
  if P0/P3 measurements (time to first message after reload, offline use)
  justify it: single writer, LRU of K channels, whole-store wipe on logout,
  cache-schema constant.
- [ ] **P5 — Removal and docs.** Delete `chunkedDatabase.ts`,
  `chunkedDatabase.helpers.ts`, `itemList.ts`, the chunk parts of `channel.ts`,
  the unused legacy `src/data/databases/messages.ts`; delete the old IndexedDB
  stores on startup; update `docs/frontend` and `docs/realtime` (+ status lines).

## Acceptance

E2E scenarios (all green on the integration branch, plus the existing suite):

- **E1 Call chat:** B joins a call while A posts immediately; B sees the message
  without refresh, also with B's clock +2 s and added API latency.
- **E2 Unread across tabs:** B reads a channel in tab 1 with tab 2 in the
  background, reloads; unread stays cleared, server `lastRead` never regresses.
- **E3 Reconnect:** B offline; A posts three messages and edits an older one; B
  back online sees all of it in order without scrolling or refresh.
- **E4 Multi-tab:** two tabs of B, A posts, switch tabs, reload both; both
  consistent, no channel empty.
- **E5 Notifications:** a mention increments the badge once; opening it
  decrements once; after reload the badge equals the server count.
- **E6 Offline display** (only if P4 ships).
- **E7 Login time:** reload → logged in under a threshold; time to first message
  reported.
- **E8 Split view / frozen tab:** two visible tabs both live; a tab frozen via
  CDP (`Page.setWebLifecycleState frozen`) and resumed catches up; a hard reload
  with a stopped service worker connects.

Plus the maintainer's browser test of the original symptoms (call chat first
message, "Disconnected", unread dot, notifications).

## Fallback (only if this misses the dress rehearsal)

Hotfixes on the old code, analysed 2026-11-02: B1 (never delete items newer than
the request start), B3 (self-heal on integrity error + cache-schema constant),
B4 (keep the force flag, drop the clear+retry in `login.ts`), a ~3 s fallback
when the service worker assigns no role, `logDebug = false`.

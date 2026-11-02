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

## Tab and socket model (to be settled in Phase 0)

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

## Phases

- [ ] **Phase 0 — Research and design.** A "Design" section in this file:
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

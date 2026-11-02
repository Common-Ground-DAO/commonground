# src/data/chat — chat-sync contract (for implementers)

Working note for the chat-sync slices, not user documentation. Plan and
decisions: `docs/todo/ROADMAP_chat-sync.md` ("Design", [1]–[11]). The doc
comments in the files below are normative; this is the summary.

## Files of the contract

- `types.ts` — stores, windows, `WindowChange`, `WINDOW_ERROR`, read-state
  merge rules (`mergeReadState`), injected deps, limits.
- `data/appstate/transport.ts` — `Transport`, `x-cg-socket-id` (fixed),
  `cg:login`, hidden policy, auth broadcast, legacy SW messages.
- `common/types/api/{messages,notifications}.d.ts`, `events/*.d.ts` — new
  endpoints and fields (optional unless inside a new endpoint).

## Rules everyone relies on

1. **Versions**: full versions replace on `syncSeq >=`, partial deltas apply
   only on `>`; seq'd beats seq-less unless the seq-less one has a strictly
   newer `updatedAt`. Tombstones are terminal.
2. **Pages never delete** and only touch their own range. `getChanges` is a
   change list: update known ids anywhere, insert unknown ids only at or above
   the latest segment's oldest item.
3. **Reset** (snapshot seq S): latest segment = page + local items with
   seq > S at/above the page's oldest item + pending sends; detached segments
   and loose items dropped; windows off the new segment re-init detached
   (`reset{cause:'resync'}`).
4. **Cursor** = `1:<seenSeq>`, the contiguous applied high-water mark (all
   sources, incl. own create/edit responses). Open gap after 1.5 s ->
   `getChanges`. Catch-up only on `onLive`/`onResume`.
5. **Windows** are ref-counted; `ItemListState` kept; listeners get
   `(state, change)` synchronously, set the scroll lock first. Pins: windows,
   watchers, pending sends; LRU 20; latest segment <= 200 (never trims a
   visible slice).
6. **Sends/edits** resolve once the pending item/overlay is shown and never
   reject; the outcome is `sendStatus`, then `retrySend`/`discardPending`.
   `isEmpty` counts server items only: it can be true while a pending send
   is shown, so the UI checks `items.length` for its empty-channel text.
7. **Read state**: everything through `mergeReadState`; `lastRead`/
   `lastMessageDate` max-merged; seq'd snapshots plus `counted` seqs survive
   live events during the round trip. Marking is a level (latest + bottom +
   visible + logged in).
8. **Notification count** from the server only, newest `unreadCountAt` wins.

## Who implements what

| Contract piece | Slice |
|---|---|
| store factories + `mergeReadState` (pure, `src/data/chat/*.ts`), connector methods `getChanges`/`getSyncState` (`data/api/messages.ts`) and `getUnreadCount({ withTime })` | store-core |
| event source/API adapters, `data.channelManager` façade, `onOwnMessage` -> read state | messages-ui |
| `ReadStatePersistence` (Dexie, one transaction) | entity-dbs |
| `Transport`, auth broadcast, `cg:login`, socket-id header, article-room re-join | transport |
| compat answer on `CG_WEBSOCKET_STATE` | sw |
| endpoints, `syncSeq`, event fields, `getSyncState` null-lastRead semantics | srv-sync, srv-state |

Handoff for messages-ui: the contracts slice changed `src/data/databases/channel.ts`
(`setChannelLastRead`: `.then(() => resolve())`) only to compile against the new
response type; the rewrite replaces it.

Deploy window (new client, old server): a 404 on `getChanges`/`getSyncState` ->
fall back to `loadMessages` + old snapshots for the page load; omit `messageId`
until one succeeded (retry without it on a validation error).

## Implementation files (store-core)

- `index.ts` — factories, `mergeReadState`, `systemClock`; compile-time check
  that `messageApi`/`notificationsApi` satisfy `ChatApi`/`NotificationApi`.
- `channelStore.ts` (+ `messageVersion.ts`: wire conversion, version rule),
  `readStateStore.ts`, `notificationStore.ts`, `mergeReadState.ts`, `util.ts`.
- `testing/fakeServer.ts` — scripted fake server (ChatApi + NotificationApi +
  ChatEventSource) for the unit tests: seqs, tombstones, held/failed
  responses, events delivered late/duplicated/out of order, old-server mode.

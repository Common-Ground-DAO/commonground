# src/data/chat — chat stores (messages, read state, notifications)

Per-tab, in-memory stores over the server's catch-up API. Overview and how
they fit into the app: `docs/frontend/README.md` §3 "Chat stores"; tab and
socket model: `docs/realtime/README.md` "Tab Coordination". The doc comments
in the files below are normative; this is the summary.

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

Deploy window (new client, old server): a 404 on `getChanges`/`getSyncState` ->
fall back to `loadMessages` + old snapshots for the page load; omit `messageId`
until one succeeded (retry without it on a validation error).

## Implementation files

- `index.ts` — factories, `mergeReadState`, `systemClock`; compile-time check
  that `messageApi`/`notificationsApi` satisfy `ChatApi`/`NotificationApi`.
- `channelStore.ts` (+ `messageVersion.ts`: wire conversion, version rule),
  `readStateStore.ts`, `notificationStore.ts`, `mergeReadState.ts`, `util.ts`.
- `runtime.ts` — the tab's one runtime (`chat.channels`, `chat.readState`,
  `chat.notifications`, `chat.events`) with the real connectors, the
  ChatEventSource and the entity-db persistence; login hook-up
  (`setupChatAfterLogin`, `clearChat`). Façades: `data.channelManager`
  (`data/databases/channel.ts`), `data.notification`
  (`data/databases/notification.ts`).
- `testing/fakeServer.ts` — scripted fake server (ChatApi + NotificationApi +
  ChatEventSource) for the unit tests: seqs, tombstones, held/failed
  responses, events delivered late/duplicated/out of order, old-server mode.

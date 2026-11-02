# src/data/chat — chat-sync contract (for implementers)

Working note for the chat-sync slices, not user documentation. Plan and
decisions: `docs/todo/ROADMAP_chat-sync.md` ("Design", [1]–[11]).

## Files of the contract

- `types.ts` — store interfaces (`ChannelStore`, `ChannelWindow`/`ItemWindow`,
  `WindowChange`, `ReadStateStore`, `ReadStateInput`, `ReadStatePersistence`,
  `NotificationStore`), injected deps (`ChatApi`, `NotificationApi`,
  `ChatEventSource`, `ChatClock`), limits.
- `data/appstate/transport.ts` — `Transport` (live / resume / updateAvailable,
  `holdSocket`, `getRequestSocketId`), `SOCKET_ID_HEADER` (`x-cg-socket-id`,
  fixed), `LOGIN_LOCK_NAME` (`cg:login`), hidden policy constants, auth
  broadcast, legacy service-worker messages and the compat answer.
- `common/types/api/messages.d.ts` — `getChanges`, `getSyncState`,
  `setChannelLastRead` (+`messageId`, response), idempotent create;
  `events/*.d.ts` — `syncSeq`, `cliChannelLastRead.unread`, notification
  `unreadCount`. Every new field is optional except inside the new endpoints.

## Rules everyone relies on

1. **Merge by `syncSeq`**: replace a message only with a higher seq; equal =
   same version; without seq on either side fall back to `updatedAt`.
   Tombstones are terminal.
2. **Pages never delete**: a page is authoritative only for its own range and
   only upserts. Removals come from tombstones and `getChanges` resets.
3. **Reset** replaces the latest segment but keeps local items with
   `syncSeq` above the reset's `syncSeq` and pending sends.
4. **Catch-up** on `onLive` and `onResume` only: `getChanges` per open window,
   `getSyncState` for read state, `getUnreadCount` for notifications. Gap
   (`syncSeq > cursorSeq + 1`) -> debounced `getChanges`.
5. **Windows** are ref-counted, any number per channel; `ItemListState` shape
   kept; listeners get `(state, change)` synchronously; set the scroll lock
   first. LRU of 20 channels without window, latest segment <= 200.
6. **Read state**: `lastRead`/`lastMessageDate` max-merged everywhere through
   one `mergeReadState`; a snapshot's `unread` is trusted only if its
   `lastRead` >= local (and its seq >= local seq). Marking is a level:
   at latest + at bottom + visible + logged in, re-evaluated on every input.
7. **Notification count** comes from the server only, never `++/--`.
8. **Pending sends** are inserted synchronously before the API call; retry
   reuses the UUID; errors stay visible until retried or discarded.

## Who implements what

| Contract piece | Slice |
|---|---|
| `createChannelStore`, `createReadStateStore`, `createNotificationStore`, `mergeReadState` (pure, `src/data/chat/*.ts`) | store-core |
| `ChatEventSource` + `ChatApi` adapters, `data.channelManager` façade | messages-ui (`getChanges`/`getSyncState` connector methods in `src/data/api/messages.ts` still to be assigned) |
| `ReadStatePersistence` (Dexie, inside one transaction) | entity-dbs |
| `Transport`, auth broadcast, `cg:login` lock, `x-cg-socket-id` header | transport |
| compat answer on `CG_WEBSOCKET_STATE` | sw |
| endpoints, `syncSeq`, event fields | srv-sync, srv-state |

## Deploy window (new client, old server)

`getChanges`/`getSyncState` 404 -> remember for the page load, fall back to
`loadMessages` + the existing snapshots. Send `setChannelLastRead.messageId`
only after one of the two succeeded. Old servers omit `syncSeq`, `unread`,
`unreadCount`: fall back as documented at each field.

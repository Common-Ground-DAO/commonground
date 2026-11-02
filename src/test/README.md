# src/test — helpers for data-layer unit tests

Vitest runs in the `node` environment (`vitest.config.ts`). These opt-in helpers add
just the browser behaviour the data layer needs. Everything a helper installs is
removed after each test by `setup.ts` (via `cleanup.ts`); each helper has a `*.test.ts`
that doubles as an example. Import them relatively or as `test/env` etc.

| File | Use it for |
|---|---|
| `env.ts` | `installBrowserEnv(opts)` sets the globals `window`, `document`, `navigator`, `localStorage`, `sessionStorage`, `location` and a tracked `BroadcastChannel`. Drive the page with `hide()`/`show()`, `pagehide(persisted)`, `pageshow(persisted)`, `freeze()`, `resume()`, `goOffline()`/`goOnline()`, `enterBfcache()`/`restoreFromBfcache()`, `storageEvent({ key, newValue })`, `dispatch(target, type)`. `createBrowserEnv()` builds another tab without touching globals. `navigator.locks` is each tab's view of one per-test shared fake manager, so tabs contend; `closeTab()` releases a tab's locks. `{ locks: 'real' }` uses Node's (process-wide, not resettable). |
| `fakeSocket.ts` | `FakeSocket`: socket.io-client 4.8 look-alike (buffer flushed before `connect`, acks cleared on disconnect, `emitWithAck`/`timeout(ms)` reject, inactive after client/server disconnect until `connect()`, `socket.io` reconnect events). The test is the server: `accept()`, `refuse(err, { middleware })`, `drop(reason)`, `deliver(event, data)`, `deliverWithAck`, `handle(event, fn)`, `respond(event, value)`, `settle()`; logs `sent`, `pendingAcks`. Default handlers answer `getSignableSecret` and `login` (`loginResult`, `loggedIn`, `loginCount`). `createFakeIo()` is a drop-in `io()` for `vi.mock('socket.io-client')`. |
| `fakeIdb.ts` | `installFakeIdb()`: a fresh fake-indexeddb factory per test, wired into `Dexie.dependencies` and the `indexedDB` global. `idb.tabs(2, opts => new MyDb(opts))` opens one database from two "tabs". Limits: both share one Dexie module state (query cache, liveQuery propagated in-process, not via BroadcastChannel); Dexie's bfcache close/reopen is not simulated. |
| `modules.ts` | `importAsNewTab(() => import('data/…'))`: a fresh module graph, so module singletons exist once per simulated tab. |
| `timers.ts` | `useDataLayerFakeTimers()`: fake timers *without* `setImmediate`, which fake-indexeddb needs — a plain `vi.useFakeTimers()` would hang Dexie (fakeIdb throws instead). A liveQuery's first result needs `await flushLiveQueries()` (its first query is a `setTimeout(…, 0)`). |
| `deferred.ts` | `deferred()` (resolve by hand) and `flushMicrotasks()`. |

```ts
import { installBrowserEnv } from 'test/env';
import { createFakeIo, type FakeIo } from 'test/fakeSocket';
import { importAsNewTab } from 'test/modules';

const fake = vi.hoisted(() => ({ io: undefined as FakeIo | undefined }));
vi.mock('socket.io-client', () => ({ io: (...a: Parameters<FakeIo['io']>) => fake.io!.io(...a) }));

it('reconnects when the tab becomes visible again', async () => {
  fake.io = createFakeIo();
  const env = installBrowserEnv();
  const ws = await importAsNewTab(() => import('data/appstate/webSocket'));
  // … env.hide(); fake.io.last.drop(); env.show(); fake.io.last.accept(); await fake.io.last.settle();
});
```

Notes:
- Events fire where the specs fire them: `visibilitychange`/`freeze`/`resume` at
  `document`; the rest at `window`. Window capture listeners for document events are not simulated.
- Modules that read `window` at import time: load them with `importAsNewTab` after installing, or
  install with `{ persistent: true }` in an async `vi.hoisted` (dynamic import of `test/env`),
  then `env.reset()` per test and `env.uninstall()` in `afterAll`.
  `reset()` keeps listeners; a fresh env (plus `importAsNewTab`) gives fresh ones.
- `FakeSocket` never reconnects by itself after `drop()`; acks of a dropped connection are lost.

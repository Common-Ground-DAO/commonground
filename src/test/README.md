# src/test — helpers for data-layer unit tests

Vitest runs in the `node` environment (`vitest.config.ts`). These opt-in helpers add
just the browser behaviour the data layer needs. Everything a helper installs is
removed after each test by `setup.ts` (via `cleanup.ts`); each helper has a `*.test.ts`
that doubles as an example. Import them relatively or as `test/env` etc.

| File | Use it for |
|---|---|
| `env.ts` | `installBrowserEnv(opts)` sets the globals `window`, `document`, `navigator`, `localStorage`, `sessionStorage`, `location` and a tracked `BroadcastChannel`. Drive the page with `hide()`/`show()`, `pagehide(persisted)`, `pageshow(persisted)`, `freeze()`, `resume()`, `goOffline()`/`goOnline()`, `enterBfcache()`/`restoreFromBfcache()`, `storageEvent({ key, newValue })`, `dispatch(target, type)`. `navigator.locks` is Node's real LockManager (process-wide) unless `{ locks: 'fake' }`. `createBrowserEnv()` builds an env without touching globals. |
| `fakeSocket.ts` | `FakeSocket`: socket.io-client look-alike; the test is the server: `accept()`, `refuse()`, `drop(reason)`, `deliver(event, data)`, `handle(event, fn)`, `respond(event, value)`, `settle()`; logs `sent`, `pendingAcks`. Default handlers answer `getSignableSecret` and `login` (`loginResult`, `loggedIn`, `loginCount`). `createFakeIo()` is a drop-in `io()` for `vi.mock('socket.io-client')`. |
| `fakeIdb.ts` | `installFakeIdb()`: a fresh fake-indexeddb factory per test, wired into `Dexie.dependencies` and the `indexedDB` global. `idb.tabs(2, opts => new MyDb(opts))` opens one database from two "tabs" for cross-tab tests. |
| `modules.ts` | `importAsNewTab(() => import('data/…'))`: a fresh module graph, so module singletons exist once per simulated tab. |
| `deferred.ts` | `deferred()` (resolve by hand) and `flushMicrotasks()`. Vitest fake timers work with all helpers. |

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

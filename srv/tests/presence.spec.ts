// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Presence decisions of one wsapi process (`util/presence.ts`): the offline
 * grace period, its cancellation by a reconnect, the cluster-wide lookup, and
 * the races between a pending offline and a new login.
 */

import { PresenceTracker, PRESENCE_OFFLINE_GRACE_MS, type PresenceDeps } from '../util/presence';

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

type Harness = {
  tracker: PresenceTracker;
  /** logged-in sockets per user on this process */
  local: Map<string, number>;
  /** logged-in sockets per user on other processes */
  remote: Map<string, number>;
  deps: jest.Mocked<Required<PresenceDeps>>;
  setShuttingDown: (value: boolean) => void;
};

function createHarness(overrides: Partial<PresenceDeps> = {}): Harness {
  const local = new Map<string, number>();
  const remote = new Map<string, number>();
  let shuttingDown = false;
  const deps = {
    hasLocalSocket: jest.fn((userId: string) => (local.get(userId) ?? 0) > 0),
    hasClusterSocket: jest.fn(async (userId: string) => (local.get(userId) ?? 0) + (remote.get(userId) ?? 0) > 0),
    markOnline: jest.fn(async (_userId: string) => {}),
    markOffline: jest.fn(async (_userId: string) => {}),
    isShuttingDown: jest.fn(() => shuttingDown),
    graceMs: PRESENCE_OFFLINE_GRACE_MS,
    logError: jest.fn(),
    ...overrides,
  } as jest.Mocked<Required<PresenceDeps>>;
  return {
    tracker: new PresenceTracker(deps),
    local,
    remote,
    deps,
    setShuttingDown: (value) => { shuttingDown = value; },
  };
}

/** what wsapi does on a successful socket login */
async function login(h: Harness, userId: string) {
  h.tracker.socketAuthenticated(userId);
  h.local.set(userId, (h.local.get(userId) ?? 0) + 1);
  await h.tracker.userLoggedIn(userId);
}

/** what wsapi does on disconnect (the socket has already left its rooms) */
function disconnect(h: Harness, userId: string) {
  h.local.set(userId, (h.local.get(userId) ?? 1) - 1);
  h.tracker.socketGone(userId);
}

/** advance fake time and let the decision's promises settle */
async function advance(ms: number) {
  await jest.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('PresenceTracker', () => {
  it('uses a 30 s grace period', () => {
    expect(PRESENCE_OFFLINE_GRACE_MS).toBe(30_000);
  });

  it('marks a user online on login', async () => {
    const h = createHarness();
    await login(h, USER);
    expect(h.deps.markOnline).toHaveBeenCalledWith(USER);
    expect(h.tracker.onlineUserIds()).toEqual([USER]);
  });

  it('goes offline only after the grace period without any socket', async () => {
    const h = createHarness();
    await login(h, USER);
    disconnect(h, USER);
    expect(h.tracker.isPending(USER)).toBe(true);

    await advance(PRESENCE_OFFLINE_GRACE_MS - 1);
    expect(h.deps.markOffline).not.toHaveBeenCalled();
    // still touched during the grace period, so the stale job leaves it alone
    expect(h.tracker.onlineUserIds()).toEqual([USER]);

    await advance(1);
    expect(h.deps.hasClusterSocket).toHaveBeenCalledWith(USER);
    expect(h.deps.markOffline).toHaveBeenCalledTimes(1);
    expect(h.deps.markOffline).toHaveBeenCalledWith(USER);
    expect(h.tracker.onlineUserIds()).toEqual([]);
    expect(h.tracker.isPending(USER)).toBe(false);
  });

  it('cancels the pending offline on a reconnect within the grace period', async () => {
    const h = createHarness();
    await login(h, USER);
    disconnect(h, USER);
    await advance(20_000);
    await login(h, USER);
    expect(h.tracker.isPending(USER)).toBe(false);

    await advance(PRESENCE_OFFLINE_GRACE_MS * 3);
    expect(h.deps.markOffline).not.toHaveBeenCalled();
    expect(h.deps.hasClusterSocket).not.toHaveBeenCalled();
    expect(h.tracker.onlineUserIds()).toEqual([USER]);
  });

  it('does not start the grace period while another local socket remains', async () => {
    const h = createHarness();
    await login(h, USER);
    await login(h, USER);
    disconnect(h, USER);
    expect(h.tracker.isPending(USER)).toBe(false);

    await advance(PRESENCE_OFFLINE_GRACE_MS * 2);
    expect(h.deps.markOffline).not.toHaveBeenCalled();

    disconnect(h, USER);
    await advance(PRESENCE_OFFLINE_GRACE_MS);
    expect(h.deps.markOffline).toHaveBeenCalledTimes(1);
  });

  it('keeps one timer for repeated last-socket events', async () => {
    const h = createHarness();
    await login(h, USER);
    disconnect(h, USER);
    await advance(10_000);
    h.tracker.socketGone(USER);
    await advance(PRESENCE_OFFLINE_GRACE_MS - 10_000);
    expect(h.deps.markOffline).toHaveBeenCalledTimes(1);
    await advance(PRESENCE_OFFLINE_GRACE_MS);
    expect(h.deps.markOffline).toHaveBeenCalledTimes(1);
  });

  it('leaves the user online when a socket remains on another process', async () => {
    const h = createHarness();
    await login(h, USER);
    h.remote.set(USER, 1);
    disconnect(h, USER);
    await advance(PRESENCE_OFFLINE_GRACE_MS);

    expect(h.deps.hasClusterSocket).toHaveBeenCalledWith(USER);
    expect(h.deps.markOffline).not.toHaveBeenCalled();
    // the other process owns the user's presence (and its touch) now
    expect(h.tracker.onlineUserIds()).toEqual([]);
  });

  it('falls back to offline when the cluster lookup fails', async () => {
    const h = createHarness({
      hasClusterSocket: jest.fn(async () => { throw new Error('timeout reached while waiting for fetchSockets response'); }),
    });
    await login(h, USER);
    disconnect(h, USER);
    await advance(PRESENCE_OFFLINE_GRACE_MS);

    expect(h.deps.logError).toHaveBeenCalled();
    expect(h.deps.markOffline).toHaveBeenCalledWith(USER);
  });

  it('does not go offline when a login lands during the cluster lookup', async () => {
    let resolveLookup: (value: boolean) => void = () => {};
    const h = createHarness({
      hasClusterSocket: jest.fn(() => new Promise<boolean>(resolve => { resolveLookup = resolve; })),
    });
    await login(h, USER);
    disconnect(h, USER);
    await advance(PRESENCE_OFFLINE_GRACE_MS);
    expect(h.deps.hasClusterSocket).toHaveBeenCalledTimes(1);

    // authenticated, rooms not joined yet: only the login sequence tells
    h.tracker.socketAuthenticated(USER);
    resolveLookup(false);
    await advance(0);

    expect(h.deps.markOffline).not.toHaveBeenCalled();
    expect(h.tracker.onlineUserIds()).toEqual([USER]);
  });

  it('restores online when a login races the offline write', async () => {
    let finishOffline: () => void = () => {};
    const h = createHarness({
      markOffline: jest.fn(() => new Promise<void>(resolve => { finishOffline = resolve; })),
    });
    await login(h, USER);
    disconnect(h, USER);
    await advance(PRESENCE_OFFLINE_GRACE_MS);
    expect(h.deps.markOffline).toHaveBeenCalledTimes(1);
    h.deps.markOnline.mockClear();

    await login(h, USER);
    finishOffline();
    await advance(0);

    // once by the login, once to repair the late offline write
    expect(h.deps.markOnline).toHaveBeenCalledTimes(2);
    expect(h.tracker.onlineUserIds()).toEqual([USER]);
  });

  it('decides per user', async () => {
    const h = createHarness();
    await login(h, USER);
    await login(h, OTHER);
    disconnect(h, USER);
    await advance(10_000);
    disconnect(h, OTHER);
    await advance(PRESENCE_OFFLINE_GRACE_MS - 10_000);
    expect(h.deps.markOffline.mock.calls).toEqual([[USER]]);
    expect(h.tracker.onlineUserIds()).toEqual([OTHER]);
    await advance(10_000);
    expect(h.deps.markOffline.mock.calls).toEqual([[USER], [OTHER]]);
  });

  it('writes no offline while shutting down', async () => {
    const h = createHarness();
    await login(h, USER);
    await login(h, OTHER);
    disconnect(h, USER);
    h.setShuttingDown(true);
    h.tracker.dispose();
    disconnect(h, OTHER);
    expect(h.tracker.isPending(OTHER)).toBe(false);

    await advance(PRESENCE_OFFLINE_GRACE_MS * 2);
    expect(h.deps.markOffline).not.toHaveBeenCalled();
  });

  it('skips a decision that fires after shutdown began', async () => {
    const h = createHarness();
    await login(h, USER);
    disconnect(h, USER);
    h.setShuttingDown(true);
    await advance(PRESENCE_OFFLINE_GRACE_MS);
    expect(h.deps.markOffline).not.toHaveBeenCalled();
  });
});

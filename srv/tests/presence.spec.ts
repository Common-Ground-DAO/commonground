// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Presence decisions of one wsapi process (`util/presence.ts`): the offline
 * grace period, its cancellation by a reconnect, the cluster-wide lookup
 * (batched, retried once when incomplete), the touch sets, and the races
 * between a pending offline and a new login.
 */

import {
  PresenceTracker,
  PRESENCE_DECISION_BATCH_MS,
  PRESENCE_OFFLINE_GRACE_MS,
  PRESENCE_RETRY_DELAY_MS,
  type ClusterProbe,
  type PresenceDeps,
} from '../util/presence';

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const THIRD = '00000000-0000-4000-8000-000000000003';

/** grace period plus the batch window: when a decision runs */
const DECISION_MS = PRESENCE_OFFLINE_GRACE_MS + PRESENCE_DECISION_BATCH_MS;

type Harness = {
  tracker: PresenceTracker;
  /** logged-in sockets per user on this process */
  local: Map<string, number>;
  /** logged-in sockets per user on other processes */
  remote: Map<string, number>;
  deps: jest.Mocked<Required<PresenceDeps>>;
  /** user ids written offline, flattened over all batches */
  offlineIds: () => string[];
  setShuttingDown: (value: boolean) => void;
};

function createHarness(overrides: Partial<PresenceDeps> = {}): Harness {
  const local = new Map<string, number>();
  const remote = new Map<string, number>();
  let shuttingDown = false;
  const deps = {
    hasLocalSocket: jest.fn((userId: string) => (local.get(userId) ?? 0) > 0),
    probeCluster: jest.fn(async (userIds: string[]): Promise<ClusterProbe> => ({
      present: userIds.filter(userId => (remote.get(userId) ?? 0) > 0),
      complete: true,
    })),
    markOnline: jest.fn(async (_userId: string) => {}),
    markOffline: jest.fn(async (_userIds: string[]) => {}),
    isShuttingDown: jest.fn(() => shuttingDown),
    graceMs: PRESENCE_OFFLINE_GRACE_MS,
    batchMs: PRESENCE_DECISION_BATCH_MS,
    retryMs: PRESENCE_RETRY_DELAY_MS,
    logError: jest.fn(),
    ...overrides,
  } as jest.Mocked<Required<PresenceDeps>>;
  return {
    tracker: new PresenceTracker(deps),
    local,
    remote,
    deps,
    offlineIds: () => deps.markOffline.mock.calls.flatMap(([userIds]) => userIds),
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
    expect(h.tracker.touchSets()).toEqual({ connected: [USER], grace: [] });
  });

  it('goes offline only after the grace period without any socket', async () => {
    const h = createHarness();
    await login(h, USER);
    disconnect(h, USER);
    expect(h.tracker.isPending(USER)).toBe(true);

    await advance(DECISION_MS - 1);
    expect(h.deps.probeCluster).not.toHaveBeenCalled();
    expect(h.deps.markOffline).not.toHaveBeenCalled();

    await advance(1);
    expect(h.deps.probeCluster).toHaveBeenCalledWith([USER]);
    expect(h.deps.markOffline.mock.calls).toEqual([[[USER]]]);
    expect(h.tracker.touchSets()).toEqual({ connected: [], grace: [] });
    expect(h.tracker.isPending(USER)).toBe(false);
  });

  it('cancels the pending offline on a reconnect within the grace period', async () => {
    const h = createHarness();
    await login(h, USER);
    disconnect(h, USER);
    await advance(20_000);
    await login(h, USER);
    expect(h.tracker.isPending(USER)).toBe(false);

    await advance(DECISION_MS * 3);
    expect(h.deps.markOffline).not.toHaveBeenCalled();
    expect(h.deps.probeCluster).not.toHaveBeenCalled();
    expect(h.tracker.touchSets()).toEqual({ connected: [USER], grace: [] });
  });

  it('cancels a decision that is due but not yet batched', async () => {
    const h = createHarness();
    await login(h, USER);
    disconnect(h, USER);
    await advance(PRESENCE_OFFLINE_GRACE_MS);
    expect(h.tracker.isPending(USER)).toBe(true);
    await login(h, USER);
    await advance(PRESENCE_DECISION_BATCH_MS);
    expect(h.deps.probeCluster).not.toHaveBeenCalled();
    expect(h.deps.markOffline).not.toHaveBeenCalled();
  });

  it('does not start the grace period while another local socket remains', async () => {
    const h = createHarness();
    await login(h, USER);
    await login(h, USER);
    disconnect(h, USER);
    expect(h.tracker.isPending(USER)).toBe(false);

    await advance(DECISION_MS * 2);
    expect(h.deps.markOffline).not.toHaveBeenCalled();

    disconnect(h, USER);
    await advance(DECISION_MS);
    expect(h.offlineIds()).toEqual([USER]);
  });

  it('keeps one timer for repeated last-socket events', async () => {
    const h = createHarness();
    await login(h, USER);
    disconnect(h, USER);
    await advance(10_000);
    h.tracker.socketGone(USER);
    await advance(DECISION_MS - 10_000);
    expect(h.deps.markOffline).toHaveBeenCalledTimes(1);
    await advance(DECISION_MS);
    expect(h.deps.markOffline).toHaveBeenCalledTimes(1);
  });

  it('leaves the user online when a socket remains on another process', async () => {
    const h = createHarness();
    await login(h, USER);
    h.remote.set(USER, 1);
    disconnect(h, USER);
    await advance(DECISION_MS);

    expect(h.deps.probeCluster).toHaveBeenCalledWith([USER]);
    expect(h.deps.markOffline).not.toHaveBeenCalled();
    // the other process owns the user's presence (and its touch) now
    expect(h.tracker.touchSets()).toEqual({ connected: [], grace: [] });
  });

  describe('touch sets', () => {
    it('only refreshes the timestamp of users in their grace period', async () => {
      const h = createHarness();
      await login(h, USER);
      await login(h, OTHER);
      disconnect(h, OTHER);
      // OTHER must not be flipped back online by this process's touch while
      // another process may already have decided it offline
      expect(h.tracker.touchSets()).toEqual({ connected: [USER], grace: [OTHER] });

      await advance(DECISION_MS);
      expect(h.tracker.touchSets()).toEqual({ connected: [USER], grace: [] });
    });

    it('keeps a user waiting for the retry in the grace set', async () => {
      const h = createHarness({
        probeCluster: jest.fn(async () => ({ present: [], complete: false })),
      });
      await login(h, USER);
      disconnect(h, USER);
      await advance(DECISION_MS);
      expect(h.tracker.touchSets()).toEqual({ connected: [], grace: [USER] });
    });
  });

  describe('incomplete cluster lookup', () => {
    it('retries once, then goes offline', async () => {
      const h = createHarness({
        probeCluster: jest.fn(async () => ({ present: [], complete: false, error: new Error('timeout') })),
      });
      await login(h, USER);
      disconnect(h, USER);
      await advance(DECISION_MS);

      expect(h.deps.probeCluster).toHaveBeenCalledTimes(1);
      expect(h.deps.logError).toHaveBeenCalled();
      expect(h.deps.markOffline).not.toHaveBeenCalled();
      expect(h.tracker.isPending(USER)).toBe(true);

      await advance(PRESENCE_RETRY_DELAY_MS + PRESENCE_DECISION_BATCH_MS);
      expect(h.deps.probeCluster).toHaveBeenCalledTimes(2);
      expect(h.offlineIds()).toEqual([USER]);
      expect(h.tracker.isPending(USER)).toBe(false);
    });

    it('treats a rejected lookup as incomplete', async () => {
      const h = createHarness({
        probeCluster: jest.fn(async () => { throw new Error('redis down'); }),
      });
      await login(h, USER);
      disconnect(h, USER);
      await advance(DECISION_MS);
      expect(h.deps.markOffline).not.toHaveBeenCalled();
      await advance(PRESENCE_RETRY_DELAY_MS + PRESENCE_DECISION_BATCH_MS);
      expect(h.offlineIds()).toEqual([USER]);
    });

    it('goes offline right away when the retry succeeds without a socket', async () => {
      const probeCluster = jest.fn<Promise<ClusterProbe>, [string[]]>()
        .mockResolvedValueOnce({ present: [], complete: false })
        .mockResolvedValueOnce({ present: [], complete: true });
      const h = createHarness({ probeCluster });
      await login(h, USER);
      disconnect(h, USER);
      await advance(DECISION_MS + PRESENCE_RETRY_DELAY_MS + PRESENCE_DECISION_BATCH_MS);
      expect(h.offlineIds()).toEqual([USER]);
    });

    it('keeps users found in the partial answers and retries only the rest', async () => {
      const probeCluster = jest.fn(async (): Promise<ClusterProbe> => ({ present: [USER], complete: false }));
      const h = createHarness({ probeCluster });
      await login(h, USER);
      await login(h, OTHER);
      disconnect(h, USER);
      disconnect(h, OTHER);
      await advance(DECISION_MS);
      expect(h.deps.markOffline).not.toHaveBeenCalled();
      expect(h.tracker.touchSets()).toEqual({ connected: [], grace: [OTHER] });

      await advance(PRESENCE_RETRY_DELAY_MS + PRESENCE_DECISION_BATCH_MS);
      expect(probeCluster.mock.calls[1]).toEqual([[OTHER]]);
      expect(h.offlineIds()).toEqual([OTHER]);
    });

    it('cancels the retry on a reconnect', async () => {
      const h = createHarness({
        probeCluster: jest.fn(async () => ({ present: [], complete: false })),
      });
      await login(h, USER);
      disconnect(h, USER);
      await advance(DECISION_MS);
      await login(h, USER);
      await advance(PRESENCE_RETRY_DELAY_MS * 2);
      expect(h.deps.probeCluster).toHaveBeenCalledTimes(1);
      expect(h.deps.markOffline).not.toHaveBeenCalled();
    });
  });

  describe('batching', () => {
    it('decides users coming due within the batch window with one lookup and one write', async () => {
      const h = createHarness();
      for (const userId of [USER, OTHER, THIRD]) {
        await login(h, userId);
      }
      h.remote.set(OTHER, 1);
      // a proxy reload: every socket drops within a few hundred ms
      disconnect(h, USER);
      await advance(100);
      disconnect(h, OTHER);
      await advance(200);
      disconnect(h, THIRD);
      await advance(DECISION_MS);

      expect(h.deps.probeCluster).toHaveBeenCalledTimes(1);
      expect(h.deps.probeCluster.mock.calls[0][0].sort()).toEqual([USER, OTHER, THIRD].sort());
      expect(h.deps.markOffline).toHaveBeenCalledTimes(1);
      expect(h.deps.markOffline.mock.calls[0][0].sort()).toEqual([USER, THIRD].sort());
    });

    it('leaves out users that reconnected before the batch ran', async () => {
      const h = createHarness();
      await login(h, USER);
      await login(h, OTHER);
      disconnect(h, USER);
      disconnect(h, OTHER);
      await advance(PRESENCE_OFFLINE_GRACE_MS);
      await login(h, OTHER);
      await advance(PRESENCE_DECISION_BATCH_MS);
      expect(h.deps.probeCluster.mock.calls).toEqual([[[USER]]]);
      expect(h.offlineIds()).toEqual([USER]);
    });

    it('decides users further apart in separate batches', async () => {
      const h = createHarness();
      await login(h, USER);
      await login(h, OTHER);
      disconnect(h, USER);
      await advance(10_000);
      disconnect(h, OTHER);
      await advance(DECISION_MS - 10_000);
      expect(h.deps.markOffline.mock.calls).toEqual([[[USER]]]);
      expect(h.tracker.touchSets()).toEqual({ connected: [], grace: [OTHER] });
      await advance(10_000);
      expect(h.deps.markOffline.mock.calls).toEqual([[[USER]], [[OTHER]]]);
    });
  });

  it('does not go offline when a login lands during the cluster lookup', async () => {
    let resolveLookup: (value: ClusterProbe) => void = () => {};
    const h = createHarness({
      probeCluster: jest.fn(() => new Promise<ClusterProbe>(resolve => { resolveLookup = resolve; })),
    });
    await login(h, USER);
    disconnect(h, USER);
    await advance(DECISION_MS);
    expect(h.deps.probeCluster).toHaveBeenCalledTimes(1);

    // authenticated, rooms not joined yet: only the login sequence tells
    h.tracker.socketAuthenticated(USER);
    resolveLookup({ present: [], complete: true });
    await advance(0);

    expect(h.deps.markOffline).not.toHaveBeenCalled();
    expect(h.tracker.touchSets()).toEqual({ connected: [], grace: [USER] });
  });

  it('restores online when a login races the offline write', async () => {
    let finishOffline: () => void = () => {};
    const h = createHarness({
      markOffline: jest.fn(() => new Promise<void>(resolve => { finishOffline = resolve; })),
    });
    await login(h, USER);
    disconnect(h, USER);
    await advance(DECISION_MS);
    expect(h.deps.markOffline).toHaveBeenCalledTimes(1);
    h.deps.markOnline.mockClear();

    await login(h, USER);
    finishOffline();
    await advance(0);

    // once by the login, once to repair the late offline write
    expect(h.deps.markOnline).toHaveBeenCalledTimes(2);
    expect(h.tracker.touchSets()).toEqual({ connected: [USER], grace: [] });
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

    await advance(DECISION_MS * 2);
    expect(h.deps.markOffline).not.toHaveBeenCalled();
  });

  it('skips a decision that fires after shutdown began', async () => {
    const h = createHarness();
    await login(h, USER);
    disconnect(h, USER);
    h.setShuttingDown(true);
    await advance(DECISION_MS);
    expect(h.deps.probeCluster).not.toHaveBeenCalled();
    expect(h.deps.markOffline).not.toHaveBeenCalled();
  });
});

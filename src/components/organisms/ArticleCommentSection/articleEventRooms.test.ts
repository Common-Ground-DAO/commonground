// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it, vi } from 'vitest';
import { flushMicrotasks } from 'test/deferred';
import type { LiveKind } from 'data/appstate/transport';
import { articleRoomKey, createArticleRoomRegistry } from './articleEventRooms';

const ACCESS = { articleId: 'a1', channelId: 'ch1', articleCommunityId: 'c1' };
const OTHER = { articleId: 'a2', channelId: 'ch2', articleUserId: 'u1' };

function setup(opts: { live?: boolean; holdJoins?: boolean } = {}) {
  const liveListeners = new Set<(kind: LiveKind) => void>();
  const transport = {
    live: opts.live ?? true,
    onLive(listener: (kind: LiveKind) => void) {
      liveListeners.add(listener);
      return () => { liveListeners.delete(listener); };
    },
  };
  const calls: string[] = [];
  const heldJoins: (() => void)[] = [];
  const registry = createArticleRoomRegistry({
    transport,
    join: vi.fn(access => {
      calls.push(`join ${access.articleId}`);
      if (!opts.holdJoins) return Promise.resolve();
      return new Promise<void>(resolve => heldJoins.push(resolve));
    }),
    leave: vi.fn(access => {
      calls.push(`leave ${access.articleId}`);
      return Promise.resolve();
    }),
  });
  const goLive = (kind: LiveKind = 'restored') => {
    transport.live = true;
    for (const l of [...liveListeners]) l(kind);
  };
  return { registry, transport, calls, heldJoins, goLive, liveListeners };
}

describe('article event rooms', () => {
  it('two sections of one article share the room; it is left after the last one', async () => {
    const { registry, calls } = setup();
    const releaseA = registry.acquire(ACCESS);
    const releaseB = registry.acquire({ ...ACCESS });
    await flushMicrotasks();
    expect(calls).toEqual(['join a1']);
    expect(registry.holders(ACCESS)).toBe(2);

    releaseA();
    releaseA(); // idempotent
    await flushMicrotasks();
    expect(calls).toEqual(['join a1']);
    expect(registry.holders(ACCESS)).toBe(1);

    releaseB();
    await flushMicrotasks();
    expect(calls).toEqual(['join a1', 'leave a1']);
    expect(registry.holders(ACCESS)).toBe(0);
  });

  it('rooms of different articles are independent', async () => {
    const { registry, calls } = setup();
    const releaseA = registry.acquire(ACCESS);
    const releaseB = registry.acquire(OTHER);
    await flushMicrotasks();
    releaseA();
    await flushMicrotasks();
    expect(calls).toEqual(['join a1', 'join a2', 'leave a1']);
    releaseB();
    await flushMicrotasks();
    expect(calls.at(-1)).toBe('leave a2');
    expect(articleRoomKey(ACCESS)).not.toBe(articleRoomKey(OTHER));
  });

  it('joins once live and again on every live transition while held', async () => {
    const { registry, calls, transport, goLive, liveListeners } = setup({ live: false });
    const release = registry.acquire(ACCESS);
    await flushMicrotasks();
    expect(calls).toEqual([]);
    goLive('established');
    await flushMicrotasks();
    goLive('user');
    await flushMicrotasks();
    expect(calls).toEqual(['join a1', 'join a1']);

    // the socket is gone: nothing to leave on it
    transport.live = false;
    release();
    await flushMicrotasks();
    expect(calls).toEqual(['join a1', 'join a1']);
    expect(liveListeners.size).toBe(0);
  });

  it('a release while the join is in flight leaves once it is acked', async () => {
    const { registry, calls, heldJoins } = setup({ holdJoins: true });
    const release = registry.acquire(ACCESS);
    release();
    await flushMicrotasks();
    expect(calls).toEqual(['join a1']);
    heldJoins.shift()!();
    await flushMicrotasks();
    expect(calls).toEqual(['join a1', 'leave a1']);
  });

  it('re-acquired while the join is in flight: the room stays joined', async () => {
    const { registry, calls, heldJoins } = setup({ holdJoins: true });
    registry.acquire(ACCESS)();
    const release = registry.acquire(ACCESS);
    heldJoins.shift()!();
    await flushMicrotasks();
    expect(calls).toEqual(['join a1']);
    expect(registry.holders(ACCESS)).toBe(1);
    release();
    await flushMicrotasks();
    expect(calls).toEqual(['join a1', 'leave a1']);
  });
});

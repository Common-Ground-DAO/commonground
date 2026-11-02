// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it } from 'vitest';
import { emptyReadState, isoTime, mergeReadState, sameReadState, UNREAD_CAP } from './mergeReadState';
import { COUNTED_SEQS_MAX, type ChannelReadState, type ReadStateInput } from './types';

const C = 'ch-1';
const T = (minute: number) => new Date(Date.UTC(2026, 10, 2, 12, minute)).toISOString();

function state(partial: Partial<ChannelReadState>): ChannelReadState {
  return { ...emptyReadState(C), ...partial };
}
function snap(partial: Partial<Extract<ReadStateInput, { kind: 'snapshot' }>>): ReadStateInput {
  return { kind: 'snapshot', channelId: C, lastRead: null, unread: 0, lastMessageDate: null, ...partial };
}
function msg(createdAt: string, partial: Partial<Extract<ReadStateInput, { kind: 'message' }>> = {}): ReadStateInput {
  return { kind: 'message', channelId: C, messageId: `m-${createdAt}`, createdAt, own: false, ...partial };
}
function lr(lastRead: string, partial: Partial<Extract<ReadStateInput, { kind: 'lastRead' }>> = {}): ReadStateInput {
  return { kind: 'lastRead', channelId: C, lastRead, ...partial };
}
const fold = (inputs: ReadStateInput[], start?: ChannelReadState) =>
  inputs.reduce<ChannelReadState | undefined>((s, i) => mergeReadState(s, i), start)!;

describe('mergeReadState: basics', () => {
  it('starts from an empty state and never mutates the stored one', () => {
    const stored = state({ lastRead: T(1), lastMessageDate: T(5), unread: 2, seq: 3, counted: [4] });
    const copy = structuredClone(stored);
    const out = mergeReadState(stored, msg(T(6), { syncSeq: 5 }));
    expect(stored).toEqual(copy);
    expect(out).not.toBe(stored);
    expect(mergeReadState(undefined, snap({}))).toEqual(emptyReadState(C));
  });

  it('compares dates by Date.parse, not as strings', () => {
    const a = '2026-11-02T12:00:00.5Z';
    const b = '2026-11-02T12:00:00.123456Z';
    const out = mergeReadState(state({ lastRead: a }), lr(b));
    expect(out.lastRead).toBe(a);
    expect(isoTime('garbage')).toBe(-Infinity);
    expect(isoTime(null)).toBe(-Infinity);
  });

  it('ignores unparsable dates instead of letting them win', () => {
    const out = mergeReadState(state({ lastRead: T(3) }), lr('not a date'));
    expect(out.lastRead).toBe(T(3));
  });

  it('sameReadState compares structurally', () => {
    const a = state({ counted: [1, 2] });
    expect(sameReadState(a, { ...a, counted: [1, 2] })).toBe(true);
    expect(sameReadState(a, { ...a, counted: [1, 3] })).toBe(false);
    expect(sameReadState(a, undefined)).toBe(false);
    expect(sameReadState(undefined, undefined)).toBe(true);
  });
});

describe('mergeReadState: lastRead is a max of every source', () => {
  it.each<[string, ReadStateInput]>([
    ['seq snapshot', snap({ lastRead: T(1), syncSeq: 9, unread: 0 })],
    ['plain snapshot', snap({ lastRead: T(1) })],
    ['lastRead event', lr(T(1), { unread: 0, syncSeq: 9 })],
    ['lastRead without seq', lr(T(1))],
  ])('an older %s never moves lastRead back', (_name, input) => {
    const out = mergeReadState(state({ lastRead: T(5), lastMessageDate: T(5) }), input);
    expect(out.lastRead).toBe(T(5));
  });

  it('own messages raise lastRead (the server marks own posts read)', () => {
    const out = mergeReadState(state({ lastRead: T(1), lastMessageDate: T(3), unread: 2, seq: 1, counted: [2, 3] }), msg(T(4), { own: true, syncSeq: 4 }));
    expect(out).toMatchObject({ lastRead: T(4), lastMessageDate: T(4), unread: 0, counted: [] });
  });

  it('an own message older than lastRead keeps lastRead', () => {
    const out = mergeReadState(state({ lastRead: T(5), lastMessageDate: T(5) }), msg(T(2), { own: true }));
    expect(out.lastRead).toBe(T(5));
  });
});

describe('mergeReadState: snapshot with syncSeq', () => {
  it('is taken when it knows our lastRead and is not older than our seq', () => {
    const out = mergeReadState(state({ lastRead: T(1), seq: 3 }), snap({ lastRead: T(1), unread: 4, syncSeq: 5, lastMessageDate: T(9) }));
    expect(out).toMatchObject({ unread: 4, seq: 5, counted: [], lastMessageDate: T(9) });
  });

  it('keeps live-counted seqs above S (messages counted during the round trip)', () => {
    // snapshot requested at seq 10; meanwhile live messages 11 and 12 were counted
    let s = state({ lastRead: T(1), lastMessageDate: T(1) });
    s = mergeReadState(s, msg(T(10), { syncSeq: 11 }));
    s = mergeReadState(s, msg(T(11), { syncSeq: 12 }));
    expect(s).toMatchObject({ unread: 2, counted: [11, 12], seq: 0 });
    const out = mergeReadState(s, snap({ lastRead: T(1), unread: 3, syncSeq: 10, lastMessageDate: T(9) }));
    expect(out).toMatchObject({ unread: 5, seq: 10, counted: [11, 12], lastMessageDate: T(11) });
  });

  it('drops counted seqs at or below S (the snapshot already includes them)', () => {
    let s = state({ lastRead: T(1), lastMessageDate: T(1) });
    s = mergeReadState(s, msg(T(10), { syncSeq: 11 }));
    s = mergeReadState(s, msg(T(11), { syncSeq: 12 }));
    const out = mergeReadState(s, snap({ lastRead: T(1), unread: 2, syncSeq: 12, lastMessageDate: T(11) }));
    expect(out).toMatchObject({ unread: 2, seq: 12, counted: [] });
  });

  it('is ignored for the count when older than our lastRead (a local mark is newer)', () => {
    const s = state({ lastRead: T(9), lastMessageDate: T(10), unread: 1, seq: 4, counted: [5] });
    const out = mergeReadState(s, snap({ lastRead: T(2), unread: 7, syncSeq: 6, lastMessageDate: T(10) }));
    expect(out).toMatchObject({ lastRead: T(9), unread: 1, seq: 4, counted: [5] });
  });

  it('is ignored for the count when its seq is below ours', () => {
    const s = state({ lastRead: T(1), lastMessageDate: T(10), unread: 1, seq: 8 });
    const out = mergeReadState(s, snap({ lastRead: T(1), unread: 7, syncSeq: 6, lastMessageDate: T(12) }));
    expect(out).toMatchObject({ unread: 1, seq: 8, lastMessageDate: T(12) });
  });

  it('two snapshots out of order: the older one does not undo the newer', () => {
    const newer = snap({ lastRead: T(5), unread: 0, syncSeq: 20, lastMessageDate: T(5) });
    const older = snap({ lastRead: T(1), unread: 6, syncSeq: 12, lastMessageDate: T(4) });
    const inOrder = fold([older, newer]);
    const reversed = fold([newer, older]);
    expect(reversed).toEqual(inOrder);
    expect(reversed).toMatchObject({ lastRead: T(5), unread: 0, seq: 20, lastMessageDate: T(5) });
  });

  it('two snapshots with the same lastRead out of order: the higher seq wins', () => {
    const a = snap({ lastRead: T(1), unread: 2, syncSeq: 10, lastMessageDate: T(4) });
    const b = snap({ lastRead: T(1), unread: 3, syncSeq: 11, lastMessageDate: T(5) });
    expect(fold([b, a])).toEqual(fold([a, b]));
    expect(fold([b, a])).toMatchObject({ unread: 3, seq: 11 });
  });

  it('an equal seq snapshot is taken again (idempotent re-apply)', () => {
    const input = snap({ lastRead: T(1), unread: 2, syncSeq: 10, lastMessageDate: T(4) });
    expect(fold([input, input])).toEqual(fold([input]));
  });

  it('syncSeq 0 counts as a seq (server channel without sequence yet)', () => {
    const out = mergeReadState(undefined, snap({ lastRead: null, unread: 3, syncSeq: 0, lastMessageDate: T(4) }));
    expect(out).toMatchObject({ unread: 3, seq: 0 });
  });
});

describe('mergeReadState: snapshot without syncSeq (older snapshots)', () => {
  it('sets unread while no seq is known', () => {
    const out = mergeReadState(state({ lastRead: T(1) }), snap({ lastRead: T(1), unread: 4, lastMessageDate: T(3) }));
    expect(out).toMatchObject({ unread: 4, seq: 0, lastMessageDate: T(3) });
  });

  it('never touches the count once a seq is known', () => {
    const s = state({ lastRead: T(1), lastMessageDate: T(3), unread: 2, seq: 7, counted: [8] });
    const out = mergeReadState(s, snap({ lastRead: T(1), unread: 9, lastMessageDate: T(6) }));
    expect(out).toMatchObject({ unread: 2, seq: 7, counted: [8], lastMessageDate: T(6) });
  });

  it('a snapshot fetched before a live message does not undo its count', () => {
    let s = state({ lastRead: T(2), lastMessageDate: T(2), unread: 0 });
    s = mergeReadState(s, msg(T(3)));
    expect(s.unread).toBe(1);
    const stale = mergeReadState(s, snap({ lastRead: T(2), unread: 0, lastMessageDate: T(2) }));
    expect(stale).toMatchObject({ unread: 1, lastMessageDate: T(3), lastRead: T(2) });
  });

  it('a snapshot that knows the newest message is taken (equal or newer lastMessageDate)', () => {
    const s = state({ lastRead: T(2), lastMessageDate: T(3), unread: 1 });
    expect(mergeReadState(s, snap({ lastRead: T(2), unread: 4, lastMessageDate: T(3) })).unread).toBe(4);
    expect(mergeReadState(s, snap({ lastRead: T(2), unread: 5, lastMessageDate: T(6) }))).toMatchObject({ unread: 5, lastMessageDate: T(6) });
  });

  it('a snapshot without lastMessageDate never sets the count over a known one', () => {
    const s = state({ lastRead: T(2), lastMessageDate: T(3), unread: 1 });
    expect(mergeReadState(s, snap({ lastRead: T(2), unread: 0, lastMessageDate: null })).unread).toBe(1);
  });

  it('is ignored for the count when older than our lastRead', () => {
    const s = state({ lastRead: T(4), lastMessageDate: T(6), unread: 1 });
    const out = mergeReadState(s, snap({ lastRead: T(2), unread: 9, lastMessageDate: T(6) }));
    expect(out.unread).toBe(1);
  });
});

describe('mergeReadState: lastRead inputs', () => {
  it('a seq-carrying count (setChannelLastRead response / event) is taken like a snapshot', () => {
    const s = state({ lastRead: T(1), lastMessageDate: T(8), unread: 5, seq: 3, counted: [4, 9] });
    const out = mergeReadState(s, lr(T(6), { unread: 1, syncSeq: 7 }));
    expect(out).toMatchObject({ lastRead: T(6), unread: 2, seq: 7, counted: [9] });
  });

  it('without syncSeq only the lastRead is merged', () => {
    const s = state({ lastRead: T(1), lastMessageDate: T(8), unread: 5, seq: 3 });
    const out = mergeReadState(s, lr(T(6), { unread: 0 }));
    expect(out).toMatchObject({ lastRead: T(6), unread: 5, seq: 3 });
  });

  it('a count older than our lastRead is not trusted', () => {
    const s = state({ lastRead: T(7), lastMessageDate: T(8), unread: 1, seq: 3 });
    const out = mergeReadState(s, lr(T(6), { unread: 4, syncSeq: 9 }));
    expect(out).toMatchObject({ lastRead: T(7), unread: 1, seq: 3 });
  });

  it('a count at a lower seq is not trusted', () => {
    const s = state({ lastRead: T(1), lastMessageDate: T(8), unread: 1, seq: 10 });
    const out = mergeReadState(s, lr(T(6), { unread: 4, syncSeq: 9 }));
    expect(out).toMatchObject({ lastRead: T(6), unread: 1, seq: 10 });
  });

  it('reading up to lastMessageDate clears the count', () => {
    const s = state({ lastRead: T(1), lastMessageDate: T(8), unread: 5, seq: 3, counted: [4] });
    expect(mergeReadState(s, lr(T(8)))).toMatchObject({ unread: 0, counted: [] });
  });
});

describe('mergeReadState: live messages and the counted rule', () => {
  it('counts a message of another user newer than lastRead once per seq', () => {
    const s = state({ lastRead: T(1), lastMessageDate: T(1), seq: 5 });
    const once = mergeReadState(s, msg(T(2), { syncSeq: 6 }));
    const twice = mergeReadState(once, msg(T(2), { syncSeq: 6 }));
    expect(once).toMatchObject({ unread: 1, counted: [6], lastMessageDate: T(2) });
    expect(twice).toEqual(once);
  });

  it('does not count a seq already included in the server count', () => {
    const s = state({ lastRead: T(1), lastMessageDate: T(3), seq: 6, unread: 2 });
    expect(mergeReadState(s, msg(T(3), { syncSeq: 6 })).unread).toBe(2);
    expect(mergeReadState(s, msg(T(2), { syncSeq: 4 })).unread).toBe(2);
  });

  it('does not count a message at or before lastRead', () => {
    const s = state({ lastRead: T(5), lastMessageDate: T(5) });
    expect(mergeReadState(s, msg(T(5), { syncSeq: 9 })).unread).toBe(0);
    expect(mergeReadState(s, msg(T(3), { syncSeq: 9 })).unread).toBe(0);
  });

  it('a late older message still raises lastMessageDate only by max', () => {
    const s = state({ lastRead: T(1), lastMessageDate: T(9) });
    const out = mergeReadState(s, msg(T(4), { syncSeq: 3 }));
    expect(out.lastMessageDate).toBe(T(9));
    expect(out.unread).toBe(1);
  });

  it('without syncSeq (old server) counts only messages newer than lastMessageDate', () => {
    const s = state({ lastRead: T(1), lastMessageDate: T(4), unread: 1 });
    const dup = mergeReadState(s, msg(T(4)));
    expect(dup.unread).toBe(1);
    const fresh = mergeReadState(dup, msg(T(5)));
    expect(fresh).toMatchObject({ unread: 2, lastMessageDate: T(5) });
    expect(mergeReadState(fresh, msg(T(5))).unread).toBe(2);
  });

  it('duplicate events in any order converge', () => {
    const inputs = [msg(T(2), { syncSeq: 2 }), msg(T(3), { syncSeq: 3 }), msg(T(2), { syncSeq: 2 }), msg(T(4), { syncSeq: 4 }), msg(T(3), { syncSeq: 3 })];
    const start = state({ lastRead: T(1), lastMessageDate: T(1), seq: 1 });
    const a = fold(inputs, start);
    const b = fold([...inputs].reverse(), start);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ unread: 3, counted: [2, 3, 4], lastMessageDate: T(4) });
  });

  it('keeps at most COUNTED_SEQS_MAX of the highest seqs', () => {
    const inputs = Array.from({ length: COUNTED_SEQS_MAX + 5 }, (_, i) => msg(new Date(Date.UTC(2026, 10, 2, 13, 0, i)).toISOString(), { syncSeq: i + 1 }));
    const out = fold(inputs, state({ lastRead: T(1), lastMessageDate: T(1) }));
    expect(out.counted).toHaveLength(COUNTED_SEQS_MAX);
    expect(out.counted[0]).toBe(6);
    expect(out.counted.at(-1)).toBe(COUNTED_SEQS_MAX + 5);
    expect(out.unread).toBe(COUNTED_SEQS_MAX + 5);
  });

  it('counted stays ascending when events arrive out of order', () => {
    const out = fold([msg(T(4), { syncSeq: 9 }), msg(T(3), { syncSeq: 7 }), msg(T(5), { syncSeq: 8 })], state({ lastRead: T(1), lastMessageDate: T(1) }));
    expect(out.counted).toEqual([7, 8, 9]);
  });

  it('caps unread at the server cap', () => {
    const s = state({ lastRead: T(1), lastMessageDate: T(2), unread: UNREAD_CAP, seq: 1 });
    expect(mergeReadState(s, msg(T(3), { syncSeq: 2 })).unread).toBe(UNREAD_CAP);
    expect(mergeReadState(undefined, snap({ unread: 5000, syncSeq: 1, lastMessageDate: T(3) })).unread).toBe(UNREAD_CAP);
  });

  it('coerces bad counts to a sane number', () => {
    expect(mergeReadState(undefined, snap({ unread: -3, syncSeq: 1, lastMessageDate: T(3) })).unread).toBe(0);
    expect(mergeReadState(undefined, snap({ unread: Number.NaN, syncSeq: 1, lastMessageDate: T(3) })).unread).toBe(0);
    expect(mergeReadState(undefined, snap({ unread: '4' as unknown as number, syncSeq: 1, lastMessageDate: T(3) })).unread).toBe(4);
  });
});

describe('mergeReadState: final rule', () => {
  it('lastRead >= lastMessageDate clears unread and counted', () => {
    const s = state({ lastRead: T(1), lastMessageDate: T(3), unread: 3, seq: 2, counted: [3] });
    expect(mergeReadState(s, snap({ lastRead: T(3), syncSeq: 1, unread: 3, lastMessageDate: T(3) }))).toMatchObject({ unread: 0, counted: [] });
  });

  it('never read and no message means no unread', () => {
    expect(mergeReadState(undefined, snap({ unread: 3 }))).toMatchObject({ unread: 0 });
  });

  it('never read with messages keeps the server count (DMs)', () => {
    expect(mergeReadState(undefined, snap({ unread: 3, lastMessageDate: T(2), syncSeq: 4 }))).toMatchObject({ unread: 3, seq: 4 });
  });
});

describe('mergeReadState: convergence across tabs', () => {
  it('a seq snapshot, a mark and live events converge whatever the order', () => {
    const inputs: ReadStateInput[] = [
      snap({ lastRead: T(1), unread: 2, syncSeq: 10, lastMessageDate: T(3) }),
      msg(T(4), { syncSeq: 11 }),
      msg(T(5), { syncSeq: 12 }),
      lr(T(5), { unread: 0, syncSeq: 12 }),
      msg(T(6), { syncSeq: 13 }),
    ];
    const orders = [
      [0, 1, 2, 3, 4],
      [1, 2, 0, 3, 4],
      [1, 2, 4, 0, 3],
      [3, 0, 1, 2, 4],
    ];
    const results = orders.map(order => fold(order.map(i => inputs[i])));
    for (const r of results) {
      expect(r.lastRead).toBe(T(5));
      expect(r.lastMessageDate).toBe(T(6));
      expect(r.unread).toBe(1);
    }
  });
});

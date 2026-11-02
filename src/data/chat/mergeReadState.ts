// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * The one read-state merge (rules: ReadStateInput in ./types.ts). Pure and
 * deterministic, so the in-memory ReadStateStore and the Dexie writers of the
 * community/chat databases (inside their transaction) converge when several
 * tabs apply the same inputs in any order.
 */

import { COUNTED_SEQS_MAX, type ChannelReadState, type ReadStateInput } from './types';

/** API.Messages.UnreadCap as a value */
export const UNREAD_CAP: API.Messages.UnreadCap = 999;

/** An empty read state (never read, nothing counted). */
export function emptyReadState(channelId: string): ChannelReadState {
  return { channelId, lastRead: null, unread: 0, seq: 0, counted: [], lastMessageDate: null };
}

/** ISO date -> ms; null and unparsable values count as oldest. */
export function isoTime(value: string | null | undefined): number {
  if (value === null || value === undefined) return -Infinity;
  const t = Date.parse(value);
  return Number.isNaN(t) ? -Infinity : t;
}

/** the later of two ISO dates (by Date.parse); on a tie the stored one is kept */
function maxIso(stored: string | null, incoming: string | null | undefined): string | null {
  if (incoming === null || incoming === undefined || Number.isNaN(Date.parse(incoming))) return stored;
  return isoTime(incoming) > isoTime(stored) ? incoming : stored;
}

function clampCount(value: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, UNREAD_CAP);
}

function isSeq(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Merge one input into the stored read state of its channel. Never mutates
 * `stored`; always returns a new object (compare with `sameReadState`).
 */
export function mergeReadState(stored: ChannelReadState | undefined, input: ReadStateInput): ChannelReadState {
  const base = stored ?? emptyReadState(input.channelId);
  const storedLastRead = isoTime(base.lastRead);

  let lastRead = base.lastRead;
  let unread = base.unread;
  let seq = base.seq;
  let counted = base.counted;
  let lastMessageDate = base.lastMessageDate;

  /** a server count valid at seq `s` that knows at least our lastRead */
  const takeSeqCount = (count: number, s: number) => {
    const after = counted.filter(c => c > s);
    unread = clampCount(count) + after.length;
    seq = s;
    counted = after;
  };

  switch (input.kind) {
    case 'snapshot': {
      const knowsOurLastRead = isoTime(input.lastRead) >= storedLastRead;
      if (isSeq(input.syncSeq)) {
        if (knowsOurLastRead && input.syncSeq >= base.seq) {
          takeSeqCount(input.unread, input.syncSeq);
        }
      } else if (base.seq === 0 && knowsOurLastRead && isoTime(input.lastMessageDate) >= isoTime(base.lastMessageDate)) {
        // a seq-less snapshot older than a live message must not undo its count
        unread = clampCount(input.unread);
      }
      lastRead = maxIso(lastRead, input.lastRead);
      lastMessageDate = maxIso(lastMessageDate, input.lastMessageDate);
      break;
    }
    case 'lastRead': {
      if (
        input.unread !== undefined
        && isSeq(input.syncSeq)
        && input.syncSeq >= base.seq
        && isoTime(input.lastRead) >= storedLastRead
      ) {
        takeSeqCount(input.unread, input.syncSeq);
      }
      lastRead = maxIso(lastRead, input.lastRead);
      break;
    }
    case 'message': {
      const createdAt = isoTime(input.createdAt);
      if (input.own) {
        lastRead = maxIso(lastRead, input.createdAt);
      } else if (createdAt > isoTime(lastRead)) {
        if (isSeq(input.syncSeq)) {
          const s = input.syncSeq;
          if (s > seq && !counted.includes(s)) {
            unread = clampCount(unread + 1);
            counted = [...counted, s].sort((a, b) => a - b);
            if (counted.length > COUNTED_SEQS_MAX) counted = counted.slice(counted.length - COUNTED_SEQS_MAX);
          }
        } else if (createdAt > isoTime(lastMessageDate)) {
          unread = clampCount(unread + 1);
        }
      }
      lastMessageDate = maxIso(lastMessageDate, input.createdAt);
      break;
    }
  }

  if (isoTime(lastRead) >= isoTime(lastMessageDate)) {
    unread = 0;
    counted = [];
  }

  return {
    channelId: base.channelId,
    lastRead,
    unread: clampCount(unread),
    seq,
    counted,
    lastMessageDate,
  };
}

/** structural equality of two read states (to skip no-op writes/notifications) */
export function sameReadState(a: ChannelReadState | undefined, b: ChannelReadState | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.channelId === b.channelId
    && a.lastRead === b.lastRead
    && a.unread === b.unread
    && a.seq === b.seq
    && a.lastMessageDate === b.lastMessageDate
    && a.counted.length === b.counted.length
    && a.counted.every((s, i) => s === b.counted[i]);
}

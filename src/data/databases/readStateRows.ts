// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * Read state as stored on the rows of the shared Dexie databases: community
 * channels (`communities` DB, table `channels`) and DMs (`chat` DB, table
 * `chats`). Every writer of `unread`/`lastRead`/`lastMessageDate` goes through
 * `mergeReadState` (data/chat/mergeReadState.ts) inside its rw transaction,
 * so several tabs applying the same inputs in any order converge.
 *
 * The extra fields are plain (non-indexed) properties, so the Dexie schemas
 * keep their versions: rows written before have none and read as seq 0 /
 * nothing counted, and tabs of an older build keep their open connections
 * (a version bump would close them). The UI keeps reading `unread`,
 * `lastRead`, `lastMessageDate` (channels) and `unread`, `lastMessage` (DMs).
 */

import { isoTime, mergeReadState } from 'data/chat/mergeReadState';
import type { ChannelReadState, ReadStateInput } from 'data/chat/types';

/** read-state bookkeeping stored next to `unread`/`lastRead` */
export type StoredReadStateFields = {
  /** ChannelReadState.seq (absent = 0) */
  readSeq?: number;
  /** ChannelReadState.counted (absent = []) */
  readCounted?: number[];
  /**
   * The highest lastRead the server is known to hold (ISO): from server
   * snapshots, chat-sync lastRead answers (with a count) and own messages
   * (the server marks own posts read). `lastRead` can be ahead of it when a
   * local mark never reached the server. (The send decision is the in-memory
   * ReadStateStore's, from its own server-acknowledged value.) Absent on
   * older rows.
   */
  serverLastRead?: string | null;
};

export type StoredChannel = Models.Community.Channel & StoredReadStateFields;

export type StoredChat = Models.Chat.Chat & StoredReadStateFields & {
  /**
   * ChannelReadState.lastMessageDate: max createdAt (ISO) of every message
   * seen; `lastMessage` alone can lag behind it (a sync snapshot knows the
   * date but not the message).
   */
  lastMessageDate?: string | null;
};

export type ReadStateRowFields = {
  lastRead: string;
  unread: number;
  lastMessageDate: string | null;
  readSeq: number;
  readCounted: number[];
};

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function laterIso(a: string | null, b: string | null): string | null {
  return isoTime(b) > isoTime(a) ? b : a;
}

/** the row's serverLastRead after applying `input` */
export function serverLastReadAfter(stored: string | null | undefined, input: ReadStateInput): string | null {
  const current = stored ?? null;
  switch (input.kind) {
    case 'snapshot':
      return laterIso(current, toIso(input.lastRead));
    case 'lastRead':
      // with a count it is a server answer (setChannelLastRead response or a
      // chat-sync cliChannelLastRead); without, it may be a local mark
      return input.unread !== undefined ? laterIso(current, toIso(input.lastRead)) : current;
    case 'message':
      return input.own ? laterIso(current, toIso(input.createdAt)) : current;
  }
}

export function channelRowReadState(row: StoredChannel): ChannelReadState {
  return {
    channelId: row.channelId,
    lastRead: row.lastRead ?? null,
    unread: row.unread ?? 0,
    seq: row.readSeq ?? 0,
    counted: row.readCounted ?? [],
    lastMessageDate: row.lastMessageDate ?? null,
  };
}

export function chatRowReadState(row: StoredChat): ChannelReadState {
  return {
    channelId: row.channelId,
    lastRead: row.lastRead ?? null,
    unread: row.unread ?? 0,
    seq: row.readSeq ?? 0,
    counted: row.readCounted ?? [],
    lastMessageDate: laterIso(row.lastMessageDate ?? null, toIso(row.lastMessage?.createdAt)),
  };
}

/** the row fields that hold a ChannelReadState (null lastRead kept as stored) */
export function readStateRowFields(state: ChannelReadState): ReadStateRowFields {
  return {
    // the model types lastRead as string; never-read rows hold null
    lastRead: state.lastRead as string,
    unread: state.unread,
    lastMessageDate: state.lastMessageDate,
    readSeq: state.seq,
    readCounted: state.counted,
  };
}

/**
 * A server snapshot row (no syncSeq) as a ReadStateInput. A row without an
 * `unread` field (e.g. a channel event) carries no count: it is passed as
 * the stored count, so only lastRead and lastMessageDate merge.
 */
function snapshotInput(
  stored: ChannelReadState | undefined,
  row: { channelId: string; lastRead?: string | null; unread?: number | string | null },
  lastMessageDate: string | null,
): ReadStateInput {
  const hasCount = row.unread !== undefined && row.unread !== null;
  return {
    kind: 'snapshot',
    channelId: row.channelId,
    lastRead: row.lastRead ?? null,
    // counts can arrive as strings
    unread: hasCount ? Number(row.unread) : (stored?.unread ?? 0),
    lastMessageDate,
  };
}

function mergeSnapshot(stored: ChannelReadState | undefined, input: (s: ChannelReadState | undefined) => ReadStateInput): ChannelReadState {
  return mergeReadState(stored, input(stored));
}

/**
 * A community channel from a server snapshot (login data, detail view,
 * channel event), merged with the stored row: entity fields from the
 * snapshot, read state by mergeReadState (a newer local lastRead and its
 * cleared count are kept).
 */
export function mergeChannelSnapshot(stored: StoredChannel | undefined, incoming: Models.Community.Channel): StoredChannel {
  const state = mergeSnapshot(
    stored ? channelRowReadState(stored) : undefined,
    s => snapshotInput(s, incoming, incoming.lastMessageDate ?? null),
  );
  return {
    ...incoming,
    ...readStateRowFields(state),
    serverLastRead: laterIso(stored?.serverLastRead ?? null, toIso(incoming.lastRead)),
  };
}

/** Only merges the snapshot's read state into the stored row (entity fields stay). */
export function mergeChannelSnapshotReadState(stored: StoredChannel, incoming: Models.Community.Channel): StoredChannel {
  const state = mergeSnapshot(channelRowReadState(stored), s => snapshotInput(s, incoming, incoming.lastMessageDate ?? null));
  return {
    ...stored,
    ...readStateRowFields(state),
    serverLastRead: laterIso(stored.serverLastRead ?? null, toIso(incoming.lastRead)),
  };
}

/** the newer of two last messages (a later createdAt; same message: later updatedAt) */
export function newerLastMessage(stored: Models.Message.Message | null | undefined, incoming: Models.Message.Message | null): Models.Message.Message | null {
  if (!stored) return incoming;
  if (!incoming) return stored;
  const storedCreated = isoTime(toIso(stored.createdAt));
  const incomingCreated = isoTime(toIso(incoming.createdAt));
  if (storedCreated !== incomingCreated) return storedCreated > incomingCreated ? stored : incoming;
  return isoTime(toIso(stored.updatedAt)) > isoTime(toIso(incoming.updatedAt)) ? stored : incoming;
}

/**
 * A DM from a server snapshot (getChats/login, chat event, startChat), merged
 * with the stored row: entity fields from the snapshot, `lastMessage` the
 * newer one, read state by mergeReadState.
 */
export function mergeChatSnapshot(stored: StoredChat | undefined, incoming: Models.Chat.Chat): StoredChat {
  const state = mergeSnapshot(
    stored ? chatRowReadState(stored) : undefined,
    s => snapshotInput(s, incoming, toIso(incoming.lastMessage?.createdAt)),
  );
  return {
    ...incoming,
    lastMessage: newerLastMessage(stored?.lastMessage, incoming.lastMessage),
    ...readStateRowFields(state),
    serverLastRead: laterIso(stored?.serverLastRead ?? null, toIso(incoming.lastRead)),
  };
}

/** a chat (or chat event payload) from the API with Date fields on its last message */
export function chatFromApi(chat: Models.Chat.ChatFromApi): Models.Chat.Chat {
  return {
    ...chat,
    lastMessage: chat.lastMessage !== null && chat.lastMessage !== undefined
      ? {
        ...chat.lastMessage,
        createdAt: new Date(chat.lastMessage.createdAt),
        updatedAt: new Date(chat.lastMessage.updatedAt),
      }
      : null,
  };
}

/** the `message` input for a received message (live event or own send) */
export function messageInput(channelId: string, message: Models.Message.Message, own: boolean): ReadStateInput {
  return {
    kind: 'message',
    channelId,
    messageId: message.id,
    createdAt: message.createdAt.toISOString(),
    syncSeq: message.syncSeq,
    own,
  };
}

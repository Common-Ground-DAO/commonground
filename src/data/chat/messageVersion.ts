// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * Message versions: conversion from the wire, ordering keys, and the one
 * version rule (VERSION RULE in ./types.ts, ChannelStore) used for every
 * source — pages, getChanges, live events and HTTP responses.
 */

type Message = Models.Message.Message;

/** fields an `update` event or an edit response may carry */
export type MessagePartial = {
  id: string;
  updatedAt: Date;
  syncSeq?: number;
  body?: Models.Message.Body;
  attachments?: Models.Message.Attachment[];
  parentMessageId?: string | null;
  reactions?: Models.Message.Reactions;
  ownReaction?: string | null;
  editedAt?: string | null;
};

function seqOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** ApiMessage (or a `new` event's data) -> Message; extra event fields are dropped */
export function fromApiMessage(api: Models.Message.ApiMessage): Message {
  const message: Message = {
    id: api.id,
    creatorId: api.creatorId,
    channelId: api.channelId,
    body: api.body,
    attachments: api.attachments ?? [],
    editedAt: api.editedAt ?? null,
    createdAt: new Date(api.createdAt),
    updatedAt: new Date(api.updatedAt),
    reactions: api.reactions ?? {},
    ownReaction: api.ownReaction ?? null,
    parentMessageId: api.parentMessageId ?? null,
  };
  const syncSeq = seqOf(api.syncSeq);
  if (syncSeq !== undefined) message.syncSeq = syncSeq;
  return message;
}

/** the data of an `update` event -> MessagePartial (only the fields it carries) */
export function fromUpdateEvent(data: Extract<Events.Message.Message, { action: 'update' }>['data']): MessagePartial {
  const partial: MessagePartial = { id: data.id, updatedAt: new Date(data.updatedAt) };
  const syncSeq = seqOf(data.syncSeq);
  if (syncSeq !== undefined) partial.syncSeq = syncSeq;
  if ('body' in data && data.body !== undefined) partial.body = data.body;
  if ('attachments' in data && data.attachments !== undefined) partial.attachments = data.attachments;
  if ('parentMessageId' in data && data.parentMessageId !== undefined) partial.parentMessageId = data.parentMessageId;
  if ('reactions' in data && data.reactions !== undefined) partial.reactions = data.reactions;
  if ('ownReaction' in data && data.ownReaction !== undefined) partial.ownReaction = data.ownReaction;
  if ('editedAt' in data && data.editedAt !== undefined) partial.editedAt = data.editedAt;
  return partial;
}

/** ordering key of a server item: ascending by (createdAt, id) */
export function compareMessages(a: Pick<Message, 'createdAt' | 'id'>, b: Pick<Message, 'createdAt' | 'id'>): number {
  const d = a.createdAt.getTime() - b.createdAt.getTime();
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type Key = { createdAt: Date; id: string };

export function keyOf(m: Pick<Message, 'createdAt' | 'id'>): Key {
  return { createdAt: m.createdAt, id: m.id };
}

export type VersionVerdict =
  /** incoming replaces/updates the stored one */
  | 'apply'
  /** same version (equal seq, or equal updatedAt without seqs): nothing to do, but it counts as seen */
  | 'same'
  /** incoming is older than the stored one: dropped, its seq is not recorded */
  | 'older';

/** same server content (used to keep object identity for equal-version duplicates) */
export function sameContent(a: Message, b: Message): boolean {
  return a.updatedAt.getTime() === b.updatedAt.getTime()
    && a.createdAt.getTime() === b.createdAt.getTime()
    && a.syncSeq === b.syncSeq
    && a.editedAt === b.editedAt
    && a.parentMessageId === b.parentMessageId
    && a.ownReaction === b.ownReaction
    && a.creatorId === b.creatorId
    && JSON.stringify(a.body) === JSON.stringify(b.body)
    && JSON.stringify(a.attachments) === JSON.stringify(b.attachments)
    && JSON.stringify(a.reactions) === JSON.stringify(b.reactions);
}

/**
 * FULL version rule: replaces on `syncSeq >=`; a seq'd version beats a
 * seq-less one unless the seq-less one has a strictly newer updatedAt; both
 * seq-less: newer or equal updatedAt wins. An equal version with the same
 * content is `same` (keep the stored object); with different content it
 * replaces (e.g. the full row at seq 12 after only the seq-12 reaction delta
 * was applied on top of a stale body).
 */
export function fullVerdict(incoming: Message, stored: Message): VersionVerdict {
  const inSeq = incoming.syncSeq;
  const stSeq = stored.syncSeq;
  const inT = incoming.updatedAt.getTime();
  const stT = stored.updatedAt.getTime();
  let wins: boolean;
  if (inSeq !== undefined && stSeq !== undefined) wins = inSeq >= stSeq;
  else if (inSeq !== undefined) wins = !(stT > inT);
  else if (stSeq !== undefined) wins = inT > stT;
  else wins = inT >= stT;
  if (!wins) return 'older';
  return sameContent(incoming, stored) ? 'same' : 'apply';
}

/**
 * PARTIAL rule: applies only when strictly newer (`syncSeq >`); mixed as
 * for full versions; both seq-less: strictly newer updatedAt.
 */
export function partialVerdict(incoming: Pick<MessagePartial, 'syncSeq' | 'updatedAt'>, stored: Pick<Message, 'syncSeq' | 'updatedAt'>): VersionVerdict {
  const inSeq = incoming.syncSeq;
  const stSeq = stored.syncSeq;
  const inT = incoming.updatedAt.getTime();
  const stT = stored.updatedAt.getTime();
  if (inSeq !== undefined && stSeq !== undefined) {
    if (inSeq > stSeq) return 'apply';
    return inSeq === stSeq ? 'same' : 'older';
  }
  if (inSeq !== undefined) return stT > inT ? 'older' : 'apply';
  if (stSeq !== undefined) return inT > stT ? 'apply' : 'older';
  if (inT > stT) return 'apply';
  return inT === stT ? 'same' : 'older';
}

/** a new object with the partial's fields; syncSeq/updatedAt set to the partial's own */
export function applyPartial(stored: Message, partial: MessagePartial): Message {
  const next: Message = { ...stored, updatedAt: partial.updatedAt };
  if (partial.syncSeq !== undefined) next.syncSeq = partial.syncSeq;
  else delete next.syncSeq;
  if (partial.body !== undefined) next.body = partial.body;
  if (partial.attachments !== undefined) next.attachments = partial.attachments;
  if (partial.parentMessageId !== undefined) next.parentMessageId = partial.parentMessageId;
  if (partial.reactions !== undefined) next.reactions = partial.reactions;
  if (partial.ownReaction !== undefined) next.ownReaction = partial.ownReaction;
  if (partial.editedAt !== undefined) next.editedAt = partial.editedAt;
  return next;
}

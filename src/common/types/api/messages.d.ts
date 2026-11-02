// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare global {
    namespace API {
        namespace Messages {
            type MessageAccess = {
                channelId: string;
                communityId: string;
            } | {
                channelId: string;
                chatId: string;
            } | {
                channelId: string;
                callId: string;
            } | {
                channelId: string;
                articleId: string;
                articleCommunityId: string;
            } | {
                channelId: string;
                articleId: string;
                articleUserId: string;
            };

            namespace createMessage {
                /**
                 * `id` is a client-generated UUID and the idempotency key of
                 * the create (chat-sync): a retry with the same `id` by the
                 * same creator in the same channel succeeds and returns the
                 * stored message, without emitting events or notifications
                 * again. The same `id` used by another user or in another
                 * channel fails with NOT_ALLOWED. Servers before chat-sync
                 * reject a repeated `id` with a database conflict error; a
                 * client that gets an error on a retry checks `messagesById`
                 * before showing "error-send".
                 */
                type Request = {
                    id: string;
                    access: MessageAccess;
                    body: Models.Message.Body;
                    parentMessageId: string | null;
                    attachments: Models.Message.Attachment[];
                };
                type Response = Models.Message.ApiMessage;
            }

            namespace editMessage {
                type Request = {
                    access: MessageAccess;
                    id: string;
                    body?: Models.Message.Body;
                    attachments?: Models.Message.Attachment[];
                    parentMessageId?: string | null;
                };
                type Response = {
                    editedAt: string;
                    attachments?: Models.Message.Attachment[];
                    /** chat-sync: updatedAt of the edited row; absent on older servers */
                    updatedAt?: string;
                    /** chat-sync: syncSeq of the edited row; absent on older servers */
                    syncSeq?: number;
                };
            }

            namespace deleteMessage {
                type Request = {
                    access: MessageAccess;
                    messageId: string;
                    creatorId: string;
                };
                type Response = void;
            }

            namespace deleteAllUserMessages {
                type Request = {
                    access: MessageAccess;
                    creatorId: string;
                }
                type Response = void;
            }

            namespace loadMessages {
                type Request = {
                    access: MessageAccess;
                    order?: 'ASC' | 'DESC';
                    createdBefore?: string;
                    createdAfter?: string;
                };
                type Response = Models.Message.ApiMessage[];
            }

            namespace messagesById {
                type Request = {
                    access: MessageAccess;
                    messageIds: string[];
                };
                type Response = Models.Message.ApiMessage[];
            }

            namespace loadUpdates {
                type Request = {
                    access: MessageAccess;
                    createdStart: string;
                    createdEnd: string;
                    updatedAfter: string;
                };
                type Response = {
                    updated: Models.Message.ApiMessage[];
                    deleted: string[];
                };
            }

            namespace setReaction {
                type Request = {
                    access: MessageAccess;
                    messageId: string;
                    reaction: string;
                }
                type Response = void;
            }

            namespace unsetReaction {
                type Request = {
                    access: MessageAccess;
                    messageId: string;
                }
                type Response = void;
            }

            namespace setChannelLastRead {
                type Request = {
                    access: MessageAccess;
                    /**
                     * ISO date; required (older servers validate it). The
                     * server clamps it to its own `now()` and stores
                     * `GREATEST(stored, new)`.
                     */
                    lastRead: string;
                    /**
                     * Optional (chat-sync): the newest message the client has
                     * seen. When it exists in `access.channelId`, the server
                     * uses that message's `createdAt` instead of `lastRead`
                     * (server clock, independent of client clock skew); an
                     * unknown id falls back to `lastRead`. Older servers reject
                     * unknown keys (strict Joi), so a client sends it only
                     * after the server has shown chat-sync support in this
                     * page load (a successful `getSyncState` or `getChanges`).
                     */
                    messageId?: string;
                }
                /**
                 * chat-sync: the stored (max-merged) `lastRead`, the unread
                 * count after the write (capped like getSyncState) and the
                 * channel syncSeq that count is valid at. Older servers answer
                 * without data (`void`).
                 */
                type Response = {
                    lastRead: string;
                    unread: number;
                    syncSeq?: number;
                } | void;
            }

            /**
             * Catch-up cursor of one channel: format version `1`, then the
             * channel syncSeq up to which the client has applied every change
             * (its contiguous high-water mark). Clients build it themselves
             * (`` `1:${seenSeq}` ``); the server validates
             * `^1:\d{1,18}$`.
             */
            type SyncCursor = `1:${number}`;

            /** Ceiling of every `unread` count the server returns. */
            type UnreadCap = 999;

            /**
             * chat-sync catch-up for one channel: every message change
             * (create, edit, reaction, delete) committed after `cursor`, in
             * commit order. A change list, not a range page: it says nothing
             * about messages that did not change (see the client's merge rules
             * in src/data/chat/types.ts). Session users only (not on the bot
             * allowlist).
             */
            namespace getChanges {
                type Request = {
                    access: MessageAccess;
                    /**
                     * `null` = no cursor yet: always answered with a reset.
                     */
                    cursor: SyncCursor | null;
                    /** 1..200, default 200 */
                    limit?: number;
                };
                type Response = {
                    /** `1:${syncSeq}`, ready to send next time */
                    cursor: SyncCursor;
                    /**
                     * every change up to this channel seq is included: the last
                     * returned seq when `hasMore`, otherwise the channel's
                     * current seq (for a reset: the seq of the snapshot)
                     */
                    syncSeq: number;
                    /**
                     * `true` when `cursor` was `null`, malformed, from another
                     * format version, ahead of the channel's seq (e.g. after a
                     * database restore) or too far behind (more than 500
                     * changes):
                     * `messages` is then the latest page of the channel (up to
                     * 30, newest first, like `loadMessages` DESC),
                     * `deletedIds` is empty, `hasMore` is `false`, and
                     * `cursor`/`syncSeq` were read in the same statement as
                     * the page. The client replaces its latest segment (see
                     * ChannelStore in src/data/chat/types.ts).
                     * `false`: `messages`/`deletedIds` are all changes with
                     * `cursorSeq < syncSeq <= response.syncSeq`, ascending by
                     * `syncSeq`.
                     */
                    reset: boolean;
                    /** more changes after `cursor`; call again with it */
                    hasMore: boolean;
                    /** server `now()` (ISO) */
                    serverTime: string;
                    /** current state of every changed, not deleted message */
                    messages: (Models.Message.ApiMessage & { syncSeq: number })[];
                    /**
                     * messages deleted in that seq range. Deletion is terminal
                     * (soft deletes are never undone), so a tombstone beats
                     * any version of the message.
                     */
                    deletedIds: string[];
                };
            }

            /**
             * chat-sync: read-only snapshot of every channel and DM the user
             * can read, plus the notification count. Unlike
             * `Community/getOwnCommunities` and `Chat/getChats` it writes
             * nothing (no read-state rows are created).
             */
            namespace getSyncState {
                type Request = {
                    /** restrict the answer to these channels (max 500) */
                    channelIds?: string[];
                };
                type ChannelState = {
                    channelId: string;
                    /** set for community channels */
                    communityId?: string;
                    /** set for DMs */
                    chatId?: string;
                    /**
                     * channel sequence at the time of the snapshot; `0` when
                     * the channel has no sequence yet
                     */
                    syncSeq: number;
                    lastMessageDate: string | null;
                    /** stored lastRead (ISO), `null` if never read */
                    lastRead: string | null;
                    /**
                     * messages of others after `lastRead`, capped at
                     * UnreadCap. With `lastRead: null` (today's semantics,
                     * kept): community channels -> `0`; DMs -> all messages
                     * not written by the user.
                     */
                    unread: number;
                };
                type Response = {
                    /** server `now()` (ISO) */
                    serverTime: string;
                    notificationUnreadCount: number;
                    channels: ChannelState[];
                };
            }

            namespace getUrlPreview {
                type Request = {
                    url: string;
                }
                type Response = {
                    title: string;
                    description: string;
                    imageId: string;
                    url: string;
                }
            }

            namespace joinArticleEventRoom {
                type Request = {
                    access: MessageAccess;
                }
                type Response = void;
            }

            namespace leaveArticleEventRoom {
                type Request = {
                    access: MessageAccess;
                }
                type Response = void;
            }
        }
    }
}

export { };
/**
 * Messaging/community types mirrored from the server contract.
 * Sources: src/common/types/models/message.d.ts, chat.d.ts, community.d.ts;
 * request shapes from srv/validators/api/{message,chat,community}.ts.
 */

/** Structured message body — NOT markdown (Models.Message.Body, version 1). */
export interface MessageBody {
  version: "1";
  content: MessageContentNode[];
}

export type MessageContentNode =
  | { type: "text"; value: string; className?: string }
  | { type: "link"; value: string }
  | { type: "richTextLink"; value: string; url: string }
  | { type: "newline" }
  | { type: "mention"; userId: string; alias?: string }
  | { type: string; [extra: string]: unknown };

export type MessageAttachment =
  | { type: "image"; imageId: string; largeImageId: string; [extra: string]: unknown }
  | { type: "linkPreview"; [extra: string]: unknown }
  | { type: "giphy"; [extra: string]: unknown };

/**
 * Where a message lives (API.Message.MessageAccess) — a discriminated pair:
 * community channel, DM chat, call chat, or article comments.
 */
export type MessageAccess =
  | { channelId: string; communityId: string }
  | { channelId: string; chatId: string }
  | { channelId: string; callId: string }
  | { channelId: string; articleId: string; articleCommunityId: string }
  | { channelId: string; articleId: string; articleUserId: string };

export interface ApiMessage {
  id: string;
  creatorId: string;
  channelId: string;
  body: MessageBody;
  attachments: MessageAttachment[];
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
  reactions: Record<string, number>;
  ownReaction: string | null;
  parentMessageId: string | null;
}

export interface Channel {
  communityId: string;
  channelId: string;
  areaId: string;
  title: string;
  url: string | null;
  order: number;
  description: string | null;
  emoji: string | null;
  updatedAt: string;
  lastRead?: string;
  lastMessageDate?: string | null;
  pinnedMessageIds?: string[];
  rolePermissions: { roleId: string; roleTitle?: string; permissions: string[] }[];
  [extra: string]: unknown;
}

export interface CommunityDetailView {
  id: string;
  url: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  myRoleIds: string[];
  channels: Channel[];
  areas: { id: string; communityId: string; title: string; order: number; [extra: string]: unknown }[];
  roles: { id: string; communityId: string; title: string; [extra: string]: unknown }[];
  calls: unknown[];
  [extra: string]: unknown;
}

export interface CommunityListView {
  id: string;
  url: string;
  title: string;
  memberCount: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  [extra: string]: unknown;
}

export interface Chat {
  id: string;
  channelId: string;
  userIds: string[];
  adminIds: string[];
  createdAt: string;
  updatedAt: string;
  unread?: boolean;
  lastRead?: string;
  lastMessage: ApiMessage | null;
  [extra: string]: unknown;
}

/** Convenience: build a plain-text body (split on newlines). */
export function textBody(text: string): MessageBody {
  const lines = text.split("\n");
  const content: MessageContentNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) content.push({ type: "newline" });
    if (line.length > 0) content.push({ type: "text", value: line });
  });
  return { version: "1", content };
}

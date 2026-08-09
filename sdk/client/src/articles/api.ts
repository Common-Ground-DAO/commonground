/**
 * Articles / posts — the blog surface, distinct from chat messages.
 *
 * Contract: srv/api/community.ts (community articles) + srv/api/user.ts
 * (personal/user articles), backed by a shared article model. Article content
 * is a structured block array (ContentV2), NOT markdown and NOT the message
 * Body. Comment threads reuse the Message subsystem via an article-scoped
 * MessageAccess (each article owns a channel) — see MessageApi + the
 * article access on this module.
 *
 * Write to community articles needs COMMUNITY_MANAGE_ARTICLES; user articles
 * are the caller's own. `published: null` = draft.
 */

import type { HttpTransport } from "../transport/http.js";
import type { ArticlePermission } from "../community/types.js";

export type ArticleContentV1 = { version: "1"; text: string };
export type ArticleContentV2 = { version: "2"; content: ArticleContentNode[] };
export type ArticleContent = ArticleContentV1 | ArticleContentV2;

export type ArticleContentNode =
  | { type: "text"; value: string; bold?: true; italic?: true; className?: string; divClassname?: string }
  | { type: "newline" }
  | { type: "link"; value: string; bold?: true; italic?: true }
  | { type: "richTextLink"; value: string; url: string; bold?: true; italic?: true; className?: string }
  | { type: "header"; value: { type: "text"; value: string }[] }
  | { type: "articleImage"; imageId: string; largeImageId: string; caption: string; size: "small" | "medium" | "large" }
  | { type: "articleEmbed"; embedId: string; size: "small" | "medium" | "large" };

export interface ArticlePreview {
  articleId: string;
  title: string;
  previewText: string | null;
  thumbnailImageId: string | null;
  headerImageId: string | null;
  creatorId: string;
  tags: string[];
  commentCount: number;
  latestCommentTimestamp: string | null;
}

export interface ArticleDetailView extends ArticlePreview {
  content: ArticleContent;
  channelId: string;
}

export interface CommunityArticle {
  communityId: string;
  articleId: string;
  url: string | null;
  published: string | null;
  updatedAt: string;
  rolePermissions: { roleId: string; roleTitle: string; permissions: ArticlePermission[] }[];
  sentAsNewsletter: string | null;
  markAsNewsletter: boolean;
}

export interface UserArticle {
  userId: string;
  articleId: string;
  url: string | null;
  published: string | null;
  updatedAt: string;
}

/**
 * The article-body fields shared by create/update (the server fills ids).
 * Note: the model's `previewText` is `string | null`, but the CREATE
 * validator requires a string ("" allowed) — the create methods coerce a
 * null preview to "" for you.
 */
export interface ArticleBody {
  title: string;
  previewText: string | null;
  thumbnailImageId: string | null;
  headerImageId: string | null;
  content: ArticleContent;
  tags: string[];
}

/** Coerce a create body to what the server validator accepts. */
function normalizeCreateBody(article: ArticleBody): ArticleBody {
  return { ...article, previewText: article.previewText ?? "" };
}

export interface ArticleListQuery {
  order?: "ASC" | "DESC";
  orderBy?: "updatedAt" | "published";
  updatedAfter?: string;
  updatedBefore?: string;
  publishedAfter?: string;
  publishedBefore?: string;
  /** Cursor tiebreakers for deterministic paging through same-timestamp rows.
   * Pair with the matching bound: beforeId with publishedBefore/updatedBefore
   * (DESC), afterId with publishedAfter/updatedAfter (ASC). Take both the
   * timestamp and articleId from the last item of the previous page. */
  beforeId?: string;
  afterId?: string;
  limit: number;
  tags?: string[];
  /** requires COMMUNITY_MANAGE_ARTICLES */
  drafts?: true;
  verification?: "verified" | "unverified" | "both" | "following";
  ids?: string[];
}

/** Convenience: a plain-text article body. */
export function textArticleContent(text: string): ArticleContentV2 {
  const content: ArticleContentNode[] = [];
  text.split("\n").forEach((line, i) => {
    if (i > 0) content.push({ type: "newline" });
    if (line) content.push({ type: "text", value: line });
  });
  return { version: "2", content };
}

export class ArticleApi {
  constructor(private readonly transport: HttpTransport) {}

  // ---- Community articles ----

  async listCommunityArticles(
    // undefined → the global community-article feed (across all communities).
    communityId: string | undefined,
    query: ArticleListQuery,
    extra: {
      /** article-level tags (articles.tags) */
      tags?: string[];
      anyTags?: string[];
      /** containing-community topics (communities.tags): all / any of */
      communityTags?: string[];
      anyCommunityTags?: string[];
    } = {},
  ): Promise<{ communityArticle: CommunityArticle; article: ArticlePreview }[]> {
    return this.transport.call("Community/getArticleList", { communityId, ...query, ...extra });
  }

  async getCommunityArticle(
    communityId: string,
    idOrUrl: { articleId: string } | { url: string },
  ): Promise<{ communityArticle: CommunityArticle; article: ArticleDetailView }> {
    return this.transport.call("Community/getArticleDetailView", { communityId, ...idOrUrl });
  }

  /** POST /Community/createArticle (COMMUNITY_MANAGE_ARTICLES). */
  async createCommunityArticle(
    communityArticle: {
      communityId: string;
      url: string | null;
      published: string | null;
      rolePermissions: { roleId: string; roleTitle: string; permissions: ArticlePermission[] }[];
    },
    article: ArticleBody,
  ): Promise<{ communityArticle: CommunityArticle; article: ArticleDetailView }> {
    return this.transport.call("Community/createArticle", {
      communityArticle,
      article: normalizeCreateBody(article),
    });
  }

  async updateCommunityArticle(
    communityArticle: { communityId: string; articleId: string } & Partial<{
      url: string | null;
      published: string | null;
      rolePermissions: { roleId: string; roleTitle: string; permissions: ArticlePermission[] }[];
    }>,
    article?: { articleId: string } & Partial<ArticleBody>,
  ): Promise<void> {
    await this.transport.call("Community/updateArticle", {
      communityArticle,
      ...(article ? { article } : {}),
    });
  }

  async deleteCommunityArticle(communityId: string, articleId: string): Promise<void> {
    await this.transport.call("Community/deleteArticle", { communityId, articleId });
  }

  /** POST /Community/sendArticleAsEmail — email a published article as a newsletter. */
  async sendCommunityArticleAsEmail(communityId: string, articleId: string): Promise<void> {
    await this.transport.call("Community/sendArticleAsEmail", { communityId, articleId });
  }

  // ---- User (personal) articles ----

  async listUserArticles(
    userId: string,
    query: ArticleListQuery,
    extra: { followingOnly?: true } = {},
  ): Promise<{ userArticle: UserArticle; article: ArticlePreview }[]> {
    return this.transport.call("User/getArticleList", { userId, ...query, ...extra });
  }

  async getUserArticle(
    userId: string,
    idOrUrl: { articleId: string } | { url: string },
  ): Promise<{ userArticle: UserArticle; article: ArticleDetailView }> {
    return this.transport.call("User/getArticleDetailView", { userId, ...idOrUrl });
  }

  async createUserArticle(
    userArticle: { url: string | null; published: string | null },
    article: ArticleBody,
  ): Promise<{ userArticle: UserArticle; article: ArticleDetailView }> {
    return this.transport.call("User/createArticle", {
      userArticle,
      article: normalizeCreateBody(article),
    });
  }

  async updateUserArticle(
    userArticle: { articleId: string } & Partial<{ url: string | null; published: string | null }>,
    article?: { articleId: string } & Partial<ArticleBody>,
  ): Promise<{ userArticle: Pick<UserArticle, "updatedAt"> }> {
    // A userArticle-only update (e.g. publishing a draft) is valid on its own
    // — the server no longer requires a matching `article` body (FINDINGS F-14).
    return this.transport.call("User/updateArticle", {
      userArticle,
      ...(article ? { article } : {}),
    });
  }

  async deleteUserArticle(articleId: string): Promise<void> {
    await this.transport.call("User/deleteArticle", { articleId });
  }

  // ---- Comment thread live rooms (comments themselves go through MessageApi
  //      with an article MessageAccess) ----

  /** Article-scoped MessageAccess for a community article's comment thread. */
  communityArticleAccess(channelId: string, articleId: string, articleCommunityId: string) {
    return { channelId, articleId, articleCommunityId };
  }

  /** Article-scoped MessageAccess for a user article's comment thread. */
  userArticleAccess(channelId: string, articleId: string, articleUserId: string) {
    return { channelId, articleId, articleUserId };
  }

  /** POST /Message/joinArticleEventRoom — subscribe to live comment events
   * (max 5 concurrent article rooms per device, FIFO eviction). */
  async joinArticleEventRoom(access: Record<string, string>): Promise<void> {
    await this.transport.call("Message/joinArticleEventRoom", { access });
  }

  async leaveArticleEventRoom(access: Record<string, string>): Promise<void> {
    await this.transport.call("Message/leaveArticleEventRoom", { access });
  }
}

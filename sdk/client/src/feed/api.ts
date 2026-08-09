/**
 * Unified user/community post feed.
 *
 * Contract: srv/api/feed.ts (Feed/getPostList). One deterministic, newest-first
 * timeline that unions user-authored posts and community-published posts, so a
 * client renders a single stream instead of merging two independently-paginated
 * article lists.
 *
 * Each item is backed by an existing article (postId === articleId); the body is
 * projected as media-stripped, node-boundary-truncated structured content plus an
 * ordered media array. Short posts render straight from `bodyPreview`; when
 * `isTruncated`, fetch the article detail endpoint (by kind + actor.id + postId)
 * on "Read more". Navigate by postId + kind + actor.id — `permalink` is reserved
 * for a future canonical web URL and is null in v1.
 */

import type { HttpTransport } from "../transport/http.js";
import type { ArticleContent } from "../articles/api.js";

export type PostKind = "user" | "community";
export type PostMediaSize = "small" | "medium" | "large";

export interface FeedActor {
  id: string;
  name: string;
  imageId: string | null;
  /** Community slug for community actors; null for users. */
  url: string | null;
}

export interface FeedCreator {
  userId: string;
  displayName: string;
  imageId: string | null;
}

/**
 * Ordered media below the post body. v1 emits only `image` (from legacy cover +
 * inline articleImage nodes). `video` is reserved for the generic-upload work
 * and is not emitted yet. width/height are null for legacy media, which carries
 * only a coarse `size` bucket.
 */
export type PostMedia =
  | {
      type: "image";
      objectId: string;
      largeObjectId: string | null;
      caption: string | null;
      size: PostMediaSize | null;
      width: number | null;
      height: number | null;
    }
  | {
      type: "video";
      objectId: string;
      posterImageId: string | null;
      width: number | null;
      height: number | null;
      durationMs: number | null;
    };

export interface FeedPostViewer {
  canEdit: boolean;
  canDelete: boolean;
  canComment: boolean;
}

export interface FeedPost {
  postId: string;
  kind: PostKind;
  actor: FeedActor;
  /** The authoring user for community posts; null for user posts. */
  creator: FeedCreator | null;
  publishedAt: string;
  /** Reserved — edit tracking is not yet modeled; always null in v1. */
  editedAt: string | null;
  bodyPreview: ArticleContent;
  isTruncated: boolean;
  media: PostMedia[];
  commentCount: number;
  permalink: string | null;
  viewer: FeedPostViewer;
}

export interface GetPostListQuery {
  /**
   * 'following' = followed users + joined communities (requires login;
   * anonymous callers get []). 'explore' = eligible public posts instance-wide,
   * including public posts from non-premium communities. Defaults to 'explore'.
   */
  scope?: "following" | "explore";
  /** Restrict to user and/or community posts. Defaults to both. */
  actorTypes?: PostKind[];
  /** Any-of match against article tags. */
  topics?: string[];
  /**
   * Filter COMMUNITY posts by premium state: verified = active premium,
   * unverified = none. Defaults to 'both'. User posts are unaffected (user-actor
   * verification is not currently modeled) and always appear — pair with
   * actorTypes:['community'] for a strictly-verified feed.
   */
  verification?: "verified" | "unverified" | "both";
  /**
   * Newest-first cursor. Pass the last item of the previous page as
   * { publishedAt, postId } (both together). Omit for the first page.
   */
  before?: { publishedAt: string; postId: string };
  limit: number;
}

export class FeedApi {
  constructor(private readonly transport: HttpTransport) {}

  async getPostList(query: GetPostListQuery): Promise<FeedPost[]> {
    return this.transport.call("Feed/getPostList", { ...query });
  }
}

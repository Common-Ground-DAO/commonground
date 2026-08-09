// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare namespace Models {
  namespace Feed {
    // A single item in the unified user/community post feed. Backed by an
    // existing article row (users_articles or communities_articles), projected
    // into a social-post shape. postId === the underlying articleId.
    type PostKind = 'user' | 'community';

    // Who the post is attributed to. For a user post the actor is the user; for
    // a community post the actor is the community (and `creator` names the
    // responsible user).
    type Actor = {
      id: string;
      name: string;
      imageId: string | null;
      // Community slug for community actors; null for users (clients navigate to
      // a user profile by `id`). Best-effort deep-link primitive.
      url: string | null;
    };

    type Creator = {
      userId: string;
      displayName: string;
      imageId: string | null;
    };

    // Ordered media rendered below the post body. v1 emits only `image`
    // (extracted from legacy cover + inline articleImage nodes). The `video`
    // variant is reserved for the generic-upload work (#58) and is NOT emitted
    // by the server yet. width/height are null for legacy media, which only
    // carries a coarse `size` bucket; real dimensions arrive with generic
    // uploads.
    type PostMedia =
      | {
          type: 'image';
          objectId: string;
          largeObjectId: string | null;
          caption: string | null;
          size: Common.Content.MediaSize | null;
          width: number | null;
          height: number | null;
        }
      | {
          type: 'video';
          objectId: string;
          posterImageId: string | null;
          width: number | null;
          height: number | null;
          durationMs: number | null;
        };

    type ViewerPermissions = {
      canEdit: boolean;
      canDelete: boolean;
      canComment: boolean;
    };

    type Post = {
      postId: string;
      kind: PostKind;
      actor: Actor;
      // Present for community posts (the authoring user); null for user posts,
      // where the actor already is the author.
      creator: Creator | null;
      publishedAt: string;
      // Reserved. Edit tracking is not yet modeled (the article timestamp can't
      // distinguish an edit from a backdated/scheduled publish), so this is
      // always null in v1.
      editedAt: string | null;
      // Media-stripped, node-boundary-truncated structured body. Short posts
      // render from this with no detail request; if `isTruncated`, "Read more"
      // fetches the existing article detail endpoint.
      bodyPreview: Models.BaseArticle.Content;
      isTruncated: boolean;
      media: PostMedia[];
      commentCount: number;
      // Best-effort deep-link; clients should prefer navigating by postId + kind
      // + actor.id, which are always present.
      permalink: string | null;
      viewer: ViewerPermissions;
    };
  }
}

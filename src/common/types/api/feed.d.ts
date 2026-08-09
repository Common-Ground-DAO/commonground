// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare global {
  namespace API {
    namespace Feed {
      namespace getPostList {
        type Request = {
          // Which timeline to draw from.
          //  - 'following': posts from followed users + joined communities
          //    (membership defines community following). Requires a logged-in
          //    user; anonymous callers get an empty list.
          //  - 'explore': eligible public posts across the instance, including
          //    public posts from non-premium communities.
          // Defaults to 'explore'.
          scope?: 'following' | 'explore';
          // Restrict to user-authored and/or community-published posts. Defaults
          // to both.
          actorTypes?: ('user' | 'community')[];
          // Any-of match against article tags.
          topics?: string[];
          // Filter community posts by the community's premium state: verified =
          // active premium, unverified = none. Defaults to 'both' (no filter).
          // NOTE: user posts are NOT affected by this — user-actor verification
          // is not currently modeled — so they always appear. Pair with
          // actorTypes:['community'] for a strictly-verified feed.
          verification?: 'verified' | 'unverified' | 'both';
          // Unified newest-first cursor. Page N+1 passes the last item of page N
          // as { publishedAt, postId }. Both must be provided together.
          before?: {
            publishedAt: string;
            postId: string;
          };
          limit: number; // 1..30, see validator
        };

        type Response = Models.Feed.Post[];
      }
    }
  }
}

export {};

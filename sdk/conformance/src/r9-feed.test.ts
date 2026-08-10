/**
 * R9 — unified user/community post feed.
 *
 * Contract: srv/api/feed.ts (Feed/getPostList). One deterministic, newest-first
 * timeline that UNIONs user-authored and community-published posts, so a client
 * pages a single stream with one cursor instead of merging two lists. Backed by
 * the existing article tables (postId === articleId); no schema migration.
 *
 * Each test isolates its fixtures with a unique `topic` tag so assertions hold
 * against the shared instance's global feed.
 */

import { describe, expect, it } from "vitest";
import { textArticleContent, type CommonGroundClient, type FeedPost, type GetPostListQuery } from "@commonground/client";
import { MUTATIONS_ENABLED, newClient, registerUser, uniqueName } from "./fixtures.js";

// Tag validator: max 30 chars, [a-z0-9-_ /]. Short + unique for isolation.
function uniqueTopic(): string {
  return `feed-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;
}

function pastIso(offsetMs = 60_000): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

// Strict newest-first order: publishedAt DESC, then postId DESC as the tiebreak
// (UUID string comparison matches Postgres uuid ordering for canonical ids).
function isDescOrdered(items: Pick<FeedPost, "publishedAt" | "postId">[]): boolean {
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1], b = items[i];
    const ta = new Date(a.publishedAt).getTime(), tb = new Date(b.publishedAt).getTime();
    if (ta < tb) return false;
    if (ta === tb && a.postId <= b.postId) return false;
  }
  return true;
}

// Page through the whole result set following the { publishedAt, postId } cursor.
async function collectAll(client: CommonGroundClient, query: GetPostListQuery): Promise<FeedPost[]> {
  const all: FeedPost[] = [];
  let before: { publishedAt: string; postId: string } | undefined = undefined;
  for (let guard = 0; guard < 25; guard++) {
    const page: FeedPost[] = await client.feed.getPostList({ ...query, before });
    all.push(...page);
    if (page.length < query.limit) break;
    const last = page[page.length - 1];
    before = { publishedAt: last.publishedAt, postId: last.postId };
  }
  return all;
}

describe.runIf(MUTATIONS_ENABLED)("Feed", () => {
  it("unions user + community posts into one deterministic, cursor-paged timeline", async () => {
    const { client } = await registerUser("feed-mix");
    const topic = uniqueTopic();
    const community = await client.communities.create({ title: uniqueName("feedc") });
    const memberRole = (community.roles as { id: string; title: string }[]).find((r) => r.title === "Member")!;

    const base = Date.now() - 3_600_000;
    const iso = (ms: number) => new Date(base + ms).toISOString();
    // Two posts (one community, one user) share this exact instant to exercise
    // the postId tiebreak across a page boundary.
    const shared = iso(3000);
    const createdIds: string[] = [];

    const communityTimes: (number | null)[] = [6000, 5000, null, 1000];
    for (let i = 0; i < communityTimes.length; i++) {
      const t = communityTimes[i];
      const c = await client.articles.createCommunityArticle(
        {
          communityId: community.id,
          url: null,
          published: t === null ? shared : iso(t),
          rolePermissions: [{ roleId: memberRole.id, roleTitle: "Member", permissions: ["ARTICLE_PREVIEW", "ARTICLE_READ"] }],
        },
        { title: `c${i}`, previewText: null, thumbnailImageId: null, headerImageId: null, content: textArticleContent(`community post ${i}`), tags: [topic] },
      );
      createdIds.push(c.article.articleId);
    }

    const userTimes: (number | null)[] = [7000, null, 2000];
    for (let i = 0; i < userTimes.length; i++) {
      const t = userTimes[i];
      const u = await client.articles.createUserArticle(
        { url: null, published: t === null ? shared : iso(t) },
        { title: `u${i}`, previewText: null, thumbnailImageId: null, headerImageId: null, content: textArticleContent(`user post ${i}`), tags: [topic] },
      );
      createdIds.push(u.article.articleId);
    }

    // Page in units of 3 across the 7 posts (multiple pages, incl. a boundary
    // inside the shared-timestamp pair depending on ids).
    const all = await collectAll(client, { topics: [topic], limit: 3 });
    const mineIds = new Set(createdIds);
    const mine = all.filter((p) => mineIds.has(p.postId));

    expect(mine.length).toBe(7); // completeness: no omissions
    expect(new Set(mine.map((p) => p.postId)).size).toBe(7); // no duplicates
    expect(mine.some((p) => p.kind === "user")).toBe(true);
    expect(mine.some((p) => p.kind === "community")).toBe(true);
    expect(isDescOrdered(all)).toBe(true); // stable cross-page ordering

    const sharedPosts = mine.filter((p) => new Date(p.publishedAt).getTime() === new Date(shared).getTime());
    expect(sharedPosts.length).toBe(2); // both same-timestamp posts survive paging
  });

  it("hides a role-gated community post from non-members; author sees it with manage perms", async () => {
    const author = await registerUser("feed-auth");
    const topic = uniqueTopic();
    const community = await author.client.communities.create({ title: uniqueName("feedg") });
    const memberRole = (community.roles as { id: string; title: string }[]).find((r) => r.title === "Member")!;

    // ARTICLE_PREVIEW granted to Member only — NOT the Public role.
    const art = await author.client.articles.createCommunityArticle(
      {
        communityId: community.id,
        url: null,
        published: pastIso(),
        rolePermissions: [{ roleId: memberRole.id, roleTitle: "Member", permissions: ["ARTICLE_PREVIEW", "ARTICLE_READ"] }],
      },
      { title: "gated", previewText: null, thumbnailImageId: null, headerImageId: null, content: textArticleContent("members only"), tags: [topic] },
    );

    const authorFeed = await author.client.feed.getPostList({ topics: [topic], limit: 10 });
    const seen = authorFeed.find((p) => p.postId === art.article.articleId);
    expect(seen).toBeTruthy();
    expect(seen!.kind).toBe("community");
    expect(seen!.actor.id).toBe(community.id); // community is the actor
    expect(seen!.creator?.userId).toBe(author.session.response.ownData.id); // authoring user
    expect(seen!.viewer.canEdit).toBe(true);
    expect(seen!.viewer.canDelete).toBe(true);

    // A logged-in non-member must not see it (no public ARTICLE_PREVIEW).
    const outsider = await registerUser("feed-out");
    const outsiderFeed = await outsider.client.feed.getPostList({ topics: [topic], limit: 10 });
    expect(outsiderFeed.some((p) => p.postId === art.article.articleId)).toBe(false);
  });

  it("excludes drafts from the feed for everyone including the author", async () => {
    const { client } = await registerUser("feed-draft");
    const topic = uniqueTopic();
    const community = await client.communities.create({ title: uniqueName("feedd") });
    const memberRole = (community.roles as { id: string; title: string }[]).find((r) => r.title === "Member")!;

    const communityDraft = await client.articles.createCommunityArticle(
      {
        communityId: community.id,
        url: null,
        published: null, // draft
        rolePermissions: [{ roleId: memberRole.id, roleTitle: "Member", permissions: ["ARTICLE_PREVIEW", "ARTICLE_READ"] }],
      },
      { title: "cdraft", previewText: null, thumbnailImageId: null, headerImageId: null, content: textArticleContent("wip"), tags: [topic] },
    );
    const userDraft = await client.articles.createUserArticle(
      { url: null, published: null },
      { title: "udraft", previewText: null, thumbnailImageId: null, headerImageId: null, content: textArticleContent("wip2"), tags: [topic] },
    );

    const feed = await client.feed.getPostList({ topics: [topic], limit: 10 });
    expect(feed.some((p) => p.postId === communityDraft.article.articleId)).toBe(false);
    expect(feed.some((p) => p.postId === userDraft.article.articleId)).toBe(false);
  });

  it("truncates long bodies at a node boundary and projects media out of the body", async () => {
    const { client } = await registerUser("feed-trunc");
    const topic = uniqueTopic();

    const shortPost = await client.articles.createUserArticle(
      { url: null, published: pastIso() },
      { title: "short", previewText: null, thumbnailImageId: null, headerImageId: null, content: textArticleContent("hello world"), tags: [topic] },
    );
    const longText = "word ".repeat(300).trim(); // ~1500 chars, well over the 600 budget
    const longPost = await client.articles.createUserArticle(
      { url: null, published: pastIso() },
      { title: "long", previewText: null, thumbnailImageId: null, headerImageId: null, content: textArticleContent(longText), tags: [topic] },
    );

    // ImageId is a format check (64 hex), not existence — safe to fabricate.
    const img = "a".repeat(64), imgLarge = "b".repeat(64), header = "c".repeat(64);
    const mediaPost = await client.articles.createUserArticle(
      { url: null, published: pastIso() },
      {
        title: "media",
        previewText: null,
        thumbnailImageId: null,
        headerImageId: header,
        content: {
          version: "2",
          content: [
            { type: "text", value: "caption below" },
            { type: "articleImage", imageId: img, largeImageId: imgLarge, caption: "pic", size: "medium" },
          ],
        },
        tags: [topic],
      },
    );

    const feed = await client.feed.getPostList({ topics: [topic], limit: 10 });
    const short = feed.find((p) => p.postId === shortPost.article.articleId)!;
    const long = feed.find((p) => p.postId === longPost.article.articleId)!;
    const media = feed.find((p) => p.postId === mediaPost.article.articleId)!;

    expect(short.isTruncated).toBe(false);
    expect(long.isTruncated).toBe(true);

    // Cover image + inline image both surface as ordered media; the body no
    // longer carries the articleImage node.
    expect(media.media.length).toBe(2);
    expect(media.media[0]).toMatchObject({ type: "image", objectId: header });
    expect(media.media.some((m) => m.type === "image" && m.objectId === img)).toBe(true);
    const bodyNodes = media.bodyPreview.version === "2" ? media.bodyPreview.content : [];
    expect(bodyNodes.some((n) => n.type === "articleImage")).toBe(false);
  });

  it("scope:following returns followed users' posts; explore stays global", async () => {
    const author = await registerUser("feed-follow-a");
    const follower = await registerUser("feed-follow-b");
    const stranger = await registerUser("feed-follow-c");
    const topic = uniqueTopic();

    const post = await author.client.articles.createUserArticle(
      { url: null, published: pastIso() },
      { title: "followed", previewText: null, thumbnailImageId: null, headerImageId: null, content: textArticleContent("hi followers"), tags: [topic] },
    );

    await follower.client.social.follow(author.session.response.ownData.id);

    const followingFeed = await follower.client.feed.getPostList({ scope: "following", topics: [topic], limit: 10 });
    expect(followingFeed.some((p) => p.postId === post.article.articleId)).toBe(true);

    // A user who does not follow the author sees nothing under 'following' ...
    const strangerFollowing = await stranger.client.feed.getPostList({ scope: "following", topics: [topic], limit: 10 });
    expect(strangerFollowing.some((p) => p.postId === post.article.articleId)).toBe(false);
    // ... but the same post is visible instance-wide under 'explore'.
    const strangerExplore = await stranger.client.feed.getPostList({ scope: "explore", topics: [topic], limit: 10 });
    expect(strangerExplore.some((p) => p.postId === post.article.articleId)).toBe(true);
  });

  it("verification filters community posts by premium; user posts are unaffected", async () => {
    const { client } = await registerUser("feed-verif");
    const topic = uniqueTopic();
    const community = await client.communities.create({ title: uniqueName("feedv") });
    const memberRole = (community.roles as { id: string; title: string }[]).find((r) => r.title === "Member")!;

    // A freshly created community has no premium => it is "unverified".
    const commPost = await client.articles.createCommunityArticle(
      {
        communityId: community.id,
        url: null,
        published: pastIso(),
        rolePermissions: [{ roleId: memberRole.id, roleTitle: "Member", permissions: ["ARTICLE_PREVIEW", "ARTICLE_READ"] }],
      },
      { title: "cpost", previewText: null, thumbnailImageId: null, headerImageId: null, content: textArticleContent("community body"), tags: [topic] },
    );
    const userPost = await client.articles.createUserArticle(
      { url: null, published: pastIso() },
      { title: "upost", previewText: null, thumbnailImageId: null, headerImageId: null, content: textArticleContent("user body"), tags: [topic] },
    );

    const unverified = await client.feed.getPostList({ topics: [topic], verification: "unverified", limit: 10 });
    const verified = await client.feed.getPostList({ topics: [topic], verification: "verified", limit: 10 });
    const both = await client.feed.getPostList({ topics: [topic], verification: "both", limit: 10 });

    // Non-premium community post: shows under unverified/both, hidden under verified.
    expect(unverified.some((p) => p.postId === commPost.article.articleId)).toBe(true);
    expect(verified.some((p) => p.postId === commPost.article.articleId)).toBe(false);
    expect(both.some((p) => p.postId === commPost.article.articleId)).toBe(true);

    // User post is not gated by verification — present under all three.
    expect(unverified.some((p) => p.postId === userPost.article.articleId)).toBe(true);
    expect(verified.some((p) => p.postId === userPost.article.articleId)).toBe(true);
    expect(both.some((p) => p.postId === userPost.article.articleId)).toBe(true);
  });

  it("gates community posts on ARTICLE_READ (not PREVIEW) and never leaks protected body/media (#77)", async () => {
    const author = await registerUser("feed-read");
    const topic = uniqueTopic();
    const community = await author.client.communities.create({ title: uniqueName("feedr") });
    const roles = community.roles as { id: string; title: string }[];
    const publicRole = roles.find((r) => r.title === "Public")!;

    // Public role granted PREVIEW only — NOT readable by a preview-only viewer.
    const previewOnly = await author.client.articles.createCommunityArticle(
      {
        communityId: community.id,
        url: null,
        published: pastIso(),
        rolePermissions: [{ roleId: publicRole.id, roleTitle: "Public", permissions: ["ARTICLE_PREVIEW"] }],
      },
      { title: "preview-only", previewText: null, thumbnailImageId: null, headerImageId: null, content: textArticleContent("protected body"), tags: [topic] },
    );
    // Public role granted PREVIEW + READ — a public readable post.
    const readable = await author.client.articles.createCommunityArticle(
      {
        communityId: community.id,
        url: null,
        published: pastIso(),
        rolePermissions: [{ roleId: publicRole.id, roleTitle: "Public", permissions: ["ARTICLE_PREVIEW", "ARTICLE_READ"] }],
      },
      { title: "readable", previewText: null, thumbnailImageId: null, headerImageId: null, content: textArticleContent("public body"), tags: [topic] },
    );

    // Anonymous viewer: preview-only hidden, readable visible, canComment false.
    const anon = newClient();
    const anonFeed = await anon.feed.getPostList({ topics: [topic], limit: 10 });
    expect(anonFeed.some((p) => p.postId === previewOnly.article.articleId)).toBe(false);
    const anonReadable = anonFeed.find((p) => p.postId === readable.article.articleId);
    expect(anonReadable).toBeTruthy();
    expect(anonReadable!.viewer.canComment).toBe(false);

    // Authenticated non-member: still can't see preview-only; can comment on readable.
    const viewer = await registerUser("feed-read-v");
    const viewerFeed = await viewer.client.feed.getPostList({ topics: [topic], limit: 10 });
    expect(viewerFeed.some((p) => p.postId === previewOnly.article.articleId)).toBe(false);
    const viewerReadable = viewerFeed.find((p) => p.postId === readable.article.articleId);
    expect(viewerReadable).toBeTruthy();
    expect(viewerReadable!.viewer.canComment).toBe(true);
  });

  it("following scope includes the viewer's own user posts (#78)", async () => {
    const viewer = await registerUser("feed-own");
    const followed = await registerUser("feed-own-f");
    const stranger = await registerUser("feed-own-s");
    const topic = uniqueTopic();

    const ownPost = await viewer.client.articles.createUserArticle(
      { url: null, published: pastIso() },
      { title: "mine", previewText: null, thumbnailImageId: null, headerImageId: null, content: textArticleContent("my own post"), tags: [topic] },
    );
    const followedPost = await followed.client.articles.createUserArticle(
      { url: null, published: pastIso() },
      { title: "followed", previewText: null, thumbnailImageId: null, headerImageId: null, content: textArticleContent("followed post"), tags: [topic] },
    );
    const strangerPost = await stranger.client.articles.createUserArticle(
      { url: null, published: pastIso() },
      { title: "stranger", previewText: null, thumbnailImageId: null, headerImageId: null, content: textArticleContent("stranger post"), tags: [topic] },
    );

    await viewer.client.social.follow(followed.session.response.ownData.id);

    const feed = await viewer.client.feed.getPostList({ scope: "following", topics: [topic], limit: 10 });
    expect(feed.some((p) => p.postId === ownPost.article.articleId)).toBe(true); // own post present
    expect(feed.some((p) => p.postId === followedPost.article.articleId)).toBe(true); // followed present
    expect(feed.some((p) => p.postId === strangerPost.article.articleId)).toBe(false); // unfollowed absent

    // A draft of the viewer's own must still be excluded from following.
    const ownDraft = await viewer.client.articles.createUserArticle(
      { url: null, published: null },
      { title: "mydraft", previewText: null, thumbnailImageId: null, headerImageId: null, content: textArticleContent("wip"), tags: [topic] },
    );
    const feed2 = await viewer.client.feed.getPostList({ scope: "following", topics: [topic], limit: 10 });
    expect(feed2.some((p) => p.postId === ownDraft.article.articleId)).toBe(false);
  });

  it("truncates an oversized header and a body behind leading newlines, bounded and flagged (#76)", async () => {
    const { client } = await registerUser("feed-trunc2");
    const topic = uniqueTopic();

    // A single header whose text exceeds the ~600 budget: bounded + isTruncated.
    const bigHeader = "H".repeat(900);
    const headerPost = await client.articles.createUserArticle(
      { url: null, published: pastIso() },
      {
        title: "hdr",
        previewText: null,
        thumbnailImageId: null,
        headerImageId: null,
        content: { version: "2", content: [{ type: "header", value: [{ type: "text", value: bigHeader }] }] },
        tags: [topic],
      },
    );

    // Leading newlines then an oversized text node: the text must NOT vanish.
    const bigText = "word ".repeat(300).trim();
    const newlinePost = await client.articles.createUserArticle(
      { url: null, published: pastIso() },
      {
        title: "nl",
        previewText: null,
        thumbnailImageId: null,
        headerImageId: null,
        content: { version: "2", content: [{ type: "newline" }, { type: "newline" }, { type: "text", value: bigText }] },
        tags: [topic],
      },
    );

    const feed = await client.feed.getPostList({ topics: [topic], limit: 10 });

    const hdr = feed.find((p) => p.postId === headerPost.article.articleId)!;
    expect(hdr.isTruncated).toBe(true);
    const hdrNodes = hdr.bodyPreview.version === "2" ? hdr.bodyPreview.content : [];
    const header = hdrNodes.find((n) => n.type === "header") as { type: "header"; value: { value: string }[] } | undefined;
    expect(header).toBeTruthy();
    const headerLen = header!.value.reduce((s, t) => s + (t.value?.length ?? 0), 0);
    expect(headerLen).toBeGreaterThan(0);
    expect(headerLen).toBeLessThanOrEqual(600);

    const nl = feed.find((p) => p.postId === newlinePost.article.articleId)!;
    expect(nl.isTruncated).toBe(true);
    const nlNodes = nl.bodyPreview.version === "2" ? nl.bodyPreview.content : [];
    const textLen = nlNodes
      .filter((n) => n.type === "text")
      .reduce((s, n) => s + ((n as { value?: string }).value?.length ?? 0), 0);
    expect(textLen).toBeGreaterThan(0); // body did not vanish behind the newlines
    expect(textLen).toBeLessThanOrEqual(600); // and stayed bounded
  });

  it("structurally bounds bodyPreview independent of the text budget (#80)", async () => {
    const { client } = await registerUser("feed-bound");
    const topic = uniqueTopic();

    // Thousands of zero-cost newline nodes: text budget never trips, but the
    // structural bound must keep the preview tiny and flag it.
    const newlineBomb = await client.articles.createUserArticle(
      { url: null, published: pastIso() },
      {
        title: "nlbomb",
        previewText: null,
        thumbnailImageId: null,
        headerImageId: null,
        content: { version: "2", content: Array.from({ length: 3000 }, () => ({ type: "newline" })) },
        tags: [topic],
      },
    );

    // A header with many (under-budget) children: exercises the header-child cap.
    const fatHeader = await client.articles.createUserArticle(
      { url: null, published: pastIso() },
      {
        title: "fathdr",
        previewText: null,
        thumbnailImageId: null,
        headerImageId: null,
        content: { version: "2", content: [{ type: "header", value: Array.from({ length: 20 }, () => ({ type: "text", value: "x" })) }] },
        tags: [topic],
      },
    );

    // A normal multi-paragraph post must stay intact and untruncated.
    const normal = await client.articles.createUserArticle(
      { url: null, published: pastIso() },
      {
        title: "normal",
        previewText: null,
        thumbnailImageId: null,
        headerImageId: null,
        content: { version: "2", content: [{ type: "text", value: "Paragraph one." }, { type: "newline" }, { type: "newline" }, { type: "text", value: "Paragraph two." }] },
        tags: [topic],
      },
    );

    const feed = await client.feed.getPostList({ topics: [topic], limit: 10 });

    const nl = feed.find((p) => p.postId === newlineBomb.article.articleId)!;
    const nlNodes = nl.bodyPreview.version === "2" ? nl.bodyPreview.content : [];
    expect(nlNodes.length).toBeLessThanOrEqual(4); // bounded, not 3000
    expect(nl.isTruncated).toBe(true);

    const hdr = feed.find((p) => p.postId === fatHeader.article.articleId)!;
    const hdrNodes = hdr.bodyPreview.version === "2" ? hdr.bodyPreview.content : [];
    const header = hdrNodes.find((n) => n.type === "header") as { value: unknown[] } | undefined;
    expect(header).toBeTruthy();
    expect(header!.value.length).toBeLessThanOrEqual(12); // header children bounded
    expect(hdr.isTruncated).toBe(true);

    const norm = feed.find((p) => p.postId === normal.article.articleId)!;
    const normNodes = norm.bodyPreview.version === "2" ? norm.bodyPreview.content : [];
    expect(norm.isTruncated).toBe(false); // normal formatting intact
    expect(normNodes.filter((n) => n.type === "text").length).toBe(2); // both paragraphs kept
  });

  it("anonymous following scope returns an empty list", async () => {
    const anon = await registerUser("feed-anon").then((r) => r.client);
    await anon.auth.logout();
    const feed = await anon.feed.getPostList({ scope: "following", limit: 10 });
    expect(feed).toEqual([]);
  });
});

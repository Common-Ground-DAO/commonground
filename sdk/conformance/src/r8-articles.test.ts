/**
 * R8 — articles / posts.
 *
 * Contract: srv/api/community.ts + srv/api/user.ts article routes, backed by
 * a shared article model with structured ContentV2 (not markdown). Comment
 * threads reuse the Message subsystem via an article-scoped MessageAccess.
 * Community article write needs COMMUNITY_MANAGE_ARTICLES; user articles are
 * the caller's own; published:null = draft.
 */

import { describe, expect, it } from "vitest";
import { textArticleContent, textBody } from "@commonground/client";
import { MUTATIONS_ENABLED, registerUser, uniqueName } from "./fixtures.js";

describe.runIf(MUTATIONS_ENABLED)("Articles", () => {
  it("creates a published community article, reads it back, lists it", async () => {
    const { client, session } = await registerUser("art-comm");
    const community = await client.communities.create({ title: uniqueName("art") });
    const memberRole = (community.roles as { id: string; title: string }[]).find((r) => r.title === "Member")!;

    // Articles are ALWAYS created as drafts — the create handler ignores the
    // `published` field you pass (FINDINGS F-13). Publishing is a follow-up
    // updateArticle. So: create (draft) → publish → verify.
    const created = await client.articles.createCommunityArticle(
      {
        communityId: community.id,
        url: uniqueName("a").toLowerCase(),
        published: null,
        rolePermissions: [
          { roleId: memberRole.id, roleTitle: "Member", permissions: ["ARTICLE_PREVIEW", "ARTICLE_READ"] },
        ],
      },
      {
        title: "Conformance Article",
        previewText: "a post from the reference client",
        thumbnailImageId: null,
        headerImageId: null,
        content: textArticleContent("First paragraph.\nSecond paragraph."),
        tags: ["conformance"],
      },
    );
    expect(created.article.articleId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.article.channelId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.article.creatorId).toBe(session.response.ownData.id);

    const published = new Date().toISOString();
    await client.articles.updateCommunityArticle({
      communityId: community.id,
      articleId: created.article.articleId,
      published,
    });

    const fetched = await client.articles.getCommunityArticle(community.id, {
      articleId: created.article.articleId,
    });
    expect(fetched.article.title).toBe("Conformance Article");
    expect(fetched.article.content).toEqual(textArticleContent("First paragraph.\nSecond paragraph."));
    // The server round-trips the timestamp in Postgres timestamptz format
    // (e.g. "...+00:00"), so compare by instant, not string.
    expect(new Date(fetched.communityArticle.published!).getTime()).toBe(new Date(published).getTime());

    const list = await client.articles.listCommunityArticles(community.id, { limit: 10 });
    expect(list.some((a) => a.article.articleId === created.article.articleId)).toBe(true);
  });

  it("drafts are hidden from a normal list and require manage perms to see", async () => {
    const { client } = await registerUser("art-draft");
    const community = await client.communities.create({ title: uniqueName("draft") });
    const memberRole = (community.roles as { id: string; title: string }[]).find((r) => r.title === "Member")!;

    const draft = await client.articles.createCommunityArticle(
      {
        communityId: community.id,
        url: null,
        published: null, // draft
        rolePermissions: [
          { roleId: memberRole.id, roleTitle: "Member", permissions: ["ARTICLE_PREVIEW", "ARTICLE_READ"] },
        ],
      },
      {
        title: "Draft",
        previewText: null,
        thumbnailImageId: null,
        headerImageId: null,
        content: textArticleContent("unpublished"),
        tags: [],
      },
    );

    // Normal (published-only) list excludes it.
    const published = await client.articles.listCommunityArticles(community.id, { limit: 10 });
    expect(published.some((a) => a.article.articleId === draft.article.articleId)).toBe(false);

    // As the manager (creator == admin), drafts:true surfaces it.
    const drafts = await client.articles.listCommunityArticles(community.id, { limit: 10, drafts: true });
    expect(drafts.some((a) => a.article.articleId === draft.article.articleId)).toBe(true);
  });

  it("updates and deletes a community article", async () => {
    const { client } = await registerUser("art-upd");
    const community = await client.communities.create({ title: uniqueName("upd") });
    const memberRole = (community.roles as { id: string; title: string }[]).find((r) => r.title === "Member")!;
    const created = await client.articles.createCommunityArticle(
      {
        communityId: community.id,
        url: null,
        published: new Date().toISOString(),
        rolePermissions: [{ roleId: memberRole.id, roleTitle: "Member", permissions: ["ARTICLE_READ"] }],
      },
      {
        title: "Before",
        previewText: null,
        thumbnailImageId: null,
        headerImageId: null,
        content: textArticleContent("v1"),
        tags: [],
      },
    );

    await client.articles.updateCommunityArticle(
      { communityId: community.id, articleId: created.article.articleId },
      { articleId: created.article.articleId, title: "After", content: textArticleContent("v2") },
    );
    const fetched = await client.articles.getCommunityArticle(community.id, {
      articleId: created.article.articleId,
    });
    expect(fetched.article.title).toBe("After");

    await client.articles.deleteCommunityArticle(community.id, created.article.articleId);
    await expect(
      client.articles.getCommunityArticle(community.id, { articleId: created.article.articleId }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND|NOT_ALLOWED/) });
  });

  it("comment on a community article via the article MessageAccess", async () => {
    const { client, session } = await registerUser("art-comment");
    const community = await client.communities.create({ title: uniqueName("cmt") });
    const memberRole = (community.roles as { id: string; title: string }[]).find((r) => r.title === "Member")!;
    const created = await client.articles.createCommunityArticle(
      {
        communityId: community.id,
        url: null,
        published: new Date().toISOString(),
        rolePermissions: [
          { roleId: memberRole.id, roleTitle: "Member", permissions: ["ARTICLE_PREVIEW", "ARTICLE_READ"] },
        ],
      },
      {
        title: "Commentable",
        previewText: null,
        thumbnailImageId: null,
        headerImageId: null,
        content: textArticleContent("discuss below"),
        tags: [],
      },
    );

    const access = client.articles.communityArticleAccess(
      created.article.channelId,
      created.article.articleId,
      community.id,
    );
    // Subscribe to the article comment room, then post a comment.
    await client.articles.joinArticleEventRoom(access);
    const comment = await client.messages.send({ access, body: textBody("great post") });
    expect(comment.creatorId).toBe(session.response.ownData.id);

    const loaded = await client.messages.load(access, { createdBefore: new Date().toISOString() });
    expect(loaded.map((m) => m.id)).toContain(comment.id);

    await client.articles.leaveArticleEventRoom(access);
  });

  it("creates a personal (user) article and lists it", async () => {
    const { client, session } = await registerUser("art-user");
    const created = await client.articles.createUserArticle(
      { url: uniqueName("u").toLowerCase(), published: null },
      {
        title: "My Post",
        previewText: "personal",
        thumbnailImageId: null,
        headerImageId: null,
        content: textArticleContent("hello from my blog"),
        tags: ["personal"],
      },
    );
    expect(created.article.articleId).toMatch(/^[0-9a-f-]{36}$/);

    // Publish it (create makes a draft — F-13), then it appears in the list.
    await client.articles.updateUserArticle({
      articleId: created.article.articleId,
      published: new Date().toISOString(),
    });
    const list = await client.articles.listUserArticles(session.response.ownData.id, { limit: 10 });
    expect(list.some((a) => a.article.articleId === created.article.articleId)).toBe(true);

    const fetched = await client.articles.getUserArticle(session.response.ownData.id, {
      articleId: created.article.articleId,
    });
    expect(fetched.article.title).toBe("My Post");

    await client.articles.deleteUserArticle(created.article.articleId);
  });

  it("a non-manager member cannot create a community article", async () => {
    const { client: owner } = await registerUser("art-perm");
    const community = await owner.communities.create({ title: uniqueName("perm") });
    const { client: member } = await registerUser("art-perm-m");
    await member.communities.join(community.id);
    await expect(
      member.articles.createCommunityArticle(
        { communityId: community.id, url: null, published: new Date().toISOString(), rolePermissions: [] },
        {
          title: "nope",
          previewText: null,
          thumbnailImageId: null,
          headerImageId: null,
          content: textArticleContent("x"),
          tags: [],
        },
      ),
    ).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  });
});

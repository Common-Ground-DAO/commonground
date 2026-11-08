/**
 * R11 — viewer-aware suggested users ("people to discover").
 *
 * Contract: srv/api/user.ts (User/getSuggestedUsers, authenticated). A
 * deterministic ranking — shared-community members > follow-of-follows >
 * globally-popular fallback — returning lightweight ids + a reason; clients
 * hydrate via User/getUserData. Keyset-paginated so pages can't dup/omit.
 */

import { describe, expect, it } from "vitest";
import { MUTATIONS_ENABLED, newClient, registerUser, uniqueName } from "./fixtures.js";

describe.runIf(MUTATIONS_ENABLED)("Suggested users", () => {
  it("requires authentication", async () => {
    const anon = newClient();
    await expect(anon.profile.getSuggestedUsers({ limit: 5 })).rejects.toMatchObject({ code: "LOGIN_REQUIRED" });
  });

  it("suggests a user who shares a community, with a sharedCommunity reason", async () => {
    const viewer = await registerUser("sug-share-v");
    const other = await registerUser("sug-share-o");
    const community = await viewer.client.communities.create({ title: uniqueName("sug") });

    // `other` joins the viewer's community → they now share it.
    await other.client.communities.join(community.id);

    const page = await viewer.client.profile.getSuggestedUsers({ limit: 20 });
    const hit = page.users.find((u) => u.userId === other.session.response.ownData.id);
    expect(hit).toBeTruthy();
    expect(hit!.reason.type).toBe("sharedCommunity");
    expect(hit!.reason.communityId).toBe(community.id); // a community the viewer belongs to
    expect(hit!.reason.mutualCount).toBeGreaterThanOrEqual(1);

    // The viewer is never suggested to themselves.
    expect(page.users.some((u) => u.userId === viewer.session.response.ownData.id)).toBe(false);
  });

  it("suggests follow-of-follows and does not re-suggest already-followed users", async () => {
    const viewer = await registerUser("sug-fof-v");
    const bridge = await registerUser("sug-fof-b"); // viewer follows bridge
    const target = await registerUser("sug-fof-t"); // bridge follows target → 2nd degree

    await viewer.client.social.follow(bridge.session.response.ownData.id);
    await bridge.client.social.follow(target.session.response.ownData.id);

    const page = await viewer.client.profile.getSuggestedUsers({ limit: 30 });

    const targetHit = page.users.find((u) => u.userId === target.session.response.ownData.id);
    expect(targetHit).toBeTruthy();
    expect(targetHit!.reason.type).toBe("followedByFollowing");
    expect(targetHit!.reason.mutualCount).toBeGreaterThanOrEqual(1);

    // `bridge` is already followed by the viewer → excluded from suggestions.
    expect(page.users.some((u) => u.userId === bridge.session.response.ownData.id)).toBe(false);
  });

  it("excludes bots and self, and every reason is a known kind", async () => {
    const viewer = await registerUser("sug-excl-v");

    // A user-owned bot is a user row with is_bot=TRUE — must never be suggested.
    const bot = await viewer.client.bots.create({
      ownerType: "user",
      ownerId: viewer.session.response.ownData.id,
      username: uniqueName("sugxbot"),
      description: "conformance bot",
    });

    const page = await viewer.client.profile.getSuggestedUsers({ limit: 50 });
    expect(page.users.some((u) => u.userId === viewer.session.response.ownData.id)).toBe(false);
    expect(page.users.some((u) => u.userId === bot.userId)).toBe(false);
    for (const u of page.users) {
      expect(["sharedCommunity", "followedByFollowing", "popular"]).toContain(u.reason.type);
    }
  });

  it("stays deterministic across repeated paging over a shared community (#84 bounding)", async () => {
    // A community with several co-members exercises the bounded shared arm. The
    // per-community sample + keyset must yield the SAME ordered sequence on a
    // repeat, and never duplicate within a full paginated walk.
    const viewer = await registerUser("sug-bound-v");
    const community = await viewer.client.communities.create({ title: uniqueName("sugb") });
    for (let i = 0; i < 5; i++) {
      const m = await registerUser(`sug-bound-m${i}`);
      await m.client.communities.join(community.id);
    }

    const walk = async () => {
      const seen: string[] = [];
      let cursor: string | undefined = undefined;
      for (let guard = 0; guard < 20; guard++) {
        const page = await viewer.client.profile.getSuggestedUsers({ limit: 3, cursor });
        seen.push(...page.users.map((u) => u.userId));
        if (!page.nextCursor || page.users.length === 0) break;
        cursor = page.nextCursor;
      }
      return seen;
    };

    const first = await walk();
    const second = await walk();
    expect(new Set(first).size).toBe(first.length); // no dup within a walk
    expect(second).toEqual(first); // stable ordering across repeated paging
  });

  it("paginates deterministically with no duplicates or omissions across pages", async () => {
    // A viewer sharing a community with several others: enough candidates to page.
    const viewer = await registerUser("sug-page-v");
    const community = await viewer.client.communities.create({ title: uniqueName("sugp") });
    const members: string[] = [];
    for (let i = 0; i < 6; i++) {
      const m = await registerUser(`sug-page-m${i}`);
      await m.client.communities.join(community.id);
      members.push(m.session.response.ownData.id);
    }

    // Page in units of 2, following nextCursor to exhaustion.
    const seen: string[] = [];
    let cursor: string | undefined = undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = await viewer.client.profile.getSuggestedUsers({ limit: 2, cursor });
      seen.push(...page.users.map((u) => u.userId));
      if (!page.nextCursor || page.users.length === 0) break;
      cursor = page.nextCursor;
    }

    // No duplicates across page boundaries.
    expect(new Set(seen).size).toBe(seen.length);
    // Every member we created was surfaced exactly once (completeness).
    for (const id of members) {
      expect(seen.filter((s) => s === id).length).toBe(1);
    }
    // Self never appears.
    expect(seen).not.toContain(viewer.session.response.ownData.id);
  });
});

/**
 * R9 — plugins.
 *
 * Contract: srv/api/plugins.ts. Management (create/update/delete/clone) needs
 * the community's Admin role. createPlugin returns an RSA keypair ONCE; the
 * private key signs pluginRequest calls (RSA-SHA256 over the request string),
 * verified server-side against the stored public key. Appstore reads are
 * public.
 */

import { describe, expect, it } from "vitest";
import { MUTATIONS_ENABLED, registerUser, uniqueName } from "./fixtures.js";

describe.runIf(MUTATIONS_ENABLED)("Plugins", () => {
  async function ownerWithPlugin(tag: string) {
    const { client, session } = await registerUser(tag);
    const community = await client.communities.create({ title: uniqueName(tag) });
    const plugin = await client.plugins.create({
      name: uniqueName("plug"),
      url: "https://plugin.invalid/app",
      description: "conformance plugin",
      imageId: null,
      communityId: community.id,
      config: {},
      permissions: { mandatory: [], optional: ["READ_EMAIL", "READ_FRIENDS"] },
      clonable: true,
      requiresIsolationMode: false,
      tags: ["conformance"],
    });
    return { client, session, community, plugin };
  }

  it("creates a plugin and returns an RSA keypair once", async () => {
    const { plugin } = await ownerWithPlugin("plug-create");
    expect(plugin.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(plugin.publicKey).toContain("BEGIN PUBLIC KEY");
    expect(plugin.privateKey).toContain("PRIVATE KEY");
  });

  it("signed pluginRequest round-trips (communityInfo) and verifies the response signature", async () => {
    const { client, community, plugin } = await ownerWithPlugin("plug-req");
    // A community-scoped request needs no per-user permission acceptance.
    const result = (await client.plugins.pluginRequest(
      plugin.id,
      plugin.privateKey,
      plugin.publicKey,
      { type: "communityInfo" },
      "request",
      1,
      Date.now(),
    )) as { data: { id: string; title: string } };
    expect(result.data.id).toBe(community.id);
    expect(typeof result.data.title).toBe("string");
  });

  it("userInfo pluginRequest gates optional data behind accepted permissions", async () => {
    const { client, plugin, session } = await ownerWithPlugin("plug-user");
    // Before accepting READ_EMAIL, email must be absent from userInfo.
    // A first userInfo before any acceptPluginPermissions used to NPE server-
    // side (no user_plugin_state row → undefined.acceptedPermissions); fixed
    // on this branch (FINDINGS F-15).
    const before = (await client.plugins.pluginRequest(
      plugin.id, plugin.privateKey, plugin.publicKey,
      { type: "userInfo" }, "request", 1, Date.now(),
    )) as { data: { id: string; email?: string } };
    expect(before.data.id).toBe(session.response.ownData.id);
    expect(before.data.email).toBeUndefined();

    // Accept READ_EMAIL; the SDK-side email is unverified so it still may be
    // withheld — assert the accept call itself succeeds and the request still
    // round-trips (the permission plumbing is what's under test).
    await client.plugins.acceptPermissions(plugin.id, ["READ_EMAIL"]);
    const after = (await client.plugins.pluginRequest(
      plugin.id, plugin.privateKey, plugin.publicKey,
      { type: "userInfo" }, "request", 2, Date.now(),
    )) as { data: { id: string } };
    expect(after.data.id).toBe(session.response.ownData.id);
  });

  it("a replayed requestId is rejected (DUPLICATED_SIGNED_REQUEST)", async () => {
    const { client, plugin } = await ownerWithPlugin("plug-replay");
    const stamp = Date.now();
    await client.plugins.pluginRequest(
      plugin.id, plugin.privateKey, plugin.publicKey,
      { type: "communityInfo" }, "request", 42, stamp,
    );
    // Same counter+stamp → same requestId → replay lock.
    await expect(
      client.plugins.pluginRequest(
        plugin.id, plugin.privateKey, plugin.publicKey,
        { type: "communityInfo" }, "request", 42, stamp,
      ),
    ).rejects.toMatchObject({ code: "DUPLICATED_SIGNED_REQUEST" });
  });

  it("an expired requestId (>10min old) is rejected", async () => {
    const { client, plugin } = await ownerWithPlugin("plug-expire");
    const old = Date.now() - 11 * 60 * 1000;
    await expect(
      client.plugins.pluginRequest(
        plugin.id, plugin.privateKey, plugin.publicKey,
        { type: "communityInfo" }, "request", 1, old,
      ),
    ).rejects.toMatchObject({ code: "SIGNED_REQUEST_EXPIRED" });
  });

  it("a clonable plugin appears in the public appstore and is fetchable by pluginId", async () => {
    // The community that owns the plugin is discoverable in the appstore by a
    // logged-out-equivalent reader (appstore reads are public). createPlugin
    // returns the INSTALL id; the appstore keys on the shared pluginId, which
    // we resolve from the public list.
    const pluginName = uniqueName("store");
    const { client: owner, session } = await registerUser("plug-store");
    const community = await owner.communities.create({ title: uniqueName("store") });
    await owner.plugins.create({
      name: pluginName,
      url: "https://plugin.invalid/store",
      description: "in the store",
      imageId: null,
      communityId: community.id,
      config: {},
      permissions: { mandatory: [], optional: [] },
      clonable: true,
      requiresIsolationMode: false,
      tags: ["conformance-store"],
    });
    void session;

    const reader = (await import("./fixtures.js")).newClient();
    const list = await reader.plugins.getAppstorePlugins({ query: pluginName, limit: 50, offset: 0 });
    const found = list.plugins.find((p) => p.name === pluginName);
    expect(found).toBeDefined();
    expect(found!.ownerCommunityId).toBe(community.id);

    // Fetch it directly by its shared pluginId.
    const fetched = await reader.plugins.getAppstorePlugin(found!.pluginId);
    expect(fetched.name).toBe(pluginName);

    const communities = await reader.plugins.getPluginCommunities(found!.pluginId, 10, 0);
    expect(communities.communityIds).toContain(community.id);
  });

  it("a non-admin member cannot create a plugin", async () => {
    const { client: owner } = await registerUser("plug-perm");
    const community = await owner.communities.create({ title: uniqueName("perm") });
    const { client: member } = await registerUser("plug-perm-m");
    await member.communities.join(community.id);
    await expect(
      member.plugins.create({
        name: uniqueName("x"),
        url: "https://plugin.invalid/y",
        description: null,
        imageId: null,
        communityId: community.id,
        config: {},
        permissions: { mandatory: [], optional: [] },
        clonable: false,
        requiresIsolationMode: false,
        tags: null,
      }),
    ).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  });

  it("deletes a plugin install", async () => {
    const { client, plugin } = await ownerWithPlugin("plug-del");
    const result = await client.plugins.delete(plugin.id);
    expect(result.ok).toBe(true);
  });
});

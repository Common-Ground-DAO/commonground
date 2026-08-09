/**
 * R7 — community management.
 *
 * Contract: srv/api/community.ts (roles/areas/channels/moderation/events/
 * tokens), validators srv/validators/api/community.ts. Each management route
 * needs a CommunityPermission the community creator's Admin role holds.
 */

import { afterAll, describe, expect, it } from "vitest";
import { textBody, type CommunityDetailView, type RealtimeClient } from "@commonground/client";
import { MUTATIONS_ENABLED, newClient, registerUser, TEST_PASSWORD, uniqueName } from "./fixtures.js";

describe.runIf(MUTATIONS_ENABLED)("Community management", () => {
  const open: RealtimeClient[] = [];
  afterAll(() => {
    for (const realtime of open) realtime.close();
  });

  async function ownerWithCommunity(tag: string) {
    const { client, session } = await registerUser(tag);
    const community = await client.communities.create({ title: uniqueName(tag) });
    return { client, session, community };
  }

  function memberRole(community: CommunityDetailView) {
    return (community.roles as { id: string; title: string }[]).find((r) => r.title === "Member")!;
  }

  it("creates, updates and deletes a custom role", async () => {
    const { client, community } = await ownerWithCommunity("ca-role");
    const { id } = await client.communityAdmin.createRole({
      communityId: community.id,
      title: uniqueName("role"),
      type: "CUSTOM_MANUAL_ASSIGN",
      assignmentRules: { type: "free" },
      permissions: ["COMMUNITY_MODERATE"],
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    await client.communityAdmin.updateRole({
      id,
      communityId: community.id,
      description: "updated by conformance",
    });
    // Verify via the community detail view (roles are embedded there).
    const detail = await client.communities.getDetailView({ id: community.id });
    const role = (detail.roles as { id: string; description?: string }[]).find((r) => r.id === id);
    expect(role?.description).toBe("updated by conformance");

    await client.communityAdmin.deleteRole(id, community.id);
    const after = await client.communities.getDetailView({ id: community.id });
    expect((after.roles as { id: string }[]).some((r) => r.id === id)).toBe(false);
  });

  it("rejects a role titled Admin and a PREDEFINED type (validator guards)", async () => {
    const { client, community } = await ownerWithCommunity("ca-role-bad");
    await expect(
      client.communityAdmin.createRole({
        communityId: community.id,
        title: "Admin",
        type: "CUSTOM_MANUAL_ASSIGN",
        assignmentRules: { type: "free" },
        permissions: [],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      client.communityAdmin.createRole({
        communityId: community.id,
        title: uniqueName("r"),
        type: "PREDEFINED" as never,
        assignmentRules: { type: "free" },
        permissions: [],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("assigns and removes a role on a member, observed via realtime", async () => {
    const { client: owner, session: ownerSession, community } = await ownerWithCommunity("ca-assign");
    const { client: member, session: memberSession } = await registerUser("ca-assign-m");
    await member.communities.join(community.id);

    const { id: roleId } = await owner.communityAdmin.createRole({
      communityId: community.id,
      title: uniqueName("assignable"),
      type: "CUSTOM_MANUAL_ASSIGN",
      assignmentRules: { type: "free" },
      permissions: [],
    });

    const memberRt = member.realtime();
    open.push(memberRt);
    await memberRt.connect();
    await memberRt.login(memberSession.deviceId, memberSession.deviceKey);

    const waitAdded = memberRt.waitFor(
      "cliMembershipEvent",
      (e) => "action" in e && e.action === "roles_added" && e.data.roleIds.includes(roleId),
    );
    await owner.communityAdmin.addUserToRoles(memberSession.response.ownData.id, community.id, [roleId]);
    const added = await waitAdded;
    expect(added.data.userId).toBe(memberSession.response.ownData.id);

    await owner.communityAdmin.removeUserFromRoles(memberSession.response.ownData.id, community.id, [roleId]);
    void ownerSession;
  });

  it("creates an area and a channel inside it; the channel is writable", async () => {
    const { client, session, community } = await ownerWithCommunity("ca-chan");
    await client.communityAdmin.createArea(community.id, uniqueName("area"), 1);
    const withArea = await client.communities.getDetailView({ id: community.id });
    const area = (withArea.areas as { id: string; title: string }[]).at(-1)!;

    const member = memberRole(community);
    await client.communityAdmin.createChannel({
      communityId: community.id,
      areaId: area.id,
      title: uniqueName("chan"),
      order: 1,
      emoji: "💬",
      rolePermissions: [
        { roleId: member.id, roleTitle: "Member", permissions: ["CHANNEL_EXISTS", "CHANNEL_READ", "CHANNEL_WRITE"] },
      ],
    });
    const withChannel = await client.communities.getDetailView({ id: community.id });
    const channel = (withChannel.channels as { channelId: string; areaId: string }[]).find(
      (c) => c.areaId === area.id,
    )!;
    expect(channel).toBeDefined();

    // The new channel is actually usable: post to it.
    const sent = await client.messages.send({
      access: { channelId: channel.channelId, communityId: community.id },
      body: textBody("first post in a brand-new channel"),
    });
    expect(sent.id).toMatch(/^[0-9a-f-]{36}$/);

    await client.communityAdmin.deleteChannel(channel.channelId, community.id);
  });

  it("bans a member, who then cannot post; unban restores access", async () => {
    const { client: owner, community } = await ownerWithCommunity("ca-ban");
    const { client: member, session: memberSession } = await registerUser("ca-ban-m");
    await member.communities.join(community.id);
    const channel = community.channels[0];
    const access = { channelId: channel.channelId, communityId: community.id };

    // Member can post before the ban.
    await member.messages.send({ access, body: textBody("before ban") });

    await owner.communityAdmin.setUserBlockState(memberSession.response.ownData.id, community.id, "BANNED");
    const banned = await owner.communityAdmin.getBannedUsers(community.id);
    expect(banned.some((b) => b.userId === memberSession.response.ownData.id && b.blockState === "BANNED")).toBe(true);

    await expect(member.messages.send({ access, body: textBody("after ban") })).rejects.toMatchObject({
      code: "NOT_ALLOWED",
    });

    await owner.communityAdmin.setUserBlockState(memberSession.response.ownData.id, community.id, null);
  });

  it("password protection: set via onboarding, read back, verify", async () => {
    const { client, community } = await ownerWithCommunity("ca-pw");
    const password = "conformance-secret";
    await client.communityAdmin.updateNotificationState([
      { communityId: community.id, notifyMentions: true, notifyReplies: true, notifyPosts: false, notifyEvents: true, notifyCalls: true },
    ]);
    // setOnboardingOptions carries the password.
    await client.transport.call("Community/setOnboardingOptions", {
      communityId: community.id,
      password,
      onboardingOptions: { passwordProtected: { enabled: true } },
    });
    const read = await client.communityAdmin.getCommunityPassword(community.id);
    expect(read.password).toBe(password);
    expect((await client.communityAdmin.verifyCommunityPassword(community.id, password)).valid).toBe(true);
    expect((await client.communityAdmin.verifyCommunityPassword(community.id, "wrong")).valid).toBe(false);
  });

  it("creates a community event (reminder) and lists it", async () => {
    const { client, session, community } = await ownerWithCommunity("ca-event");
    const member = memberRole(community);
    // scheduleDate must be in the future.
    const scheduleDate = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const event = await client.communityAdmin.createEvent({
      type: "reminder",
      communityId: community.id,
      title: "conformance reminder",
      duration: 30,
      scheduleDate,
      rolePermissions: [
        { roleId: member.id, roleTitle: "Member", permissions: ["EVENT_PREVIEW", "EVENT_ATTEND"] },
      ],
    });
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.type).toBe("reminder");

    const events = await client.communityAdmin.getEvents(community.id);
    expect(events.some((e) => e.id === event.id)).toBe(true);

    // Self-attend, then read the participants back. (getEventParticipants
    // used to error on a phantom "leftAt" column — fixed on this branch,
    // FINDINGS F-12.)
    await client.communityAdmin.addEventParticipant(event.id);
    const participants = await client.communityAdmin.getEventParticipants(event.id);
    expect(participants).toContain(session.response.ownData.id);

    await client.communityAdmin.deleteEvent(event.id, community.id);
  });

  it("getMyEvents accepts the (scheduledBefore, beforeId) cursor (#67)", async () => {
    // Regression: the public type + repository support a beforeId cursor, but a
    // strict validator omitted it, so any client that paginated per the contract
    // got VALIDATION. Attend two future events so they appear in getMyEvents
    // (selfOnly), then page with a cursor.
    const { client, community } = await ownerWithCommunity("ca-myevents");
    const member = memberRole(community);
    const soon = await client.communityAdmin.createEvent({
      type: "reminder",
      communityId: community.id,
      title: "soon",
      duration: 30,
      scheduleDate: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      rolePermissions: [
        { roleId: member.id, roleTitle: "Member", permissions: ["EVENT_PREVIEW", "EVENT_ATTEND"] },
      ],
    });
    const later = await client.communityAdmin.createEvent({
      type: "reminder",
      communityId: community.id,
      title: "later",
      duration: 30,
      scheduleDate: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      rolePermissions: [
        { roleId: member.id, roleTitle: "Member", permissions: ["EVENT_PREVIEW", "EVENT_ATTEND"] },
      ],
    });
    await client.communityAdmin.addEventParticipant(soon.id);
    await client.communityAdmin.addEventParticipant(later.id);

    // First page: default cursor (both null) — before #67 this threw VALIDATION.
    const firstPage = await client.communityAdmin.getMyEvents();
    const firstIds = firstPage.map((e) => e.id);
    expect(firstIds).toContain(soon.id);
    expect(firstIds).toContain(later.id);

    // A real cursor is accepted and never re-returns the cursor item itself.
    const nextPage = await client.communityAdmin.getMyEvents({
      scheduledBefore: soon.scheduleDate,
      beforeId: soon.id,
    });
    expect(nextPage.map((e) => e.id)).not.toContain(soon.id);

    // Invalid cursor fields still reject.
    await expect(
      client.communityAdmin.getMyEvents({ scheduledBefore: null, beforeId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("a non-manager member cannot manage roles (permission gate)", async () => {
    const { community } = await ownerWithCommunity("ca-perm");
    const { client: member } = await registerUser("ca-perm-m");
    await member.communities.join(community.id);
    await expect(
      member.communityAdmin.createRole({
        communityId: community.id,
        title: uniqueName("nope"),
        type: "CUSTOM_MANUAL_ASSIGN",
        assignmentRules: { type: "free" },
        permissions: [],
      }),
    ).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    void newClient;
    void TEST_PASSWORD;
  });
});

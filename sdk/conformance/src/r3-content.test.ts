/**
 * R3 — files, notifications, search, profile.
 *
 * Contracts: srv/api/files.ts (multipart upload, WebP re-encode, signed
 * path-style downloads), srv/api/notifications.ts (login-gated, VAPID,
 * device-bound push subscriptions), srv/api/search.ts, srv/api/user.ts
 * (own-data/profile updates, availability probes).
 */

import { afterAll, describe, expect, it } from "vitest";
import { textBody, type ApiMessage, type RealtimeClient } from "@commonground/client";
import { makePng } from "./image.js";
import { MUTATIONS_ENABLED, newClient, registerUser, uniqueName } from "./fixtures.js";

describe.runIf(MUTATIONS_ENABLED)("Content & notifications", () => {
  const open: RealtimeClient[] = [];
  afterAll(() => {
    for (const realtime of open) realtime.close();
  });

  it("uploads a profile image, which self-wires into the cg account", async () => {
    const { client, session } = await registerUser("up-prof");
    const png = makePng(64, 64);
    const result = await client.files.uploadImage(png, { type: "userProfileImage" });
    expect(result.imageId).toMatch(/^[0-9a-f]{64}$/);

    // Contract: userProfileImage updates the cg profile server-side; the
    // client must NOT (and cannot) set imageId via updateUserAccount.
    const [card] = await client.profile.getUserData([session.response.ownData.id]);
    const cgAccount = card.accounts.find((a) => a.type === "cg");
    expect(cgAccount?.imageId).toBe(result.imageId);
  });

  it("signed URL download round-trips as WebP", async () => {
    const { client } = await registerUser("up-dl");
    const { imageId } = await client.files.uploadImage(makePng(64, 64), {
      type: "userProfileImage",
    });

    const [signed] = await client.files.getSignedUrls([imageId]);
    expect(signed.objectId).toBe(imageId);
    expect(new Date(signed.validUntil).getTime()).toBeGreaterThan(Date.now());
    // Clean path form: /files/<id>/<sig>/<date>/<expires>, signature in path.
    expect(new URL(signed.url).pathname).toMatch(new RegExp(`^/files/${imageId}/`));

    const response = await fetch(client.files.rebaseSignedUrl(signed));
    expect(response.status).toBe(200);
    const bytes = Buffer.from(await response.arrayBuffer());
    // WebP magic: RIFF....WEBP — proof of the server-side re-encode.
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString("ascii")).toBe("WEBP");
  });

  it("channel attachment upload yields two ids and attaches to a message", async () => {
    const { client } = await registerUser("up-att");
    const community = await client.communities.create({ title: uniqueName("up-att") });
    const access = { channelId: community.channels[0].channelId, communityId: community.id };

    const result = await client.files.uploadImage(makePng(128, 96), {
      type: "channelAttachmentImage",
    });
    expect(result.imageId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.largeImageId).toMatch(/^[0-9a-f]{64}$/);

    const sent = await client.messages.send({
      access,
      body: textBody("with attachment"),
      attachments: [{ type: "image", imageId: result.imageId, largeImageId: result.largeImageId! }],
    });
    const [loaded] = (await client.messages.byIds(access, [sent.id])) as ApiMessage[];
    expect(loaded.attachments).toHaveLength(1);
    expect(loaded.attachments[0]).toMatchObject({ type: "image", imageId: result.imageId });
  });

  it("oversized uploads are rejected without breaking the session", async () => {
    const { client } = await registerUser("up-big");
    // >8 MB of file bytes trips the multer cap, which surfaces as a
    // non-envelope error through the proxy (not FILESIZE_EXCEEDED — that
    // code covers the post-decode check). Contract-relevant part: rejected,
    // and the session keeps working afterwards.
    const big = Buffer.concat([makePng(64, 64), Buffer.alloc(9 * 1024 * 1024, 7)]);
    await expect(client.files.uploadImage(big, { type: "userProfileImage" })).rejects.toThrow();
    const ok = await client.files.uploadImage(makePng(32, 32), { type: "userProfileImage" });
    expect(ok.imageId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("follow → Follower notification: event, unread count, read lifecycle", async () => {
    const { client: a, session: sessionA } = await registerUser("noti-a");
    const { client: b, session: sessionB } = await registerUser("noti-b");

    const realtimeB = b.realtime();
    open.push(realtimeB);
    await realtimeB.connect();
    await realtimeB.login(sessionB.deviceId, sessionB.deviceKey);

    expect(await b.notifications.getUnreadCount()).toBe(0);

    const waitNotification = realtimeB.waitFor(
      "cliNotificationEvent",
      (e) => "action" in e && e.action === "new",
    );
    await a.social.follow(sessionB.response.ownData.id);
    await waitNotification;

    expect(await b.notifications.getUnreadCount()).toBe(1);
    const unread = await b.notifications.load({ unreadOnly: true });
    expect(unread).toHaveLength(1);
    expect(unread[0].type).toBe("Follower");
    expect(unread[0].subjectUserId).toBe(sessionA.response.ownData.id);
    expect(unread[0].read).toBe(false);

    await b.notifications.markAsRead(unread[0].id);
    expect(await b.notifications.getUnreadCount()).toBe(0);

    // markAllAsRead is idempotent even with nothing unread
    await b.notifications.markAllAsRead();
    expect(await b.notifications.getUnreadCount()).toBe(0);
  });

  it("VAPID key is exposed; push subscription registers and unregisters", async () => {
    const { client } = await registerUser("push");
    const vapid = await client.notifications.getPublicVapidKey();
    // base64url-encoded uncompressed P-256 point (65 bytes → 87 chars)
    expect(vapid).toMatch(/^[A-Za-z0-9_-]{87}$/);

    await client.notifications.registerWebPushSubscription({
      endpoint: "https://push.invalid/conformance-endpoint",
      expirationTime: null,
      keys: {
        auth: Buffer.from("0123456789abcdef").toString("base64url"),
        p256dh: Buffer.alloc(65, 4).toString("base64url"),
      },
    });
    await client.notifications.unregisterWebPushSubscription();
  });

  it("user search finds fixtures by name prefix", async () => {
    const { session } = await registerUser("search");
    const displayName = session.response.ownData.accounts[0].displayName!;
    const { client: searcher } = await registerUser("searcher");

    const hits = await searcher.profile.searchUsers({ query: displayName });
    expect(hits.map((h) => h.id)).toContain(session.response.ownData.id);
    const hit = hits.find((h) => h.id === session.response.ownData.id)!;
    expect(hit.matchedAccountTypes).toContain("cg");
  });

  it("profile update, availability probes, own-data patch", async () => {
    const { client, session } = await registerUser("prof");
    const name = session.response.ownData.accounts[0].displayName!;

    expect(await client.profile.isCgProfileNameAvailable(name)).toBe(false);
    expect(await client.profile.isCgProfileNameAvailable(uniqueName("free"))).toBe(true);
    expect(await client.profile.isEmailAvailable(session.response.ownData.email!)).toBe(false);

    await client.profile.updateCgAccount({ description: "conformance fixture description" });
    const details = await client.profile.getUserProfileDetails(session.response.ownData.id);
    const cgDetail = (details.detailledProfiles as { type: string; extraData?: { description?: string } }[]).find(
      (p) => p.type === "cg",
    );
    expect(cgDetail?.extraData?.description).toBe("conformance fixture description");

    await client.profile.updateOwnData({ dmNotifications: false });
    // No getOwnData endpoint (contract: own data arrives via login response
    // and cliUserOwnData) — re-login and check the flag stuck.
    const relogin = await newClient().auth.loginWithPassword(
      session.response.ownData.email!,
      (await import("./fixtures.js")).TEST_PASSWORD,
    );
    expect(relogin.response.ownData.dmNotifications).toBe(false);
  });

  it("DM requires mutual follow, then message flows through the chat channel", async () => {
    const { client: a, session: sessionA } = await registerUser("dm-a");
    const { client: b, session: sessionB } = await registerUser("dm-b");
    const idA = sessionA.response.ownData.id;
    const idB = sessionB.response.ownData.id;

    // One-directional follow is NOT enough (mutual-follow gate).
    await a.social.follow(idB);
    await expect(a.chats.start(idB)).rejects.toMatchObject({ code: "NOT_ALLOWED" });

    await b.social.follow(idA);
    const chat = await a.chats.start(idB);
    expect(chat.userIds.sort()).toEqual([idA, idB].sort());

    const realtimeB = b.realtime();
    open.push(realtimeB);
    await realtimeB.connect();
    await realtimeB.login(sessionB.deviceId, sessionB.deviceKey);

    const waitDm = realtimeB.waitFor("cliMessageEvent", (e) => "action" in e && e.action === "new");
    const access = { channelId: chat.channelId, chatId: chat.id };
    const sent = await a.messages.send({ access, body: textBody("dm hello") });
    const received = (await waitDm) as { data: ApiMessage };
    expect(received.data.id).toBe(sent.id);

    const chatsB = await b.chats.list();
    expect(chatsB.map((c) => c.id)).toContain(chat.id);
  });
});

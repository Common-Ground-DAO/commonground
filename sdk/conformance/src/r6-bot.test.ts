/**
 * R6 — bot bearer API coverage.
 *
 * Contract: srv/api/bots.ts (session-side create/issueToken),
 * srv/api/botV1.ts (bearer-side /api/bot/v1/whoami, scopes/list, messages/*),
 * srv/util/botPrincipal.ts (bearer auth, cookie mutual-exclusion),
 * srv/wsapi.ts (bot socket handshake auth). Proves the SDK doubles as the
 * official bot library: a bot is a user, so the same message/realtime
 * machinery works under bearer auth.
 */

import { afterAll, describe, expect, it } from "vitest";
import { BotClient, textBody, type RealtimeClient } from "@commonground/client";
import { BASE_URL } from "./env.js";
import { MUTATIONS_ENABLED, registerUser, uniqueName } from "./fixtures.js";

describe.runIf(MUTATIONS_ENABLED)("Bot bearer API", () => {
  const open: RealtimeClient[] = [];
  afterAll(() => {
    for (const realtime of open) realtime.close();
  });

  async function ownerWithBot(tag: string) {
    const { client: owner, session } = await registerUser(tag);
    const bot = await owner.bots.create({
      ownerType: "user",
      ownerId: session.response.ownData.id,
      username: uniqueName(`${tag}bot`),
      description: "conformance bot",
    });
    const issued = await owner.bots.issueToken(bot.userId, "conformance-token");
    return { owner, session, bot, token: issued.token };
  }

  it("issues a cgb_ token; whoami identifies the bot", async () => {
    const { bot, token } = await ownerWithBot("bot-who");
    expect(token).toMatch(/^cgb_[A-Za-z0-9_-]{43}$/);

    const botClient = new BotClient({ baseUrl: BASE_URL, token });
    const identity = await botClient.whoami();
    expect(identity.userId).toBe(bot.userId);
    expect(identity.protocolVersion).toBe("1");
  });

  it("a bad bearer token is rejected with HTTP 401", async () => {
    // Bot-auth middleware uses real HTTP status codes (unlike RPC errors).
    const bad = new BotClient({ baseUrl: BASE_URL, token: "cgb_" + "x".repeat(43) });
    await expect(bad.whoami()).rejects.toMatchObject({ httpStatus: 401 });
  });

  it("scopes/list works over the bearer surface", async () => {
    const { token } = await ownerWithBot("bot-scopes");
    const botClient = new BotClient({ baseUrl: BASE_URL, token });
    // Shape varies; the point is the authenticated call succeeds.
    await expect(botClient.listScopes()).resolves.toBeDefined();
  });

  it("a freshly-created community bot cannot yet post (install gap — F-11)", async () => {
    // Documents a contract gap the reference client surfaced: `Bot/create`
    // for a community owner returns success and reports the community in the
    // bot's `communityIds`, but the bot ends up with NO role in that
    // community — so `assertActiveCommunityAccess` → `_assertBotInstalled`
    // (which requires the Member role) rejects its messages with NOT_ALLOWED.
    // The Member role itself grants CHANNEL_WRITE (a human member posts fine,
    // R2), so this is purely the missing membership row. See FINDINGS F-11.
    const { client: owner } = await registerUser("bot-msg");
    const community = await owner.communities.create({ title: uniqueName("bot-msg") });
    const access = { channelId: community.channels[0].channelId, communityId: community.id };

    const bot = await owner.bots.create({
      ownerType: "community",
      ownerId: community.id,
      username: uniqueName("bot-msg-c"),
      description: "community bot",
    });
    // The create response claims membership...
    expect(bot.communityIds).toContain(community.id);
    const { token } = await owner.bots.issueToken(bot.userId, "conformance");

    // ...but posting is still gated. This assertion pins the CURRENT behavior;
    // when the server fix lands, this test flips to a successful round-trip.
    const botClient = new BotClient({ baseUrl: BASE_URL, token });
    await expect(
      botClient.messages.send({ access, body: textBody("beep boop from a bot") }),
    ).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  });

  it("a bot connects to realtime via handshake token auth", async () => {
    const { token } = await ownerWithBot("bot-rt");
    const botClient = new BotClient({ baseUrl: BASE_URL, token });
    const realtime = botClient.realtime();
    open.push(realtime);
    await realtime.connect();
    // Bots are auto-authenticated by the handshake (no in-band login needed);
    // buildId greeting still arrives.
    await new Promise((r) => setTimeout(r, 500));
    expect(realtime.buildId?.buildId).toBeTruthy();
    const serverNow = await realtime.ping();
    expect(Math.abs(serverNow - Date.now())).toBeLessThan(10_000);
  });
});

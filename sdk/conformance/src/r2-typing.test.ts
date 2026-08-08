/**
 * R2 — typing presence (cliTypingEvent).
 *
 * Contract: srv/wsapi.ts `setTyping` handler + srv/repositories/typingCache.ts.
 * Ephemeral, socket-only: the client emits `setTyping {access, isTyping}` (no
 * ack), the server authorizes (WRITE for community channels; membership for
 * DMs/articles), throttles, and relays `cliTypingEvent {access, userId,
 * isTyping}` to the other participants — never echoing to the sender. The
 * server holds no authoritative state; receivers apply a local expiry.
 */

import { afterAll, describe, expect, it } from "vitest";
import { type CommonGroundClient, type RealtimeClient } from "@commonground/client";
import { MUTATIONS_ENABLED, newClient, registerUser, uniqueName } from "./fixtures.js";

describe.runIf(MUTATIONS_ENABLED)("Typing presence", () => {
  const open: RealtimeClient[] = [];
  afterAll(() => {
    for (const realtime of open) realtime.close();
  });

  async function connectedRealtime(client: CommonGroundClient, session: { deviceId: string; deviceKey: any }) {
    const realtime = client.realtime();
    await realtime.connect();
    await realtime.login(session.deviceId, session.deviceKey);
    open.push(realtime);
    return realtime;
  }

  /** Collect matching typing events for a bounded window (for negative asserts). */
  function collectTyping(realtime: RealtimeClient, ms = 1500) {
    const events: { access: any; userId: string; isTyping: boolean }[] = [];
    const off = realtime.onEvent((e) => {
      if (e.type === "cliTypingEvent") events.push(e.payload as any);
    });
    return new Promise<typeof events>((resolve) =>
      setTimeout(() => {
        off();
        resolve(events);
      }, ms),
    );
  }

  it("A types in a community channel; B receives start then stop; A is not echoed", async () => {
    const { client: a, session: sessionA } = await registerUser("typ-a");
    const { client: b, session: sessionB } = await registerUser("typ-b");
    const userA = sessionA.response.ownData.id;

    const community = await a.communities.create({ title: uniqueName("typ-comm") });
    const channel = community.channels[0];
    const access = { channelId: channel.channelId, communityId: community.id };
    await b.communities.join(community.id);

    const realtimeA = await connectedRealtime(a, sessionA);
    const realtimeB = await connectedRealtime(b, sessionB);

    // start → B sees isTyping:true with A's id and the echoed access.
    const waitStart = realtimeB.waitFor(
      "cliTypingEvent",
      (e) => e.userId === userA && e.isTyping === true,
    );
    // A must NOT receive its own typing (sender is excluded by user room).
    const aSelf = collectTyping(realtimeA, 1500);
    realtimeA.startTyping(access);
    const start = await waitStart;
    expect(start.isTyping).toBe(true);
    expect(start.userId).toBe(userA);
    expect((start.access as { channelId: string }).channelId).toBe(channel.channelId);
    expect((start.access as { communityId: string }).communityId).toBe(community.id);

    // stop → B sees isTyping:false.
    const waitStop = realtimeB.waitFor(
      "cliTypingEvent",
      (e) => e.userId === userA && e.isTyping === false,
    );
    realtimeA.stopTyping(access);
    const stop = await waitStop;
    expect(stop.isTyping).toBe(false);

    expect((await aSelf).length).toBe(0); // no self-echo
    void sessionB;
  });

  it("a non-member cannot broadcast typing into a channel (WRITE-gated, no leak)", async () => {
    const { client: a, session: sessionA } = await registerUser("typ-auth-a");
    const { client: b, session: sessionB } = await registerUser("typ-auth-b");
    const { session: sessionOutsider } = await registerUser("typ-auth-out");
    const outsider = newClient();
    const outsiderLogin = await outsider.auth.loginWithDevice(
      sessionOutsider.deviceId,
      sessionOutsider.deviceKey,
    );

    const community = await a.communities.create({ title: uniqueName("typ-auth") });
    const channel = community.channels[0];
    const access = { channelId: channel.channelId, communityId: community.id };
    await b.communities.join(community.id);

    const realtimeB = await connectedRealtime(b, sessionB);
    const realtimeOut = await connectedRealtime(outsider, outsiderLogin);

    // The outsider (not a member → no writer role) emits typing for the channel.
    const bHeard = collectTyping(realtimeB, 1500);
    realtimeOut.startTyping(access);

    // B, a legitimate member, must receive nothing: the server rejects the
    // unauthorized sender rather than relaying it.
    expect((await bHeard).length).toBe(0);
    void sessionA;
  });
});

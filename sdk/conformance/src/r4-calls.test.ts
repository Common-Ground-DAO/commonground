/**
 * R4 — call signaling (protoo, no media).
 *
 * Contract: srv/api/community.ts startCall/getCall/getCurrentCalls;
 * srv/mediasoup/room.ts (protoo request handler, in-band device-signature
 * auth gate, join permission). This proves the full signaling handshake a
 * native client replicates — getSignableSecret → login →
 * getRouterRtpCapabilities → join — WITHOUT sending media (node WebRTC is
 * out of scope by roadmap decision).
 *
 * The disposable instance publishes the protoo port at CONFORMANCE_PROTOO_PORT
 * (default 14443) on 127.0.0.1 and uses a self-signed mediasoup cert.
 */

import { afterAll, describe, expect, it } from "vitest";
import { ProtooError, type CallSignalingSession } from "@commonground/client";
import { IS_DISPOSABLE, MUTATIONS_ENABLED, registerUser, uniqueName } from "./fixtures.js";

const PROTOO_PORT = Number(process.env.CONFORMANCE_PROTOO_PORT ?? 14443);
const PROTOO_ENDPOINT = `127.0.0.1:${PROTOO_PORT}`;
// Calls need the mediasoup service + protoo reachability; only meaningful on
// the disposable instance where we publish that port and trust its cert.
const CALLS_ENABLED = MUTATIONS_ENABLED && IS_DISPOSABLE;

describe.runIf(CALLS_ENABLED)("Call signaling", () => {
  const sessions: CallSignalingSession[] = [];
  afterAll(() => {
    for (const session of sessions) session.close();
  });

  async function communityWithCall(tag: string) {
    const { client, session } = await registerUser(tag);
    const community = await client.communities.create({ title: uniqueName(tag) });
    const call = await client.calls.start({
      communityId: community.id,
      callCreator: session.response.ownData.id,
    });
    return { client, session, community, call };
  }

  it("startCall returns a joinable Call with a callServerUrl", async () => {
    const { call, community, session } = await communityWithCall("call-start");
    expect(call.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.communityId).toBe(community.id);
    expect(call.callServerUrl).toBeTruthy();
    expect(call.callCreator).toBe(session.response.ownData.id);
  });

  it("getCall omits the call-server fields its type promises (F-10)", async () => {
    const { client, call, community } = await communityWithCall("call-getcall");
    const fetched = await client.calls.getCall(call.id, community.id);
    expect(fetched.id).toBe(call.id);
    // The URL is never here (must come from startCall/cliCallEvent)...
    expect(fetched.callServerUrl).toBeUndefined();
    // ...and despite the declared type, neither is callServerId nor
    // communityId — the SQL selects neither (FINDINGS F-10). A native client
    // relying on the .d.ts would read undefined.
    expect(fetched.callServerId).toBeUndefined();
    expect(fetched.communityId).toBeUndefined();
    expect(fetched.callCreator).toBe(call.callCreator);
  });

  it("full signaling handshake: getSignableSecret → login → caps → join", async () => {
    const { client, session, call } = await communityWithCall("call-join");
    const joined = await client.calls.joinSignaling(
      call,
      session.response.ownData.id,
      session.deviceId,
      session.deviceKey,
      "reference-client",
      { endpoint: PROTOO_ENDPOINT, protoo: { rejectUnauthorized: false } },
    );
    sessions.push(joined);

    // Router RTP capabilities are real mediasoup caps.
    expect(joined.routerRtpCapabilities).toHaveProperty("codecs");
    // The creator joining their own fresh call: sole peer, no broadcasters.
    expect(Array.isArray(joined.join.peers)).toBe(true);
    expect(Array.isArray(joined.join.broadcasters)).toBe(true);
    expect(Array.isArray(joined.join.handsRaised)).toBe(true);
    // protoo peer stays connected after join (media would come next).
    expect(joined.protoo.connected).toBe(true);
  });

  it("two peers in one call see each other in the peer list", async () => {
    // Creator starts + joins; a second member joins the same room.
    const { client: creator, session: creatorSession, community, call } =
      await communityWithCall("call-2p");

    const creatorSignaling = await creator.calls.joinSignaling(
      call,
      creatorSession.response.ownData.id,
      creatorSession.deviceId,
      creatorSession.deviceKey,
      "creator",
      { endpoint: PROTOO_ENDPOINT, protoo: { rejectUnauthorized: false } },
    );
    sessions.push(creatorSignaling);

    const { client: member, session: memberSession } = await registerUser("call-2p-m");
    await member.communities.join(community.id);
    const memberSignaling = await member.calls.joinSignaling(
      call,
      memberSession.response.ownData.id,
      memberSession.deviceId,
      memberSession.deviceKey,
      "member",
      { endpoint: PROTOO_ENDPOINT, protoo: { rejectUnauthorized: false } },
    );
    sessions.push(memberSignaling);

    // The member joined after the creator, so it sees the creator as a peer.
    expect(memberSignaling.join.peers.map((p) => p.id)).toContain(
      creatorSession.response.ownData.id,
    );
  });

  it("protoo requests before login are rejected (auth gate)", async () => {
    const { session, call } = await communityWithCall("call-authgate");
    const { ProtooClient } = await import("@commonground/client");
    const url =
      `wss://${PROTOO_ENDPOINT}/?roomId=${call.id}` +
      `&peerId=${session.response.ownData.id}&consumerReplicas=0` +
      `&callCreator=${call.callCreator}&callType=${call.callType}`;
    const protoo = new ProtooClient(url, { rejectUnauthorized: false });
    await protoo.connect();
    // join without login → LOGIN_REQUIRED (protoo reject).
    await expect(protoo.request("join", { displayName: "no-auth" })).rejects.toBeInstanceOf(
      ProtooError,
    );
    protoo.close();
  });

  it("a peerId that isn't the signing user is rejected at login", async () => {
    const { call } = await communityWithCall("call-peerbind");
    const { client, session } = await registerUser("call-peerbind2");
    // Use a WRONG peerId (someone else's id) with our own key: the server
    // binds peer.id === verified userId and answers login "ERROR".
    const wrongPeerId = "00000000-0000-4000-8000-000000000000";
    await expect(
      client.calls.joinSignaling(
        call,
        wrongPeerId,
        session.deviceId,
        session.deviceKey,
        "impostor",
        { endpoint: PROTOO_ENDPOINT, protoo: { rejectUnauthorized: false } },
      ),
    ).rejects.toThrow(/protoo login failed/);
  });
});

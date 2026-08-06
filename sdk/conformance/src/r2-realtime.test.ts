/**
 * R2 — realtime sync.
 *
 * Contract: srv/wsapi.ts (socket path /api/ws/, cookie attach, in-band
 * getSignableSecret→login, buildId greeting, cgPing); srv/repositories/
 * event.ts (event name = type, payload without type, room targeting);
 * srv/api/messages.ts + community.ts (REST writes that emit the events).
 */

import { afterAll, describe, expect, it } from "vitest";
import { textBody, type ApiMessage, type CommonGroundClient, type RealtimeClient } from "@commonground/client";
import { MUTATIONS_ENABLED, newClient, registerUser, TEST_PASSWORD, uniqueName } from "./fixtures.js";

describe.runIf(MUTATIONS_ENABLED)("Realtime sync", () => {
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

  it("connects with the session cookie, gets buildId, answers cgPing, logs in", async () => {
    const { client, session } = await registerUser("rt-conn");
    const realtime = client.realtime();
    open.push(realtime);
    await realtime.connect();
    // buildId greeting: positional (buildId, serverTime), fired on connect.
    await new Promise((r) => setTimeout(r, 500));
    expect(realtime.buildId?.buildId).toBeTruthy();
    expect(Math.abs(realtime.buildId!.serverTime - Date.now())).toBeLessThan(10_000);

    const serverNow = await realtime.ping();
    expect(Math.abs(serverNow - Date.now())).toBeLessThan(10_000);

    await realtime.login(session.deviceId, session.deviceKey);
  });

  it("socket login with a bad signature is rejected", async () => {
    const { client, session } = await registerUser("rt-badsig");
    const { client: other, session: otherSession } = await registerUser("rt-badsig2");
    void other;
    const realtime = client.realtime();
    open.push(realtime);
    await realtime.connect();
    // Sign with the WRONG user's key: server must answer "ERROR".
    await expect(realtime.login(session.deviceId, otherSession.deviceKey)).rejects.toThrow(
      /socket login failed/,
    );
  });

  it("send/edit/delete echo to the user's OTHER device (sender device excluded)", async () => {
    // Contract (srv/api/messages.ts emitMessageEvents): the sending DEVICE is
    // excluded from its own cliMessageEvent — the REST response is its echo.
    // Other devices of the same user must receive new/update/delete.
    const { client: device1, session } = await registerUser("rt-msg");
    const device2 = newClient();
    const login2 = await device2.auth.loginWithPassword(
      session.response.ownData.email!,
      TEST_PASSWORD,
    );
    const community = await device1.communities.create({ title: uniqueName("rt-comm") });
    expect(community.channels.length).toBeGreaterThan(0);
    const channel = community.channels[0];
    const access = { channelId: channel.channelId, communityId: community.id };

    const realtime2 = await connectedRealtime(device2, login2);
    const store = device2.store();
    store.hydrateFromLogin(login2.response);
    store.attach(realtime2);

    // send → device 2 sees action:new with the body verbatim
    const body = textBody("hello from the reference client\nsecond line");
    const waitNew = realtime2.waitFor("cliMessageEvent", (e) => "action" in e && e.action === "new");
    const sent = await device1.messages.send({ access, body });
    const eventNew = (await waitNew) as { action: "new"; data: ApiMessage };
    expect(eventNew.data.id).toBe(sent.id);
    expect(eventNew.data.body).toEqual(body);
    expect(store.channelMessages(channel.channelId).map((m) => m.id)).toContain(sent.id);

    // edit → action:update carrying the new body
    const newBody = textBody("edited");
    const waitUpdate = realtime2.waitFor(
      "cliMessageEvent",
      (e) => "action" in e && e.action === "update" && (e.data as { id: string }).id === sent.id,
    );
    await device1.messages.edit(access, sent.id, { body: newBody });
    const eventUpdate = (await waitUpdate) as { data: Partial<ApiMessage> & { id: string } };
    expect(eventUpdate.data.body).toEqual(newBody);
    expect(store.channelMessages(channel.channelId)[0].body).toEqual(newBody);

    // delete → action:delete with deletedIds
    const waitDelete = realtime2.waitFor(
      "cliMessageEvent",
      (e) => "action" in e && e.action === "delete",
    );
    await device1.messages.delete(access, sent.id, sent.creatorId);
    const eventDelete = (await waitDelete) as { data: { deletedIds: string[] } };
    expect(eventDelete.data.deletedIds).toContain(sent.id);
    expect(store.channelMessages(channel.channelId)).toHaveLength(0);
  });

  it("a live socket is joined to rooms of a community created mid-session", async () => {
    // A's socket connects BEFORE the community exists; creating it must move
    // the live socket into the new rooms (event.ts userJoinRooms →
    // socketsJoin), proven by receiving another user's message afterwards.
    const { client: a, session: sessionA } = await registerUser("rt-live-a");
    const { client: b } = await registerUser("rt-live-b");
    const realtimeA = await connectedRealtime(a, sessionA);

    const community = await a.communities.create({ title: uniqueName("rt-live") });
    const channel = community.channels[0];
    const access = { channelId: channel.channelId, communityId: community.id };
    await b.communities.join(community.id);

    const waitMessage = realtimeA.waitFor(
      "cliMessageEvent",
      (e) => "action" in e && e.action === "new",
    );
    const sent = await b.messages.send({ access, body: textBody("are you in the room yet?") });
    const received = (await waitMessage) as { data: ApiMessage };
    expect(received.data.id).toBe(sent.id);
  });

  it("two clients: A sends, B receives; history pagination agrees", async () => {
    const { client: a, session: sessionA } = await registerUser("rt-a");
    const { client: b, session: sessionB } = await registerUser("rt-b");

    const community = await a.communities.create({ title: uniqueName("rt-2c") });
    const channel = community.channels[0];
    const access = { channelId: channel.channelId, communityId: community.id };

    const joined = await b.communities.join(community.id);
    expect(joined).not.toBeNull(); // no approval gate on a fresh community

    const realtimeA = await connectedRealtime(a, sessionA);
    const realtimeB = await connectedRealtime(b, sessionB);

    // A → B: the first true multi-client conformance assertion.
    const body = textBody("cross-client delivery");
    const waitB = realtimeB.waitFor("cliMessageEvent", (e) => "action" in e && e.action === "new");
    const sent = await a.messages.send({ access, body });
    const received = (await waitB) as { data: ApiMessage & { communityId?: string } };
    expect(received.data.id).toBe(sent.id);
    expect(received.data.creatorId).toBe(sessionA.response.ownData.id);
    expect(received.data.body).toEqual(body);
    expect(received.data.communityId).toBe(community.id);

    // B → A the other way.
    const waitA = realtimeA.waitFor(
      "cliMessageEvent",
      (e) => "action" in e && e.action === "new" && (e.data as ApiMessage).creatorId === sessionB.response.ownData.id,
    );
    const reply = await b.messages.send({ access, body: textBody("reply") });
    const receivedA = (await waitA) as { data: ApiMessage };
    expect(receivedA.data.id).toBe(reply.id);

    // REST history agrees with what the sockets saw.
    const history = await b.messages.load(access, { createdBefore: new Date().toISOString() });
    const ids = history.map((m) => m.id);
    expect(ids).toContain(sent.id);
    expect(ids).toContain(reply.id);
  });

  it("B sees A's membership join event", async () => {
    const { client: a, session: sessionA } = await registerUser("rt-mem-a");
    const { client: b, session: sessionB } = await registerUser("rt-mem-b");

    const community = await a.communities.create({ title: uniqueName("rt-mem") });
    const realtimeA = await connectedRealtime(a, sessionA);

    const waitJoin = realtimeA.waitFor(
      "cliMembershipEvent",
      (e) => "action" in e && e.action === "join",
    );
    await b.communities.join(community.id);
    const joinEvent = (await waitJoin) as { data: { userId: string; communityId: string } };
    expect(joinEvent.data.userId).toBe(sessionB.response.ownData.id);
    expect(joinEvent.data.communityId).toBe(community.id);
    void sessionB;
  });

  it("read cursor propagates to the user's other device (cliChannelLastRead)", async () => {
    // One user, two devices: the original registration session (device 1)
    // and a fresh password login (device 2, own cookie jar + socket).
    const { client: device1, session } = await registerUser("rt-read");
    const device2 = newClient();
    const login2 = await device2.auth.loginWithPassword(
      session.response.ownData.email!,
      TEST_PASSWORD,
    );

    const community = await device1.communities.create({ title: uniqueName("rt-read") });
    const channel = community.channels[0];
    const access = { channelId: channel.channelId, communityId: community.id };
    await device1.messages.send({ access, body: textBody("unread me") });

    const realtime2 = await connectedRealtime(device2, login2);

    const lastRead = new Date().toISOString();
    const wait = realtime2.waitFor("cliChannelLastRead", (e) => e.channelId === channel.channelId);
    await device1.messages.setChannelLastRead(access, lastRead);
    const event = await wait;
    expect(event.lastRead).toBe(lastRead);
  });
});

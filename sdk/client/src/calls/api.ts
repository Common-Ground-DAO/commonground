/**
 * Call lifecycle (REST) + signaling handshake (protoo).
 *
 * Contract: srv/api/community.ts startCall/getCall/getCurrentCalls (Calls
 * live in the Community router); srv/mediasoup.ts + srv/mediasoup/room.ts
 * (protoo server, URL params, in-band device-signature auth). This module
 * is signaling-ONLY: it takes a client through getSignableSecret → login →
 * getRouterRtpCapabilities → join, and stops before media transports (node
 * WebRTC is out of scope by roadmap decision).
 *
 * Note: getCall returns callServerId, not callServerUrl; the joinable Call
 * (with callServerUrl) comes from startCall's response or the cliCallEvent.
 */

import type { HttpTransport } from "../transport/http.js";
import type { DeviceKey } from "../identity/deviceKey.js";
import { ProtooClient, type ProtooClientOptions } from "./protoo.js";

export type CallType = "default" | "broadcast";

export interface Call {
  id: string;
  communityId: string;
  channelId: string;
  callServerUrl: string;
  callCreator: string;
  callType: CallType;
  slots: number;
  stageSlots: number;
  audioOnly: boolean;
  highQuality: boolean;
  startedAt: string;
  endedAt: string | null;
  [extra: string]: unknown;
}

export interface StartCallOptions {
  communityId: string;
  callCreator: string;
  title?: string;
  description?: string | null;
  callType?: CallType;
  slots?: number;
  stageSlots?: number;
  audioOnly?: boolean;
  hd?: boolean;
}

export interface JoinResult {
  peers: { id: string; displayName: string; device?: unknown }[];
  broadcasters: string[];
  handsRaised: string[];
}

/** A live signaling session: authenticated protoo peer, joined to the room. */
export class CallSignalingSession {
  constructor(
    readonly protoo: ProtooClient,
    readonly routerRtpCapabilities: unknown,
    readonly join: JoinResult,
  ) {}

  close(): void {
    this.protoo.close();
  }
}

const PROTOO_PORT = 4443;

export class CallApi {
  constructor(private readonly transport: HttpTransport) {}

  /** POST /Community/startCall → the joinable Call (carries callServerUrl). */
  async start(options: StartCallOptions): Promise<Call> {
    return this.transport.call("Community/startCall", {
      communityId: options.communityId,
      callCreator: options.callCreator,
      title: options.title ?? "conformance call",
      description: options.description ?? null,
      callType: options.callType ?? "default",
      slots: options.slots ?? 10,
      stageSlots: options.stageSlots ?? 1,
      audioOnly: options.audioOnly ?? true,
      hd: options.hd ?? false,
    });
  }

  /** POST /Community/getCall — note: returns callServerId, NOT callServerUrl. */
  async getCall(id: string, communityId: string): Promise<Record<string, unknown>> {
    return this.transport.call("Community/getCall", { id, communityId });
  }

  async getCurrentCalls(communityId: string): Promise<Call[]> {
    return this.transport.call("Community/getCurrentCalls", { communityId });
  }

  /**
   * Build the protoo URL exactly as srv/util/urlFactory.ts does. `endpoint`
   * overrides `<callServerUrl>:4443` for test rigs that publish the protoo
   * port elsewhere (the conformance instance does, to coexist with a live
   * stack on 4443).
   */
  buildProtooUrl(call: Call, peerId: string, consumerReplicas = 0, endpoint?: string): string {
    const authority = endpoint ?? `${call.callServerUrl}:${PROTOO_PORT}`;
    return (
      `wss://${authority}/?roomId=${call.id}` +
      `&peerId=${peerId}&consumerReplicas=${consumerReplicas}` +
      `&callCreator=${call.callCreator}&callType=${call.callType}`
    );
  }

  /**
   * Signaling-only join: connect protoo, run the in-band device-signature
   * login (getSignableSecret → sign → login), load router capabilities, and
   * join the room. Stops before any media transport. peerId MUST be the
   * signing user's id (the server enforces peer.id === userId).
   */
  async joinSignaling(
    call: Call,
    userId: string,
    deviceId: string,
    deviceKey: DeviceKey,
    displayName: string,
    options: { protoo?: ProtooClientOptions; consumerReplicas?: number; endpoint?: string } = {},
  ): Promise<CallSignalingSession> {
    const url = this.buildProtooUrl(call, userId, options.consumerReplicas ?? 0, options.endpoint);
    const protoo = new ProtooClient(url, options.protoo);
    await protoo.connect();

    // In-band auth — same crypto as the app socket / HTTP device login.
    const secret = (await protoo.request("getSignableSecret")) as string;
    const base64Signature = await deviceKey.signSecret(secret);
    const loginResult = (await protoo.request("login", { secret, deviceId, base64Signature })) as string;
    if (loginResult !== "OK") {
      protoo.close();
      throw new Error(`protoo login failed: ${loginResult}`);
    }

    const routerRtpCapabilities = await protoo.request("getRouterRtpCapabilities");
    // join is the last signaling step; media transports are deliberately skipped.
    const join = (await protoo.request("join", {
      displayName,
      device: { flag: "reference-client", name: "commonground-sdk", version: "0.1.0" },
      rtpCapabilities: routerRtpCapabilities,
    })) as JoinResult;

    return new CallSignalingSession(protoo, routerRtpCapabilities, join);
  }
}

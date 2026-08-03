// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import protooClient, { Peer } from "protoo-client";
import * as mediasoupClient from "mediasoup-client";
import { getProtooUrl } from "./urlFactory";
import {
  Consumer,
  Transport,
  Producer,
  Device,
  RtpEncodingParameters,
  ConnectionState,
} from "mediasoup-client/lib/types";
import {
  Action,
  RECENT_REACTIONS_WINDOW_SECONDS,
  RoomPeer,
  initializeCallPayload,
} from "components/organisms/CallPage/CallPage.reducer";
import { signApiSecret } from "data/util/device";
import loginManager from "data/appstate/login";
import { CallType } from "common/enums";

export class RoomClient {
  private _closed: boolean;
  private _displayName: string;
  private _peerId: string;
  private _device: any;
  private _forceTcp: boolean;
  private _produce: boolean;
  private _consume: boolean;
  private _enableWebcamLayers: boolean;
  private _enableSharingLayers: boolean;
  private _numSimulcastStreams: number;
  private _protooUrl: string;
  private _protoo?: Peer;
  private _mediasoupDevice?: Device;
  private _sendTransport?: Transport;
  private _recvTransport?: Transport;
  private _micProducer?: Producer;
  private _webcamProducer?: Producer;
  private _shareProducer?: Producer;
  private _consumers: Map<string, Consumer>;
  private _webcams: Map<String, MediaDeviceInfo>;
  private _webcam: { device?: MediaDeviceInfo };
  private _dispatch: (action: Action) => void;
  private _callType: CallType;
  private _callState: string;
  private _cleanReactionsTimeout: any;
  private _audioOnly: boolean;
  private _highQuality: boolean;
  private _onNewPeer: () => void;
  private _onPeerLeft: () => void;
  private _sendTransportRestartAttempts = 0;
  private _sendTransportRestarting = false;
  broadcasters: Map<string, string>;
  handsRaised: Map<string, string>;

  constructor({
    roomId,
    peerId,
    displayName,
    device,
    forceTcp,
    produce,
    consume,
    consumerReplicas,
    dispatch,
    callServerUrl,
    callType,
    callCreator,
    onNewPeer,
    onPeerLeft,
    audioOnly,
    highQuality
  }: {
    roomId: string;
    peerId: string;
    displayName: string;
    device: any;
    forceTcp: boolean;
    produce: boolean;
    consume: boolean;
    consumerReplicas: number;
    dispatch: (action: Action) => void;
    callServerUrl: string;
    callType: CallType;
    callCreator: string;
    onNewPeer: () => void;
    onPeerLeft: () => void;
    audioOnly: boolean;
    highQuality: boolean;
  }) {
    console.log(
      'constructor() [roomId:"%s", peerId:"%s", displayName:"%s", device:%s]',
      roomId,
      peerId,
      displayName,
      device.flag
    );

    this._peerId = peerId;
    this._closed = false;
    this._displayName = displayName;
    this._device = device;
    this._forceTcp = forceTcp;
    this._produce = produce;
    this._consume = consume;
    this._callType = callType;
    this._callState = "connecting";
    this._enableWebcamLayers = true;
    this._enableSharingLayers = false;
    this._numSimulcastStreams = 3;
    this._protooUrl = getProtooUrl({
      roomId,
      peerId,
      consumerReplicas,
      callServerUrl,
      callType,
      callCreator,
    });
    this._protoo = undefined;
    this._mediasoupDevice = undefined;
    this._sendTransport = undefined;
    this._recvTransport = undefined;
    this._micProducer = undefined;
    this._webcamProducer = undefined;
    this._shareProducer = undefined;
    this._consumers = new Map();
    this._webcams = new Map();
    this._webcam = {
      device: undefined,
    };
    this.broadcasters = new Map();
    this.handsRaised = new Map();
    this._cleanReactionsTimeout = null;
    this._audioOnly = audioOnly;
    this._highQuality = highQuality;

    if (callCreator === peerId) {
      this.broadcasters.set(peerId, peerId);
    }

    this._dispatch = dispatch;

    if (this._callType === CallType.DEFAULT) {
      this._onNewPeer = onNewPeer;
      this._onPeerLeft = onPeerLeft;
    } else {
      this._onNewPeer = () => {};
      this._onPeerLeft = () => {};
    }
  }

  close() {
    if (this._closed) return;

    this._closed = true;

    console.log("close()");

    this._protoo?.close();

    if (this._sendTransport) this._sendTransport.close();

    if (this._recvTransport) this._recvTransport.close();

    this._callState = "closed";
    this._dispatch({ type: "setRoomState", payload: "closed" });
    this._dispatch({ type: "exitCall"} );
  }

  async join(payload: initializeCallPayload) {
    const protooTransport = new protooClient.WebSocketTransport(
      this._protooUrl
    );

    this._protoo = new protooClient.Peer(protooTransport);

    this._dispatch({ type: "setRoomState", payload: "connecting" });
    this._callState = "connecting";

    this._protoo.on("open", () => this._joinRoom(payload));

    this._protoo.on("failed", () => {
      console.error("WebSocket connection failed");
    });

    this._protoo.on("disconnected", () => {
      console.error("WebSocket disconnected");
      if (this._sendTransport) {
        this._sendTransport.close();
        this._sendTransport = undefined;
      }

      if (this._recvTransport) {
        this._recvTransport.close();
        this._recvTransport = undefined;
      }
      this._dispatch({ type: "setRoomState", payload: "closed" });
      this._callState = "closed";

    });

    this._protoo.on("close", () => {
      if (this._closed) return;

      this.close();
    });

    this._protoo.on("request", async (request, accept, reject) => {
      console.log(
        'proto "request" event [method:%s, data:%o]',
        request.method,
        request.data
      );

      switch (request.method) {
        case "newConsumer": {
          if (!this._consume) {
            reject(403, "I do not want to consume");

            break;
          }

          const {
            peerId,
            producerId,
            id,
            kind,
            rtpParameters,
            type,
            appData,
            producerPaused,
          } = request.data;

          try {
            if (this._recvTransport) {
              const consumer = await this._recvTransport.consume({
                id,
                producerId,
                kind,
                rtpParameters,
                // streamId: `${peerId}-${appData.share ? 'share' : 'mic-webcam'}`,
                appData: { ...appData, peerId }, // Trick.
              });

              this._consumers.set(consumer.id, consumer);

              consumer.on("transportclose", () => {
                this._consumers.delete(consumer.id);
              });

              const { spatialLayers, temporalLayers } =
                mediasoupClient.parseScalabilityMode(
                  (consumer.rtpParameters.encodings as any)[0].scalabilityMode
                );

              const consumerKind = consumer.appData?.share
                ? "share"
                : consumer.kind;
              this._dispatch({
                type: "addConsumer",
                payload: {
                  consumer: {
                    id: consumer.id,
                    type: type,
                    locallyPaused: false,
                    remotelyPaused: producerPaused,
                    rtpParameters: consumer.rtpParameters,
                    spatialLayers: spatialLayers,
                    temporalLayers: temporalLayers,
                    preferredSpatialLayer: spatialLayers - 1,
                    preferredTemporalLayer: temporalLayers - 1,
                    priority: 1,
                    codec:
                      consumer.rtpParameters.codecs[0].mimeType.split("/")[1],
                    track: consumer.track,
                    kind: consumerKind,
                  },
                  peerId,
                },
              });

              accept();
            }
          } catch (error) {
            console.error('"newConsumer" request failed:%o', error);

            throw error;
          }

          break;
        }
      }
    });

    this._protoo.on("notification", async (notification) => {
      console.log(
        'proto "notification" event [method:%s, data:%o]',
        notification.method,
        notification.data
      );

      switch (notification.method) {
        case "producerScore": {
          const { producerId, score } = notification.data;

          this._dispatch({
            type: "setProducerScore",
            payload: { producerId, score },
          });

          break;
        }

        case "newPeer": {
          const peer = notification.data;

          this._dispatch({
            type: "addUsers",
            payload: [{ ...peer, consumers: [] }],
          });
          this._onNewPeer();

          break;
        }

        case "peerClosed": {
          const { peerId } = notification.data;
          this._dispatch({ type: "removeUser", payload: peerId });
          this._onPeerLeft();

          break;
        }
        case "downlinkBwe": {
          console.log("'downlinkBwe' event:%o", notification.data);

          break;
        }

        case "consumerClosed": {
          const { consumerId } = notification.data;
          const consumer = this._consumers.get(consumerId);

          if (!consumer) break;

          consumer.close();
          this._consumers.delete(consumerId);

          const { peerId } = consumer.appData;
          this._dispatch({
            type: "removeConsumerFromPeer",
            payload: { consumerId: consumerId, peerId: peerId as string },
          });

          break;
        }

        case "consumerPaused": {
          const { consumerId } = notification.data;
          const consumer = this._consumers.get(consumerId);

          if (!consumer) break;

          consumer.pause();

          this._dispatch({
            type: "setConsumerPaused",
            payload: { consumerId, originator: "remote" },
          });

          break;
        }

        case "consumerResumed": {
          const { consumerId } = notification.data;
          const consumer = this._consumers.get(consumerId);

          if (!consumer) break;

          consumer.resume();

          this._dispatch({
            type: "setConsumerResumed",
            payload: { consumerId, originator: "remote" },
          });

          break;
        }

        case "consumerLayersChanged": {
          const { consumerId, spatialLayer, temporalLayer } = notification.data;
          const consumer = this._consumers.get(consumerId);

          if (!consumer) break;

          this._dispatch({
            type: "setConsumerCurrentLayers",
            payload: { consumerId, spatialLayer, temporalLayer },
          });

          break;
        }

        case "consumerScore": {
          const { consumerId, score } = notification.data;

          this._dispatch({
            type: "setConsumerScore",
            payload: { consumerId, score },
          });

          break;
        }

        case "activeSpeaker": {
          const { peerId } = notification.data;

          this._dispatch({
            type: "setIsTalking",
            payload: { peerId: peerId, isTalking: true },
          });

          break;
        }
        case "dominantSpeaker": {
          const { peerId } = notification.data;

          this._dispatch({ type: "setRoomDominantSpeaker", payload: peerId });

          break;
        }
        case "raisedHand": {
          const { peerId } = notification.data;

          this._dispatch({ type: "raiseHand", peerId });

          break;
        }
        case "loweredHand": {
          const { peerId } = notification.data;

          this._dispatch({ type: "lowerHand", peerId });

          break;
        }
        case "promotedBroadcaster": {
          const { peerId } = notification.data;

          if (peerId === this._peerId) {
            if (!this._mediasoupDevice) {
              return;
            }

            if (!this._sendTransport) {
              await this.enableProducing();
            }
            this._dispatch({
              type: "setMediaCapabilities",
              payload: {
                canSendMic: this._mediasoupDevice.canProduce("audio"),
                canSendWebcam: this._mediasoupDevice.canProduce("video"),
              },
            });
          }

          this.broadcasters.set(peerId, peerId);
          this._dispatch({ type: "promoteBroadcaster", peerId });

          break;
        }
        case "demotedBroadcaster": {
          const { peerId } = notification.data;

          if (peerId === this._peerId) {
            await this.disableMic();

            if (this._webcamProducer) {
              await this.disableWebcam();
            }
            if (this._shareProducer) {
              await this.disableShare();
            }

            this._sendTransport?.close();
            this._sendTransport = undefined;
          }

          this.broadcasters.delete(peerId);
          this._dispatch({ type: "demoteBroadcaster", peerId });

          break;
        }

        case "callEnded": {
          this._dispatch({ type: "exitCall" });
          this.close();
          break;
        }

        case "moderationMuted": {
          this._dispatch({ type: "toggleMuted" });
          break;
        }

        case "reactionReceived": {
          const { peerId, reaction } = notification.data;
          this._dispatch({
            type: "addReaction",
            payload: { peerId, reaction },
          });

          clearTimeout(this._cleanReactionsTimeout);
          this._cleanReactionsTimeout = setTimeout(() => {
            this._dispatch({ type: "clearReactions" });
          }, RECENT_REACTIONS_WINDOW_SECONDS * 1000);
          break;
        }

        case "callUpdate": {
          const { slots, stageSlots, audioOnly, highQuality } = notification.data as { slots: number, stageSlots: number, audioOnly: boolean, highQuality: boolean };
          this._dispatch({ type: "updateCallConfigs", payload: { callSlots: slots, stageSlots, audioOnly, highQuality } });
          break;
        }

        default: {
          console.error(
            'unknown protoo notification.method "%s"',
            notification.method
          );
        }
      }
    });
  }

  async enableMic() {
    console.log("enableMic()");

    if (this._micProducer) return;

    if (!this._mediasoupDevice?.canProduce("audio")) {
      console.error("enableMic() | cannot produce audio");

      return;
    }

    let track;

    try {
      console.log("enableMic() | calling getUserMedia()");
      const deviceId = localStorage.getItem("selectedAudioDeviceId");
      let stream: MediaStream;
      const fixedDeviceId = deviceId?.replace(/['"]+/g, "");
      if (fixedDeviceId && fixedDeviceId.length > 0) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: { exact: fixedDeviceId },
            },
          });
        } catch (error) {
          console.warn("enableMic() | failed to get audio device by id:%o", error);
          console.log("enableMic() | calling getUserMedia()");
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      track = stream.getAudioTracks()[0];
      track.applyConstraints({
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      });

      if(!this._sendTransport) {
        await this.enableProducing();
      }

      this._micProducer = await this._sendTransport?.produce({
        track,
        codecOptions: {
          opusStereo: true,
          opusDtx: true,
          opusFec: true,
        },
      });

      if (this._micProducer) {
        this._dispatch({
          type: "addProducer",
          payload: {
            producer: {
              id: this._micProducer.id,
              paused: this._micProducer.paused,
              track: this._micProducer.track,
              rtpParameters: this._micProducer.rtpParameters,
              codec:
                this._micProducer.rtpParameters.codecs[0].mimeType.split(
                  "/"
                )[1],
            },
            id: this._micProducer.id,
          },
        });

        this._micProducer.on("transportclose", () => {
          this._micProducer = undefined;
        });

        this._micProducer.on("trackended", () => {
          console.warn("Microphone disconnected!");
          if(!this._micProducer?.paused) {
            this._dispatch({ type: "toggleMuted" });
          }
          this.disableMic().catch(() => {});
          
        });
      }
    } catch (error) {
      console.error("enableMic() | failed:%o", error);

      if (track) track.stop();
    }
  }

  async disableMic() {
    console.log("disableMic()");

    if (!this._micProducer) return;

    this._micProducer.close();

    this._dispatch({ type: "removeProducer", payload: this._micProducer.id });

    try {
      await this._protoo?.request("closeProducer", {
        producerId: this._micProducer.id,
      });
    } catch (error) {
      console.error(`Error closing server-side mic Producer: ${error}`);
    }

    this._micProducer = undefined;
  }

  async muteMic() {
    console.log("muteMic()");
    if (this._micProducer) {
      this._micProducer.pause();

      try {
        await this._protoo?.request("pauseProducer", {
          producerId: this._micProducer.id,
        });

        this._dispatch({
          type: "setProducerPaused",
          payload: this._micProducer.id,
        });
        this._dispatch({ type: "toggleMuted" });
      } catch (error) {
        console.error("muteMic() | failed: %o", error);
      }
    } else {
      console.warn("muteMic() | no micProducer");
    }
  }

  async moderationMuteMic(peerId: string) {
    console.log("moderationMuteMic()");
    //get audio producer from peerId
    try {
      await this._protoo?.request("moderationMute", { mutedPeerId: peerId });
    } catch (error) {
      console.error("moderationMuteMic() | failed: %o", error);
    }
  }

  async unmuteMic() {
    console.log("unmuteMic()");

    if (this._micProducer) {
      this._micProducer.resume();

      try {
        await this._protoo?.request("resumeProducer", {
          producerId: this._micProducer.id,
        });

        this._dispatch({
          type: "setProducerResumed",
          payload: this._micProducer.id,
        });
        this._dispatch({ type: "toggleMuted" });
      } catch (error) {
        console.error("unmuteMic() | failed: %o", error);
      }
    } else {
      console.warn("unmuteMic() | no micProducer, trying to enable mic");
      if (this._produce) {
        await this.enableMic();
      } else {
        console.warn("unmuteMic() | can't produce audio");
      }
    }
  }

  async setMaxSendingSpatialLayer(spatialLayer: number) {
    console.log("setMaxSendingSpatialLayer() [spatialLayer:%s]", spatialLayer);

    try {
      if (this._webcamProducer)
        await this._webcamProducer.setMaxSpatialLayer(spatialLayer);
      else if (this._shareProducer)
        await this._shareProducer.setMaxSpatialLayer(spatialLayer);
    } catch (error) {
      console.error("setMaxSendingSpatialLayer() | failed:%o", error);
    }
  }

  async setConsumerPreferredLayers(
    consumerId: string,
    spatialLayer: number,
    temporalLayer: number
  ) {
    console.log(
      "setConsumerPreferredLayers() [consumerId:%s, spatialLayer:%s, temporalLayer:%s]",
      consumerId,
      spatialLayer,
      temporalLayer
    );

    try {
      await this._protoo?.request("setConsumerPreferredLayers", {
        consumerId,
        spatialLayer,
        temporalLayer,
      });

      this._dispatch({
        type: "setConsumerPreferredLayers",
        payload: { consumerId, spatialLayer, temporalLayer },
      });
    } catch (error) {
      console.error("setConsumerPreferredLayers() | failed:%o", error);
    }
  }

  async setConsumerPriority(consumerId: string, priority: number) {
    console.log(
      "setConsumerPriority() [consumerId:%s, priority:%d]",
      consumerId,
      priority
    );

    try {
      await this._protoo?.request("setConsumerPriority", {
        consumerId,
        priority,
      });

      this._dispatch({
        type: "setConsumerPriority",
        payload: { consumerId, priority },
      });
    } catch (error) {
      console.error("setConsumerPriority() | failed:%o", error);
    }
  }

  async _joinRoom(payload: initializeCallPayload) {
    console.log("_joinRoom()");

    try {
      this._mediasoupDevice = new mediasoupClient.Device();

      const signableSecret = await (this._protoo?.request(
        "getSignableSecret"
      ) as Promise<API.Socket.getSignableSecret.Response>);

      if (!loginManager.currentUser) {
        throw new Error("Mediasoup Server: Needs to be logged in");
      }
      const signedData = await signApiSecret(
        loginManager.currentUser.deviceId,
        signableSecret
      );
      const result: API.Socket.login.Response = await this._protoo?.request(
        "login",
        signedData
      );

      if (result === "ERROR") {
        throw new Error("Mediasoup Server: Authentication failed");
      }

      const routerRtpCapabilities = await this._protoo?.request(
        "getRouterRtpCapabilities"
      );

      await this._mediasoupDevice.load({ routerRtpCapabilities });

      if (this._produce) {
        await this.enableProducing();
      }

      // Create mediasoup Transport for receiving (unless we don't want to consume).
      if (this._consume) {
        await this.enableConsuming();
      }

      // Join now into the room.
      // NOTE: Don't send our RTP capabilities if we don't want to consume.
      const { peers, broadcasters, handsRaised } = (await this._protoo?.request(
        "join",
        {
          displayName: this._displayName,
          device: this._device,
          rtpCapabilities: this._mediasoupDevice.rtpCapabilities,
        }
      )) as {
        peers: RoomPeer[];
        broadcasters: string[];
        handsRaised: string[];
      };

      this._dispatch({
        type: "initializeCall",
        payload
      });

      if (this._callType === CallType.BROADCAST) {
        this._dispatch({
          type: "initializeBroadcast",
          payload: { peers, broadcasters, handsRaised },
        });
        if (broadcasters.length > 0) {
          for (const broadcaster of broadcasters) {
            this.broadcasters.set(broadcaster, broadcaster);
          }
        }
        if (handsRaised.length > 0) {
          for (const handRaised of handsRaised) {
            this.handsRaised.set(handRaised, handRaised);
          }
        }
      } else {
        const payload = peers.map(peer => ({ ...peer, consumers: [] }));
        this._dispatch({
          type: "addUsers",
          payload,
        });
      }

    } catch (error) {
      console.error("_joinRoom() failed:%o", error);

      this.close();
    }
  }

  private async enableProducing() {
    if (!this._mediasoupDevice || !this._protoo) {
      throw new Error("Mediasoup Device or Protoo not initialized");
    }

    if(this._sendTransport) {
      this._sendTransport.close();
    }

    const transportInfo = await this._protoo?.request("createWebRtcTransport", {
      forceTcp: this._forceTcp,
      producing: true,
      consuming: false,
    });

    const { id, iceParameters, iceCandidates, dtlsParameters } = transportInfo;

    this._sendTransport = this._mediasoupDevice.createSendTransport({
      id,
      iceParameters,
      iceCandidates,
      dtlsParameters: {
        ...dtlsParameters,
        role: "auto",
      },
      iceServers: [],
    });

    this._sendTransport.on(
      "connect",
      (
        { dtlsParameters },
        callback,
        errback
      ) => {
        this._protoo
          ?.request("connectWebRtcTransport", {
            transportId: this._sendTransport?.id,
            dtlsParameters,
          })
          .then(callback)
          .catch(errback);
      }
    );

    this._sendTransport.on(
      "produce",
      async ({ kind, rtpParameters, appData }, callback, errback) => {
        try {
          const { id } = await this._protoo?.request("produce", {
            transportId: this._sendTransport?.id,
            kind,
            rtpParameters,
            appData,
          });

          callback({ id });
        } catch (error: any) {
          errback(error);
        }
      }
    );

    this._sendTransport.on("connectionstatechange", (connectionState: ConnectionState) => {
      if (connectionState === "connected") {
        // A healthy connection resets the backoff.
        this._sendTransportRestartAttempts = 0;
      } else if (connectionState === "failed") {
        // Only "failed" is terminal. "disconnected" is frequently transient in
        // ICE and often recovers on its own, so don't tear the transport down
        // for it — doing so used to spin an unthrottled create/fail/close loop.
        this._scheduleSendTransportRestart();
      }
    });
  }

  // Recreate the send transport after a failure, with capped exponential
  // backoff and a guard against concurrent recreation, so a client with a
  // persistent connectivity problem cannot flood the call server with
  // createWebRtcTransport requests.
  private _scheduleSendTransportRestart() {
    if (this._closed || this._sendTransportRestarting) {
      return;
    }
    if (this._sendTransportRestartAttempts >= 5) {
      console.error("send transport failed repeatedly, giving up");
      return;
    }

    this._sendTransportRestarting = true;
    const delay = Math.min(30000, 1000 * 2 ** this._sendTransportRestartAttempts);
    this._sendTransportRestartAttempts++;

    setTimeout(async () => {
      try {
        if (this._closed) {
          return;
        }
        this._sendTransport?.close();
        await this.enableProducing();
      } catch (error) {
        console.error("send transport restart failed", error);
      } finally {
        this._sendTransportRestarting = false;
      }
    }, delay);
  }

  private async enableConsuming() {
    if (!this._mediasoupDevice || !this._protoo) {
      throw new Error("Mediasoup Device or Protoo not initialized");
    }

    if(this._recvTransport) {
      this._recvTransport.close();
      this._recvTransport = undefined;
    }

    const transportInfo = await this._protoo.request(
      "createWebRtcTransport",
      {
        forceTcp: this._forceTcp,
        producing: false,
        consuming: true,
      }
    );

    const { 
      id, 
      iceParameters, 
      iceCandidates, 
      dtlsParameters 
    } = transportInfo;

    this._recvTransport = this._mediasoupDevice.createRecvTransport({
      id,
      iceParameters,
      iceCandidates,
      dtlsParameters: {
        ...dtlsParameters,
        role: "auto",
      },
      iceServers: [],
    });

    this._recvTransport.on(
      "connect",
      (
        { dtlsParameters },
        callback,
        errback
      ) => {
        this._protoo
          ?.request("connectWebRtcTransport", {
            transportId: this._recvTransport?.id,
            dtlsParameters,
          })
          .then(callback)
          .catch(errback);
      }
    );

    this._recvTransport.on("connectionstatechange", async (connectionState) => {
      if (connectionState === "failed" || connectionState === "disconnected") {
        const iceParameters = await this._protoo?.request(
          'restartIce',
          { transportId: this._recvTransport?.id });

        await this._recvTransport?.restartIce({ iceParameters });
      }
    });
  }

  async enableWebcam() {
    console.log("enableWebcam()");

    if (this._audioOnly) {
      throw new Error("Cannot enable webcam in audio only mode");
    }

    if (this._webcamProducer) return;
    else if (this._shareProducer) await this.disableShare();

    if (!this._mediasoupDevice?.canProduce("video")) {
      console.error("enableWebcam() | cannot produce video");

      return;
    }

    let track;
    let device;

    this._dispatch({ type: "setWebcamInProgress", payload: true });

    try {
      await this._updateWebcams();
      device = this._webcam.device;

      if (!device) throw new Error("no webcam devices");

      console.log("enableWebcam() | calling getUserMedia()");

      let stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: device.deviceId },
          width: { ideal: this._highQuality ? 1920 : 1280 },
          height: { ideal: this._highQuality ? 1080 : 720 },
          frameRate: { ideal: this._highQuality ? 60 : 30 },
        },
      });

      if (stream.getVideoTracks().length === 0) {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { ideal: device.deviceId },
          },
        });
      }
      track = stream.getVideoTracks()[0];

      let encodings: RtpEncodingParameters[] = [];
      let codec;
      const codecOptions = {
        videoGoogleStartBitrate: 1000,
      };

      if (this._mediasoupDevice) {
        if (this._mediasoupDevice.rtpCapabilities.codecs) {
          if (this._enableWebcamLayers) {
            // If VP9 is the only available video codec then use SVC.
            const firstVideoCodec =
              this._mediasoupDevice.rtpCapabilities.codecs.find(
                (c) => c.kind === "video"
              );

            // VP9 with SVC.
            if (
              codec ||
              firstVideoCodec?.mimeType.toLowerCase() === "video/vp9"
            ) {
              encodings = [
                {
                  scalabilityMode: "L3T3_KEY",
                },
              ];
            }
            // VP8 or H264 with simulcast.
            else {
              encodings = [
                {
                  scalabilityMode: "L1T3",
                },
              ];

              if (this._numSimulcastStreams > 1) {
                encodings.unshift({
                  scaleResolutionDownBy: 1.25,
                  scalabilityMode: "L1T3",
                });
              }

              if (this._numSimulcastStreams > 2) {
                encodings.unshift({
                  scaleResolutionDownBy: 2,
                  scalabilityMode: "L1T3",
                });
              }
            }
          }
        }

        this._webcamProducer = await this._sendTransport?.produce({
          track,
          encodings,
          codecOptions,
          codec,
        });

        if (this._webcamProducer) {
          this._dispatch({
            type: "addProducer",
            payload: {
              id: this._webcamProducer.id,
              producer: {
                id: this._webcamProducer?.id,
                deviceLabel: device.label,
                type: this._getWebcamType(device),
                paused: this._webcamProducer?.paused,
                track: this._webcamProducer?.track,
                rtpParameters: this._webcamProducer?.rtpParameters,
                codec:
                  this._webcamProducer?.rtpParameters.codecs[0].mimeType.split(
                    "/"
                  )[1],
              },
            },
          });
          this._webcamProducer.on("transportclose", () => {
            this._webcamProducer = undefined;
          });

          this._webcamProducer.on("trackended", () => {
            console.log("webcam track ended");

            this.disableWebcam().catch(() => {});
          });
        }
      }
    } catch (error) {
      console.error("enableWebcam() | failed:%o", error);

      if (track) track.stop();
    }

    this._dispatch({ type: "setWebcamInProgress", payload: false });
  }

  _getWebcamType(device: MediaDeviceInfo) {
    if (/(back|rear)/i.test(device.label)) {
      return "back";
    } else {
      return "front";
    }
  }

  async endCallForEveryone(peerId: string) {
    try {
      await this._protoo?.request("endCallForEveryone", { peerId });
    } catch (error) {
      console.error("endCallForEveryone() | failed:%o", error);
    }
  }

  async disableWebcam() {
    console.log("disableWebcam()");

    if (!this._webcamProducer) return;

    this._webcamProducer.close();

    this._dispatch({
      type: "removeProducer",
      payload: this._webcamProducer.id,
    });

    try {
      await this._protoo?.request("closeProducer", {
        producerId: this._webcamProducer.id,
      });
    } catch (error) {
      console.error(`Error closing server-side webcam Producer: ${error}`);
    }

    this._webcamProducer = undefined;
  }

  async enableShare() {
    console.log("enableShare()");

    if (this._audioOnly) {
      throw new Error("Cannot enable sharing in audio only mode");
    }

    if (this._shareProducer) return;
    else if (this._webcamProducer) await this.disableWebcam();

    if (!this._mediasoupDevice) {
      return;
    }

    if (!this._mediasoupDevice.canProduce("video")) {
      console.error("enableShare() | cannot produce video");

      return;
    }

    let track;

    this._dispatch({ type: "setShareInProgress", payload: true });

    try {
      console.log("enableShare() | calling getDisplayMedia()");

      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: {
          displaySurface: "monitor",
          logicalSurface: true,
          cursor: true,
          width: { max: this._highQuality ? 1920 : 1280 },
          height: { max: this._highQuality ? 1080 : 720 },
          frameRate: { max: this._highQuality ? 60 : 30 },
        } as MediaTrackConstraints,
      });

      // May mean cancelled (in some implementations).
      if (!stream) {
        this._dispatch({ type: "setShareInProgress", payload: false });

        return;
      }

      track = stream.getVideoTracks()[0];

      let encodings;
      let codec;
      const codecOptions = {
        videoGoogleStartBitrate: 1000,
      };

      if (this._mediasoupDevice) {
        if (this._mediasoupDevice.rtpCapabilities.codecs) {
          if (this._enableSharingLayers) {
            // If VP9 is the only available video codec then use SVC.
            const firstVideoCodec =
              this._mediasoupDevice.rtpCapabilities.codecs.find(
                (c) => c.kind === "video"
              );

            // VP9 with SVC.
            if (
              codec ||
              firstVideoCodec?.mimeType.toLowerCase() === "video/vp9"
            ) {
              encodings = [
                {
                  maxBitrate: 10000000,
                  scalabilityMode: "L3T3",
                  dtx: true,
                },
              ];
            }
            // VP8 or H264 with simulcast.
            else {
              encodings = [
                {
                  scaleResolutionDownBy: 1,
                  maxBitrate: 10000000,
                  scalabilityMode: "L1T3",
                  dtx: true,
                },
              ];

              if (this._numSimulcastStreams > 1) {
                encodings.unshift({
                  scaleResolutionDownBy: 1.25,
                  maxBitrate: 2500000,
                  scalabilityMode: "L1T3",
                  dtx: true,
                });
              }

              if (this._numSimulcastStreams > 2) {
                encodings.unshift({
                  scaleResolutionDownBy: 2,
                  maxBitrate: 1000000,
                  scalabilityMode: "L1T3",
                  dtx: true,
                });
              }
            }
          }
        }
        this._shareProducer = await this._sendTransport?.produce({
          track,
          encodings,
          codecOptions,
          codec,
          appData: {
            share: true,
          },
        });

        if (this._shareProducer) {
          this._dispatch({
            type: "addProducer",
            payload: {
              id: this._shareProducer.id,
              producer: {
                id: this._shareProducer.id,
                type: "share",
                paused: this._shareProducer.paused,
                track: this._shareProducer.track,
                rtpParameters: this._shareProducer.rtpParameters,
                codec:
                  this._shareProducer.rtpParameters.codecs[0].mimeType.split(
                    "/"
                  )[1],
              },
            },
          });

          this._shareProducer.on("transportclose", () => {
            this._shareProducer = undefined;
          });

          this._shareProducer.on("trackended", () => {
            console.log("Share disconnected!");

            this.disableShare().catch(() => {});
          });
        }
      }
    } catch (error) {
      console.error("enableShare() | failed:%o", error);

      if (track) track.stop();
    }

    this._dispatch({ type: "setShareInProgress", payload: false });
  }

  async disableShare() {
    console.log("disableShare()");

    if (!this._shareProducer) return;

    this._shareProducer.close();

    this._dispatch({ type: "removeProducer", payload: this._shareProducer.id });

    try {
      await this._protoo?.request("closeProducer", {
        producerId: this._shareProducer.id,
      });
    } catch (error) {
      console.error(`Error closing server-side share Producer: ${error}`);
    }

    this._shareProducer = undefined;
  }

  async _updateWebcams() {
    console.log("_updateWebcams()");
    navigator.mediaDevices.getUserMedia({ audio: false, video: true });

    // Reset the list.
    this._webcams = new Map();

    console.log("_updateWebcams() | calling enumerateDevices()");

    const devices = await navigator.mediaDevices.enumerateDevices();

    for (const device of devices) {
      if (device.kind !== "videoinput") continue;

      this._webcams.set(device.deviceId, device);
    }

    const array = Array.from(this._webcams.values());
    const len = array.length;
    const savedWebcamId = localStorage.getItem("selectedVideoDeviceId");
    const fixedwebcamId = savedWebcamId?.replace(/['"]+/g, "");
    //remove double quotes from string
    if (fixedwebcamId) {
      this._webcam.device = this._webcams.get(fixedwebcamId!);
    }

    const currentWebcamId = this._webcam.device
      ? this._webcam.device.deviceId
      : undefined;

    console.log("_updateWebcams() [webcams:%o]", array);

    if (len === 0) this._webcam.device = undefined;
    else if (!this._webcams.has(currentWebcamId!))
      this._webcam.device = array[0];

    this._dispatch({
      type: "setCanChangeWebcam",
      payload: this._webcams.size > 1,
    });
  }

  async changeWebcam(deviceId: string) {
    console.log("changeWebcam()");

    this._dispatch({ type: "setWebcamInProgress", payload: true });
    try {
      await this.disableWebcam();
      await this.enableWebcam();
    } catch (error) {
      console.error("changeWebcam() | failed: %o", error);
    }

    this._dispatch({ type: "setWebcamInProgress", payload: false });
  }

  async changeMicrophone(deviceId: string) {
    console.log("changeMicrophone()");

    try {
      if (!this._micProducer) throw new Error("no mic producer");

      // Closing the current audio track before asking for a new one.
      this._micProducer.track?.stop();

      console.log("changeMicrophone() | calling getUserMedia()");

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const track = stream.getAudioTracks()[0];
      track.applyConstraints({
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      });

      await this._micProducer.replaceTrack({ track });

      this._dispatch({
        type: "setProducerTrack",
        payload: { producerId: this._micProducer.id, track },
      });
    } catch (error) {
      console.error("changeMicrophone() | failed: %o", error);
    }
  }

  async _pauseConsumer(consumer: Consumer) {
    if (consumer.paused) return;

    try {
      await this._protoo?.request("pauseConsumer", { consumerId: consumer.id });

      consumer.pause();

      this._dispatch({
        type: "setConsumerPaused",
        payload: { consumerId: consumer.id, originator: "local" },
      });
    } catch (error) {
      console.error("_pauseConsumer() | failed:%o", error);
    }
  }

  async _resumeConsumer(consumer: Consumer) {
    if (!consumer.paused) return;

    try {
      await this._protoo?.request("resumeConsumer", {
        consumerId: consumer.id,
      });

      consumer.resume();

      this._dispatch({
        type: "setConsumerResumed",
        payload: { consumerId: consumer.id, originator: "local" },
      });
    } catch (error) {
      console.error("_resumeConsumer() | failed:%o", error);
    }
  }

  async raiseHand(peerId: string) {
    try {
      await this._protoo?.request("raiseHand", { peerId });

      this._dispatch({ type: "raiseHand", peerId });
    } catch (error) {
      console.error("_raiseHand() | failed:%o", error);
    }
  }

  async lowerHand(peerId: string) {
    try {
      await this._protoo?.request("lowerHand", { peerId });

      this._dispatch({ type: "lowerHand", peerId });
    } catch (error) {
      console.error("_lowerHand() | failed:%o", error);
    }
  }

  async promoteBroadcaster(peerId: string) {
    try {
      await this._protoo?.request("promoteBroadcaster", {
        promotedPeerId: peerId,
      });

      this._dispatch({ type: "promoteBroadcaster", peerId });
    } catch (error: any) {
      console.error("_promoteBroadcaster() | failed:%o", error);
      throw error;
    }
  }

  async demoteBroadcaster(peerId: string) {
    try {
      await this._protoo?.request("demoteBroadcaster", {
        demotedPeerId: peerId,
      });

      this._dispatch({ type: "demoteBroadcaster", peerId });
    } catch (error) {
      console.error("_demoteBroadcaster() | failed:%o", error);
    }
  }

  async sendReaction(peerId: string, reaction: string) {
    try {
      await this._protoo?.request("peerReaction", { peerId, reaction });
    } catch (error) {
      console.error("_demoteBroadcaster() | failed:%o", error);
    }
  }

  setPeerIsTalking(peerId: string, isTalking: boolean) {
    this._dispatch({
      type: "setIsTalking",
      payload: { peerId: peerId, isTalking: isTalking },
    });
  }

  isMicEnabled(): boolean {
    return !!this._micProducer;
  }

  setConnectedState() {
    this._callState = "connected";
  }

  // delay a dispatch to avoid updating the state before the connected state is set
  async delayedDispatch(action: Action) {
    try {
      let attempts = 0;
      while (attempts < 20 && this._callState !== "connected") {
        console.warn("_dispatch() | waiting for connected state | Action: ",action.type);
        await new Promise((resolve) => setTimeout(resolve, 250));
        attempts++;
      }
      this._dispatch(action);
    } catch (error) {
      console.error("_dispatch() | failed:%o", error);
    }    
  }
}

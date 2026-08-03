// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Joi from "joi";
import common from "../common";

// mediasoup Transport/Producer/Consumer ids are generated server-side and echoed
// back by the client, then used only as Map keys (a wrong value just fails the
// lookup). We validate form + length as abuse defense, not exact identity.
const MsId = Joi.string().min(1).max(64);

// peerIds are userIds (peer.id === users.id, a v4 UUID enforced at login).
const PeerId = common.Uuid;

// Opaque mediasoup protocol objects. We validate "object of bounded size" only,
// never the internal structure (that would be fragile across mediasoup versions).
// .unknown(true) is required because these carry many mediasoup-defined keys.
const MsObject = Joi.object().unknown(true);

// Simulcast/SVC layer indices: small non-negative integers.
const LayerIndex = Joi.number().integer().min(0).max(32);

const mediasoupApi = {
  join: Joi.object({
    // Broadcast to every peer -> keep it short.
    displayName: Joi.string().min(1).max(64).required(),
    device: MsObject.optional(),
    rtpCapabilities: MsObject.optional(),
  }).required().strict(true),

  createWebRtcTransport: Joi.object({
    forceTcp: Joi.boolean().optional(),
    producing: Joi.boolean().required(),
    consuming: Joi.boolean().required(),
  }).required().strict(true),

  connectWebRtcTransport: Joi.object({
    transportId: MsId.required(),
    dtlsParameters: MsObject.required(),
  }).required().strict(true),

  restartIce: Joi.object({
    transportId: MsId.required(),
  }).required().strict(true),

  produce: Joi.object({
    transportId: MsId.required(),
    kind: Joi.string().valid("audio", "video").required(),
    rtpParameters: MsObject.required(),
    // The server overwrites appData.peerId with peer.id after validation.
    appData: Joi.object().max(50).unknown(true).optional(),
  }).required().strict(true),

  closeProducer: Joi.object({ producerId: MsId.required() }).required().strict(true),
  pauseProducer: Joi.object({ producerId: MsId.required() }).required().strict(true),
  resumeProducer: Joi.object({ producerId: MsId.required() }).required().strict(true),
  pauseConsumer: Joi.object({ consumerId: MsId.required() }).required().strict(true),
  resumeConsumer: Joi.object({ consumerId: MsId.required() }).required().strict(true),

  setConsumerPreferredLayers: Joi.object({
    consumerId: MsId.required(),
    spatialLayer: LayerIndex.required(),
    temporalLayer: LayerIndex.required(),
  }).required().strict(true),

  setConsumerPriority: Joi.object({
    consumerId: MsId.required(),
    // mediasoup Consumer priority is an integer in [1, 255].
    priority: Joi.number().integer().min(1).max(255).required(),
  }).required().strict(true),

  // Target peer, permission-gated (may differ from the caller). Identity is NOT
  // bound to peer.id here.
  promoteBroadcaster: Joi.object({ promotedPeerId: PeerId.required() }).required().strict(true),
  demoteBroadcaster: Joi.object({ demotedPeerId: PeerId.required() }).required().strict(true),
  moderationMute: Joi.object({ mutedPeerId: PeerId.required() }).required().strict(true),

  // peerId MUST be re-bound to peer.id in the handler (Joi only checks its form).
  raiseHand: Joi.object({ peerId: PeerId.required() }).required().strict(true),
  lowerHand: Joi.object({ peerId: PeerId.required() }).required().strict(true),

  peerReaction: Joi.object({
    peerId: PeerId.required(),
    // Broadcast AND used as a per-peer blacklist key -> keep it short.
    reaction: Joi.string().min(1).max(32).required(),
  }).required().strict(true),
};

export default mediasoupApi;

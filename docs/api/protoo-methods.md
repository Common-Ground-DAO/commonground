# Call signaling (protoo) method catalog

Voice/video calls use a **separate** transport from the app socket: a
protoo-over-WebSocket server (`srv/mediasoup.ts`, `srv/mediasoup/room.ts`),
independent auth. This catalogs the signaling handshake; the reference client
implements signaling only (media is out of scope — node WebRTC stacks are the
flaky part). SDK: `@commonground/client` `CallApi` + `ProtooClient`.

## Connection

```
wss://<callServerUrl>:4443/?roomId=<callId>&peerId=<userId>&consumerReplicas=<n>&callCreator=<id>&callType=<default|broadcast>
```

- Subprotocol: `protoo`.
- `roomId` and `peerId` are **required**; `peerId` MUST equal the user id the
  in-band login proves (`peer.id === userId`, else login answers `"ERROR"`).
- `callServerUrl` comes from `startCall`'s response or the `cliCallEvent` —
  **not** from `getCall` (which returns `callServerId`; see FINDINGS F-10).

## Framing

```
request:      { request: true,  id, method, data }
response ok:  { response: true, id, ok: true,  data }
response err: { response: true, id, ok: false, errorCode, errorReason }
notification: { notification: true, method, data }
```

Any method other than `getSignableSecret` / `login` throws `LOGIN_REQUIRED`
until the peer is authenticated.

## Signaling handshake (the reference client's boundary)

Ordered — the conformance client runs 1→4 and stops (media transports are 5+):

| # | Method | Request | Response | Proven by |
| --- | --- | --- | --- | --- |
| 1 | `getSignableSecret` | — | `secret: string` (64-hex) | r4-calls full handshake |
| 2 | `login` | `{ secret, deviceId, base64Signature }` | `"OK"` \| `"ERROR"` | r4-calls handshake, "peerId != signer rejected", "auth gate" |
| 3 | `getRouterRtpCapabilities` | — | mediasoup `RtpCapabilities` | r4-calls (asserts `codecs`) |
| 4 | `join` | `{ displayName, device?, rtpCapabilities? }` | `{ peers, broadcasters, handsRaised }` | r4-calls handshake, "two peers see each other" |

## Media methods (catalog only — out of SDK scope)

Transport/media, listed for completeness; a signaling-only client never sends
these: `createWebRtcTransport`, `connectWebRtcTransport`, `restartIce`,
`produce`, `closeProducer`, `pauseProducer`, `resumeProducer`,
`pauseConsumer`, `resumeConsumer`, `setConsumerPreferredLayers`,
`setConsumerPriority`, `promoteBroadcaster`, `demoteBroadcaster`,
`endCallForEveryone`, `raiseHand`, `lowerHand`, `moderationMute`,
`peerReaction`.

## Server → client notifications (tolerated)

`activeSpeaker`, `dominantSpeaker`, `downlinkBwe`, `newConsumer` (sent as a
server *request*), `consumerClosed/Paused/Resumed/Score`, `producerScore`,
`peerClosed`, `callEnded`, `callUpdate`, `promotedBroadcaster`,
`demotedBroadcaster`, `raisedHand`, `loweredHand`, `moderationMuted`,
`reactionReceived`. The SDK's `ProtooClient` rejects unrecognized server
*requests* with `501` by default so the server is never left waiting.

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import protoo, { AcceptFn, Peer, ProtooRequest, RejectFn } from 'protoo-server';
import { mediasoupConfig } from './config';
import { ActiveSpeakerObserver, AudioLevelObserver, Consumer, Producer, Router, WebRtcServer, WebRtcTransport, Worker } from 'mediasoup/node/lib/types';
import Logger from './logger';
import { realRandomHexString } from '../util';
import validators from '../validators';
import deviceHelper from '../repositories/device';
import errors from '../common/errors';
import callHelper from '../repositories/calls';
import { CallType } from '../common/enums';
const EventEmitter = require('events').EventEmitter;

const logger = new Logger('Room');
/**
 * Room class.
 *
 * This is not a "mediasoup Room" by itself, by a custom class that holds
 * a protoo Room (for signaling with WebSocket clients) and a mediasoup Router
 * (for sending and receiving media to/from those WebSocket peers).
 */
export default class Room extends EventEmitter {
    /**
     * Factory function that creates and returns Room instance.
     */
    static async create({ 
        mediasoupWorker, 
        roomId, 
        consumerReplicas, 
        callType, 
        callCreator, 
        callSlots, 
        stageSlots,
        audioOnly,
        highQuality 
    }: { 
        mediasoupWorker: Worker, 
        roomId: string, 
        consumerReplicas: number, 
        callType: CallType, 
        callCreator: string, 
        callSlots: number, 
        stageSlots: number,
        audioOnly: boolean,
        highQuality: boolean 
    }): Promise<Room> {
        logger.info('create() [roomId:%s]', roomId);

        // Create a protoo Room instance.
        const protooRoom = new protoo.Room();

        // Router media codecs.
        const { mediaCodecs } = mediasoupConfig.routerOptions;

        // Create a mediasoup Router.
        const mediasoupRouter = await mediasoupWorker.createRouter({ mediaCodecs });

        // Create a mediasoup AudioLevelObserver.
        const audioLevelObserver = await mediasoupRouter.createAudioLevelObserver(
            {
                maxEntries: 1,
                threshold: -50,
                interval: 500
            });

        // Create a mediasoup ActiveSpeakerObserver.
        const activeSpeakerObserver = await mediasoupRouter.createActiveSpeakerObserver(
            { interval: 2500 }
        );

        const room = new Room(
            {
                roomId,
                protooRoom,
                webRtcServer: mediasoupWorker.appData.webRtcServer as WebRtcServer,
                mediasoupRouter,
                audioLevelObserver,
                activeSpeakerObserver,
                consumerReplicas,
                callType,
                callCreator,
                callSlots,
                stageSlots,
                audioOnly,
                highQuality
            });
        console.log('ROOM CREATED WITH X BROADCASTERS SLOTS: ')
        console.log(stageSlots);
        return room;
    }
    
    private _roomId: string;
    private _closed: boolean;
    private _callType: CallType;
    private _callCreator: string;
    private _broadCasters: Map<string, string> = new Map<string, string>();

    // Override the set method to enforce the maximum size
    private _setBroadcaster(key: string, value: string) {
        if (this._broadCasters.size >= this._stageSlots) {
            throw new Error(errors.server.BROADCASTERS_LIMIT_EXCEEDED);
        }
        this._broadCasters.set(key, value);
    }

    // Use the overridden set method to add broadcasters
    addBroadcaster(key: string, value: string) {
        this._setBroadcaster(key, value);
    }

    private _handsRaised: Map<string, string> = new Map();
    private _protooRoom: protoo.Room;
    private _webRtcServer: WebRtcServer;
    private _mediasoupRouter: Router;
    private _audioLevelObserver: AudioLevelObserver;
    private _activeSpeakerObserver: ActiveSpeakerObserver;
    private _consumerReplicas: number;
    private _slots: number;
    private _stageSlots: number;
    private _audioOnly: boolean;
    private _highQuality: boolean;

    constructor(
        {
            roomId,
            protooRoom,
            webRtcServer,
            mediasoupRouter,
            audioLevelObserver,
            activeSpeakerObserver,
            consumerReplicas,
            callType,
            callCreator,
            callSlots,
            stageSlots,
            audioOnly,
            highQuality
        }: { 
            roomId: string, 
            protooRoom: protoo.Room, 
            webRtcServer: WebRtcServer, 
            mediasoupRouter: Router, 
            audioLevelObserver: AudioLevelObserver, 
            activeSpeakerObserver: ActiveSpeakerObserver, 
            consumerReplicas: number, 
            callType: CallType, 
            callCreator: string, 
            callSlots: number, 
            stageSlots: number, 
            audioOnly: boolean, 
            highQuality: boolean 
        }) {
        super();

        this.setMaxListeners(Infinity);

        this._roomId = roomId;
        this._closed = false;
        this._callCreator = callCreator;
        this._protooRoom = protooRoom;
        this._webRtcServer = webRtcServer;
        this._mediasoupRouter = mediasoupRouter;
        this._audioLevelObserver = audioLevelObserver;
        this._activeSpeakerObserver = activeSpeakerObserver;
        this._consumerReplicas = consumerReplicas || 0;
        this._callType = callType;
        this._handleAudioLevelObserver();
        this._handleActiveSpeakerObserver();
        this._stageSlots = stageSlots;
        this._slots = callSlots;
        this._audioOnly = audioOnly;
        this._highQuality = highQuality;

        if (callType === CallType.BROADCAST) {
            this.addBroadcaster(callCreator, callCreator);
        }
    }

    /**
     * Closes the Room instance by closing the protoo Room and the mediasoup Router.
     */
    close(options?: { force: boolean }) {
        logger.debug('close()');

        this._closed = true;

        this._broadCasters = new Map();

        // Close the protoo Room.
        this._protooRoom.close();

        // Close the mediasoup Router.
        this._mediasoupRouter.close();

        // Emit 'close' event.
        if (options?.force) {
            this.emit('forceClose');
        } else {
            this.emit('close');
        }
    }

    logStatus() {
        logger.info(
            'logStatus() [roomId:%s, protoo Peers:%s]',
            this._roomId,
            this._protooRoom.peers.length
        );
    }

    /**
     * Called from mediasoup.ts upon a protoo WebSocket connection request from a
     * browser.
     */
    async handleProtooConnection({ peerId, consume, protooWebSocketTransport }: { peerId: string, consume: boolean, protooWebSocketTransport: protoo.WebSocketTransport }) {
        const existingPeer = this._protooRoom.getPeer(peerId);

        if (existingPeer) {
            logger.error(
                'handleProtooConnection() | there is already a protoo Peer with same peerId, closing it [peerId:%s]',
                peerId);

            existingPeer.close();
        }

        let peer: Peer;

        // Create a new protoo Peer with the given peerId.
        try {
            peer = await this._protooRoom.createPeer(peerId, protooWebSocketTransport);
        }
        catch (error) {
            logger.error('protooRoom.createPeer() failed:%o', error);
            throw error;
        }

        // Use the peer.data object to store mediasoup related objects.

        // Not joined after a custom protoo 'join' request is later received.
        peer.data.consume = consume;
        peer.data.joined = false;
        peer.data.displayName = undefined;
        peer.data.device = undefined;
        peer.data.rtpCapabilities = undefined;
        peer.data._cgAuth = false;
        peer.data.membershipId = '';

        // Have mediasoup related maps ready even before the Peer joins since we
        // allow creating Transports before joining.
        peer.data.transports = new Map();
        peer.data.producers = new Map();
        peer.data.consumers = new Map();

        peer.data.reactionBlacklist = new Set<string>();

        peer.on('request', (request: ProtooRequest, accept: AcceptFn, reject: RejectFn) => {
            logger.debug(
                'protoo Peer "request" event [method:%s, peerId:%s]',
                request.method, peer.id);

            this._handleProtooRequest(peer, request, accept, reject)
                .catch((error) => {
                    logger.error('request failed:%o', error);

                    reject(error);
                });
        });

        peer.on('close', async () => {
            if (this._closed)
                return;

            logger.debug('protoo Peer "close" event [peerId:%s]', peer.id);
            if (!!peer.data.membershipId) {
                callHelper.callMemberLeave(peer.data.membershipId);
            }
            //remove peer from db table callmembers
            callHelper.updateCallPreviewIds(this._roomId, this._getJoinedPeers().map(peer => peer.id));

            // If the Peer was joined, notify all Peers.
            if (peer.data.joined) {
                //if the peer was broadcast, remove it from the list
                if (this._callType === CallType.BROADCAST) {
                    if (this._broadCasters.get(peer.id)) {
                        this._broadCasters.delete(peer.id);
                        for (const otherPeer of this._getJoinedPeers(peer)) {
                            await otherPeer.notify('demotedBroadcaster', { peerId: peer.id });
                        }
                    }
                    if (this._handsRaised.get(peer.id)) {
                        this._handsRaised.delete(peer.id);
                        for (const otherPeer of this._getJoinedPeers(peer)) {
                            await otherPeer.notify('loweredHand', { peerId: peerId });
                        }
                    }
                }
                for (const otherPeer of this._getJoinedPeers(peer)) {
                    otherPeer.notify('peerClosed', { peerId: peer.id })
                        .catch(() => { });
                }
            }

            // Iterate and close all mediasoup Transport associated to this Peer, so all
            // its Producers and Consumers will also be closed.
            for (const transport of peer.data.transports.values()) {
                transport.close();
            }

            // If this is the latest Peer in the room, close the room.
            if (this._protooRoom.peers.length === 0) {
                logger.info(
                    'last Peer in the room left, closing the room [roomId:%s]',
                    this._roomId);

                this.close();
            }

            if (this._broadCasters.size === 0 && this._callType === CallType.BROADCAST) {
                logger.info(
                    'last broadcaster in the room left, closing the room [roomId:%s]',
                    this._roomId);

                this.close();
            }
        });
    }

    getRouterRtpCapabilities() {
        return this._mediasoupRouter.rtpCapabilities;
    }

    _handleAudioLevelObserver() {
        this._audioLevelObserver.on('volumes', (volumes) => {
            const { producer, volume } = volumes[0];

            logger.debug(
                'audioLevelObserver "volumes" event [producerId:%s, volume:%s]',
                producer.id, volume);

            // Notify all Peers.
            for (const peer of this._getJoinedPeers()) {
                peer.notify(
                    'activeSpeaker',
                    {
                        peerId: producer.appData.peerId,
                        volume: volume
                    })
                    .catch((error) => {
                        logger.error(error)
                    });
            }
        });

        this._audioLevelObserver.on('silence', () => {
            logger.debug('audioLevelObserver "silence" event');

            // Notify all Peers.
            for (const peer of this._getJoinedPeers()) {
                peer.notify('activeSpeaker', { peerId: null })
                    .catch((error) => {
                        logger.error(error)
                    });
            }
        });
    }

    _handleActiveSpeakerObserver() {
        this._activeSpeakerObserver.on('dominantspeaker', (dominantSpeaker) => {
            logger.debug(
                'activeSpeakerObserver "dominantspeaker" event [producerId:%s]',
                dominantSpeaker.producer.id);

            //Notify all Peers.
            for (const peer of this._getJoinedPeers()) {
                peer.notify(
                    'dominantSpeaker',
                    {
                        peerId: dominantSpeaker.producer.appData.peerId
                    })
                    .catch((error) => {
                        logger.error(error)
                    });
            }
        });
    }

    /**
     * Handle protoo requests from browsers.
     *
     * @async
     */
    async _handleProtooRequest(peer: Peer, request: ProtooRequest, accept: AcceptFn, reject: RejectFn) {
        if (
            !peer.data._cgAuth &&
            !(request.method === 'getSignableSecret' || request.method === 'login')
        ) {
            throw new Error(errors.server.LOGIN_REQUIRED);
        }

        switch (request.method) {
            case 'getSignableSecret':
                {
                    const secret = realRandomHexString(32);
                    peer.data._cgSecret = secret;
                    accept(secret);

                    break;
                }

            case 'login':
                {
                    const signableSecret = peer.data._cgSecret as string | undefined;
                    let data: API.Socket.login.Request = request.data;
                    data = await validators.API.Socket.login.validateAsync(data);
                    if (!!signableSecret && signableSecret === data.secret) {
                        const { userId } = await deviceHelper.verifyDeviceAndGetUserId(data.deviceId, signableSecret, data.base64Signature);
                        delete peer.data._cgSecret;
                        if (peer.id !== userId) {
                            accept("ERROR");
                            return;
                        }
                        peer.data._cgAuth = true;
                        accept("OK");

                    } else {
                        accept("ERROR");
                    }

                    break;
                }

            case 'getRouterRtpCapabilities':
                {
                    accept(this._mediasoupRouter.rtpCapabilities);

                    break;
                }

            case 'join':
                {
                    // Ensure the Peer is not already joined.
                    if (peer.data.joined)
                        throw new Error('Peer already joined');

                    await this.hasJoinPermissions(peer.id);

                    let shouldPromoteBroadcaster: boolean = false;
                    if (this._callType === CallType.BROADCAST) {
                        if (peer.id === this._callCreator) {
                            if (this._broadCasters.get(peer.id) === undefined) {
                                try {
                                    this.addBroadcaster(peer.id, peer.id); // for when creator leaves and join back
                                    shouldPromoteBroadcaster = true;
                                } catch (error) {
                                    logger.info('broadcasters limit exceeded');    
                                }
                            }
                        } else {
                            const peerLength = this._getJoinedPeers(peer).length;
                            if (peerLength === 0) {
                                try {
                                    await this.hasModeratePermissions(peer.id);
                                    this._broadCasters.set(peer.id, peer.id); // for when creator leaves and join back
                                    shouldPromoteBroadcaster = true;
                                } catch (error) {
                                    //user has joined broadcast alone but is not moderator/creator
                                    logger.warn(error);
                                }
                            }
                        }
                    }

                    const {
                        displayName,
                        device,
                        rtpCapabilities
                    } = request.data;

                    // Store client data into the protoo Peer data object.
                    peer.data.joined = true;
                    peer.data.displayName = displayName;
                    peer.data.device = device;
                    peer.data.rtpCapabilities = rtpCapabilities;
                    // Tell the new Peer about already joined Peers.
                    // And also create Consumers for existing Producers.

                    const joinedPeers =
                        [
                            ...this._getJoinedPeers()
                        ];

                    // Reply now the request with the list of joined peers (all but the new one).
                    const peerInfos = joinedPeers
                        .filter((joinedPeer) => joinedPeer.id !== peer.id)
                        .map((joinedPeer) => ({
                            id: joinedPeer.id,
                            displayName: joinedPeer.data.displayName,
                            device: joinedPeer.data.device
                        }));

                    accept({ peers: peerInfos, broadcasters: Array.from(this._broadCasters.keys()), handsRaised: Array.from(this._handsRaised.keys()) });

                    // Mark the new Peer as joined.
                    peer.data.joined = true;

                    for (const joinedPeer of joinedPeers) {
                        // Create Consumers for existing Producers.
                        for (const producer of joinedPeer.data.producers.values()) {
                            logger.debug('createConsumer %s for producer %o', peer.id, producer.id);
                            this._createConsumer(
                                {
                                    consumerPeer: peer,
                                    producerPeer: joinedPeer,
                                    producer
                                });
                        }
                    }

                    // Notify the new Peer to all other Peers.
                    for (const otherPeer of this._getJoinedPeers(peer)) {
                        logger.debug('newPeer: %o', otherPeer.id);
                        otherPeer.notify(
                            'newPeer',
                            {
                                id: peer.id,
                                displayName: peer.data.displayName,
                                device: peer.data.device
                            }).then(() => {
                                if (this._callType === CallType.BROADCAST) {
                                    if (peer.id === this._callCreator) {
                                        otherPeer.notify('promotedBroadcaster', { peerId: peer.id });
                                    }
                                }
                            })
                            .catch((error) => {
                                logger.error(error)
                            });
                    }

                    //add peer to db table callmembers
                    peer.data.membershipId = (await callHelper.insertCallMember(this._roomId, peer.id)).membershipId;
                    //add previewId to db table call
                    await callHelper.updateCallPreviewIds(this._roomId, this._getJoinedPeers().map(peer => peer.id));
                    if(shouldPromoteBroadcaster){
                        peer.notify('promotedBroadcaster', { peerId: peer.id });
                    }

                    break;
                }

            case 'createWebRtcTransport':
                {
                    // NOTE: Don't require that the Peer is joined here, so the client can
                    // initiate mediasoup Transports and be ready when he later joins.é sex

                    const {
                        forceTcp,
                        producing,
                        consuming,
                    } = request.data;

                    const webRtcTransportOptions =
                    {
                        ...mediasoupConfig.webRtcTransportOptions,
                        appData: { producing, consuming }
                    };

                    if  (this._highQuality) {
                        webRtcTransportOptions.initialAvailableOutgoingBitrate = 10000000;
                    }

                    if (forceTcp) {
                        webRtcTransportOptions.enableUdp = false;
                        webRtcTransportOptions.enableTcp = true;
                    }

                    const transport = await this._mediasoupRouter.createWebRtcTransport(
                        {
                            webRtcServer: this._webRtcServer,
                            ...webRtcTransportOptions as any
                        });

                    transport.on('dtlsstatechange', (dtlsState) => {
                        if (dtlsState === 'failed' || dtlsState === 'closed')
                            logger.error('WebRtcTransport "dtlsstatechange" event [dtlsState:%s]', dtlsState);
                    });

                    await transport.enableTraceEvent(['bwe']);

                    transport.on('trace', (trace) => {
                        logger.debug(
                            'transport "trace" event [transportId:%s, trace.type:%s, trace:%o]',
                            transport.id, trace.type, trace);

                        if (trace.type === 'bwe' && trace.direction === 'out') {
                            peer.notify(
                                'downlinkBwe',
                                {
                                    desiredBitrate: trace.info.desiredBitrate,
                                    effectiveDesiredBitrate: trace.info.effectiveDesiredBitrate,
                                    availableBitrate: trace.info.availableBitrate
                                })
                                .catch((error) => {
                                    logger.error(error)
                                });
                        }
                    });

                    // Store the WebRtcTransport into the protoo Peer data Object.
                    peer.data.transports.set(transport.id, transport);
                    logger.debug('createWebRtcTransport: %o', transport);

                    accept(
                        {
                            id: transport.id,
                            iceParameters: transport.iceParameters,
                            iceCandidates: transport.iceCandidates,
                            dtlsParameters: transport.dtlsParameters
                        });

                    break;
                }

            case 'connectWebRtcTransport':
                {
                    const { transportId, dtlsParameters } = request.data;
                    const transport: WebRtcTransport = peer.data.transports.get(transportId);

                    if (!transport)
                        throw new Error(`transport with id "${transportId}" not found`);

                    await transport.connect({ dtlsParameters });
                    logger.debug('connectWebRtcTransport: %o', transport);

                    accept({success : true});

                    break;
                }

            case 'restartIce':
                {
                    const { transportId } = request.data;
                    const transport = peer.data.transports.get(transportId);

                    if (!transport)
                        throw new Error(`transport with id "${transportId}" not found`);

                    const iceParameters = await transport.restartIce();

                    accept(iceParameters);

                    break;
                }

            case 'produce':
                {
                    // Ensure the Peer is joined.
                    if (!peer.data.joined)
                        throw new Error('Peer not yet joined');

                    const { transportId, kind, rtpParameters } = request.data;
                    let { appData } = request.data;
                    const transport = peer.data.transports.get(transportId);

                    if (this._callType === CallType.BROADCAST) {
                        // check whether the peer is broadcaster
                        if (!this._broadCasters.get(peer.id)) {
                            throw new Error(errors.server.BROADCASTERS_LIMIT_EXCEEDED);
                        }
                    }

                    if (!transport)
                        throw new Error(`transport with id "${transportId}" not found`);

                    // Add peerId into appData to later get the associated Peer during
                    // the 'loudest' event of the audioLevelObserver.
                    appData = { ...appData, peerId: peer.id };
                    logger.debug(
                        'produce called [transportId:%s, kind:%s, rtpParameters:%o, appData:%o]',
                        transportId, kind, rtpParameters, appData);

                    const producer: Producer = await transport.produce(
                        {
                            kind,
                            rtpParameters,
                            appData
                            // keyFrameRequestDelay: 5000
                        });

                    // Store the Producer into the protoo Peer data Object.
                    peer.data.producers.set(producer.id, producer);

                    // Set Producer events.
                    producer.on('score', (score: any) => {
                        logger.debug(
                            'producer "score" event [producerId:%s, score:%o]',
                            producer.id, score);

                        peer.notify('producerScore', { producerId: producer.id, score })
                            .catch((error) => {
                                logger.error(error)
                            });
                    });

                    // NOTE: For testing.
                    // await producer.enableTraceEvent([ 'rtp', 'keyframe', 'nack', 'pli', 'fir' ]);
                    // await producer.enableTraceEvent([ 'pli', 'fir' ]);
                    // await producer.enableTraceEvent([ 'keyframe' ]);

                    producer.on('trace', (trace: any) => {
                        logger.debug(
                            'producer "trace" event [producerId:%s, trace.type:%s, trace:%o]',
                            producer.id, trace.type, trace);
                    });

                    accept({ id: producer.id });

                    const otherPeers = this._getJoinedPeers(peer);
                    // Optimization: Create a server-side Consumer for each Peer.
                    for (const otherPeer of otherPeers) {
                        logger.debug('_createConsumer:from %o, to %o', otherPeer.id, peer.id);
                        this._createConsumer(
                            {
                                consumerPeer: otherPeer,
                                producerPeer: peer,
                                producer
                            });
                    }

                    // Add into the AudioLevelObserver and ActiveSpeakerObserver.
                    if (producer.kind === 'audio') {
                        logger.debug('_audioLevelObserver.addProducer():%s', producer.id);
                        this._audioLevelObserver.addProducer({ producerId: producer.id })
                            .catch((error: any) => {
                                logger.error(error);
                            });
                        logger.debug('_activeSpeakerObserver.addProducer():%s', producer.id);

                        this._activeSpeakerObserver.addProducer({ producerId: producer.id })
                            .catch((error: any) => {
                                logger.error(error);
                            });
                    }

                    break;
                }

            case 'closeProducer':
                {
                    // Ensure the Peer is joined.
                    if (!peer.data.joined)
                        throw new Error('Peer not yet joined');

                    const { producerId } = request.data;
                    const producer = peer.data.producers.get(producerId);

                    if (!producer)
                        throw new Error(`producer with id "${producerId}" not found`);

                    producer.close();

                    // Remove from its map.
                    peer.data.producers.delete(producer.id);
                    logger.debug('closeProducer():%o', producer);

                    accept({success : true});

                    break;
                }

            case 'pauseProducer':
                {
                    // Ensure the Peer is joined.
                    if (!peer.data.joined)
                        throw new Error('Peer not yet joined');

                    const { producerId } = request.data;
                    const producer = peer.data.producers.get(producerId);

                    if (!producer)
                        throw new Error(`producer with id "${producerId}" not found`);

                    await producer.pause();
                    logger.debug('pauseProducer():%o', producer);
                    accept({success : true});

                    break;
                }

            case 'resumeProducer':
                {
                    // Ensure the Peer is joined.
                    if (!peer.data.joined)
                        throw new Error('Peer not yet joined');

                    const { producerId } = request.data;
                    const producer = peer.data.producers.get(producerId);

                    if (!producer)
                        throw new Error(`producer with id "${producerId}" not found`);

                    await producer.resume();
                    logger.debug('resumeProducer():%o', producer);

                    accept({success : true});

                    break;
                }

            case 'pauseConsumer':
                {
                    // Ensure the Peer is joined.
                    if (!peer.data.joined)
                        throw new Error('Peer not yet joined');

                    const { consumerId } = request.data;
                    const consumer = peer.data.consumers.get(consumerId);

                    if (!consumer)
                        throw new Error(`consumer with id "${consumerId}" not found`);

                    await consumer.pause();
                    logger.debug('pauseConsumer():%o', consumer);

                    accept({success : true});

                    break;
                }

            case 'resumeConsumer':
                {
                    // Ensure the Peer is joined.
                    if (!peer.data.joined)
                        throw new Error('Peer not yet joined');

                    const { consumerId } = request.data;
                    const consumer = peer.data.consumers.get(consumerId);

                    if (!consumer)
                        throw new Error(`consumer with id "${consumerId}" not found`);

                    await consumer.resume();
                    logger.debug('resumeConsumer():%o', consumer);

                    accept({success : true});

                    break;
                }

            case 'setConsumerPreferredLayers':
                {
                    // Ensure the Peer is joined.
                    if (!peer.data.joined)
                        throw new Error('Peer not yet joined');

                    const { consumerId, spatialLayer, temporalLayer } = request.data;
                    const consumer = peer.data.consumers.get(consumerId);

                    if (!consumer)
                        throw new Error(`consumer with id "${consumerId}" not found`);

                    await consumer.setPreferredLayers({ spatialLayer, temporalLayer });

                    accept({success : true});

                    break;
                }

            case 'setConsumerPriority':
                {
                    // Ensure the Peer is joined.
                    if (!peer.data.joined)
                        throw new Error('Peer not yet joined');

                    const { consumerId, priority } = request.data;
                    const consumer = peer.data.consumers.get(consumerId);

                    if (!consumer)
                        throw new Error(`consumer with id "${consumerId}" not found`);

                    await consumer.setPriority(priority);
                    logger.debug('setConsumerPriority():', priority);

                    accept({success : true});

                    break;
                }

            case 'promoteBroadcaster':
                {
                    const { promotedPeerId } = request.data;

                    if (!peer.data.joined)
                        throw new Error('Peer not yet joined');
                    // Ensure the peer is callCreator
                    await this.hasModeratePermissions(peer.id);

                    try {
                        this.addBroadcaster(promotedPeerId, promotedPeerId);
                    } catch (error: any) {
                        reject(403, errors.server.BROADCASTERS_LIMIT_EXCEEDED);
                        break;
                    }

                    this._handsRaised.delete(promotedPeerId);
                    const allPeers = this._getJoinedPeers(peer);
                    if (promotedPeerId === peer.id) { //i.e I as moderator promote myself
                        await peer.notify('promotedBroadcaster', { peerId: promotedPeerId });
                        await peer.notify('loweredHand', { peerId: promotedPeerId });
                    }
                    for (const otherPeer of allPeers) {
                        await otherPeer.notify('promotedBroadcaster', { peerId: promotedPeerId });
                        await otherPeer.notify('loweredHand', { peerId: promotedPeerId });
                    }
                    accept({success : true});
                    break;
                }
                case 'demoteBroadcaster':
                    {
                        const { demotedPeerId } = request.data;

                        if (!peer.data.joined)
                            throw new Error('Peer not yet joined');
                        // Ensure the peer is callCreator
                        await this.hasModeratePermissions(peer.id);

                        this._broadCasters.delete(demotedPeerId);
                        const allPeers = this._getJoinedPeers(peer);
                        if (demotedPeerId === peer.id) {
                            await peer.notify('demotedBroadcaster', { peerId: demotedPeerId });
                        }
                        for (const otherPeer of allPeers) {
                            await otherPeer.notify('demotedBroadcaster', { peerId: demotedPeerId });
                        }
                        accept({success : true});
                        break;
                }

            case 'endCallForEveryone':
                {
                    if (!peer.data.joined)
                        throw new Error('Peer not yet joined');
                    // Ensure the peer has permissions to end the call
                    await this.hasModeratePermissions(peer.id);

                    for (const peerToClose of this._getJoinedPeers()) {
                        await peerToClose.notify('callEnded');
                    }

                    accept({success : true});
                    this.close({ force: true });
                    break;
                }

            case 'raiseHand':
                {
                    const { peerId } = request.data;

                    if (!peer.data.joined)
                        throw new Error('Peer not yet joined');

                    this._handsRaised.set(peerId, peerId);

                    const allPeers = this._getJoinedPeers(peer);
                    for (const otherPeer of allPeers) {
                        await otherPeer.notify('raisedHand', { peerId: peerId });
                    }
                    accept({success : true});
                    break;
                }

            case 'lowerHand':
                {
                    const { peerId } = request.data;

                    if (!peer.data.joined)
                        throw new Error('Peer not yet joined');

                    this._handsRaised.delete(peerId);

                    const allPeers = this._getJoinedPeers(peer);
                    for (const otherPeer of allPeers) {
                        await otherPeer.notify('loweredHand', { peerId: peerId });
                    }
                    accept({success : true});
                    break;
                }

            case 'moderationMute': {
                const { mutedPeerId } = request.data;

                await this.hasModeratePermissions(peer.id);

                if (mutedPeerId === peer.id) {
                    throw new Error('Cannot mute yourself with moderation tools');
                }

                if (!peer.data.joined) {
                    throw new Error('Peer not yet joined');
                }

                this._getJoinedPeers().forEach(async (otherPeer) => {
                    if (otherPeer.id === mutedPeerId) {
                        otherPeer.data.producers.forEach(async (producer: Producer) => {
                            if (producer.kind === 'audio') {
                                await producer.pause();
                            }
                        });
                        otherPeer.notify('moderationMuted');
                    }
                });
                accept({success : true});
                break;
            }

            case "peerReaction": {
                const { peerId, reaction } = request.data;

                if (!peer.data.joined) {
                    throw new Error('Peer not yet joined');
                }

                if (peer.data.reactionBlacklist.has(reaction)) {
                    //just ignore, no need to notify
                    accept({success : true});
                    break;
                } else {
                    this._getJoinedPeers().forEach(async (otherPeer) => {
                        await otherPeer.notify('reactionReceived', { peerId, reaction });
                    });
                    peer.data.reactionBlacklist.add(reaction);
                    //remove reaction after 200ms
                    setTimeout(() => {
                        peer.data.reactionBlacklist.delete(reaction);
                    }, 200);
                }
                //

                accept({success : true});
                break;
            }

            default:
                {
                    logger.error('unknown request.method "%s"', request.method);

                    reject(500, `unknown request.method "${request.method}"`);
                }
        }
    }

    /**
     * Helper to get the list of joined protoo peers.
     */
    _getJoinedPeers(excludePeer?: Peer) {
        return this._protooRoom.peers
            .filter((peer) => peer.data.joined && peer !== excludePeer);
    }

    /**
     * Creates a mediasoup Consumer for the given mediasoup Producer.
     *
     * @async
     */
    async _createConsumer({ consumerPeer, producerPeer, producer }: { consumerPeer: any, producerPeer: any, producer: Producer }) {
        // Optimization:
        // - Create the server-side Consumer in paused mode.
        // - Tell its Peer about it and wait for its response.
        // - Upon receipt of the response, resume the server-side Consumer.
        // - If video, this will mean a single key frame requested by the
        //   server-side Consumer (when resuming it).
        // - If audio (or video), it will avoid that RTP packets are received by the
        //   remote endpoint *before* the Consumer is locally created in the endpoint
        //   (and before the local SDP O/A procedure ends). If that happens (RTP
        //   packets are received before the SDP O/A is done) the PeerConnection may
        //   fail to associate the RTP stream.

        // NOTE: Don't create the Consumer if the remote Peer cannot consume it.
        if (
            !consumerPeer.data.rtpCapabilities ||
            !this._mediasoupRouter.canConsume(
                {
                    producerId: producer.id,
                    rtpCapabilities: consumerPeer.data.rtpCapabilities
                })
        ) {
            return;
        }

        // Must take the Transport the remote Peer is using for consuming.
        const transport: any = Array.from(consumerPeer.data.transports.values())
            .find((t: any) => t.appData.consuming);

        // This should not happen.
        if (!transport) {
            logger.error('_createConsumer() | Transport for consuming not found');

            return;
        }

        const promises: Promise<void>[] = [];

        const consumerCount = 1 + this._consumerReplicas;

        for (let i = 0; i < consumerCount; i++) {
            promises.push(
                (async () => {
                    // Create the Consumer in paused mode.
                    let consumer: Consumer;

                    try {
                        consumer = await transport.consume(
                            {
                                producerId: producer.id,
                                rtpCapabilities: consumerPeer.data.rtpCapabilities,
                                // Enable NACK for OPUS.
                                enableRtx: true,
                                paused: true
                            });
                    }
                    catch (error) {
                        logger.error('_createConsumer() | transport.consume():%o', error);

                        return;
                    }
                    logger.debug('_createConsumer() | createdConsumer():%o', consumer);

                    // Store the Consumer into the protoo consumerPeer data Object.
                    consumerPeer.data.consumers.set(consumer.id, consumer);

                    // Set Consumer events.
                    consumer.on('transportclose', () => {
                        // Remove from its map.
                        consumerPeer.data.consumers.delete(consumer.id);
                    });

                    consumer.on('producerclose', () => {
                        // Remove from its map.
                        consumerPeer.data.consumers.delete(consumer.id);

                        consumerPeer.notify('consumerClosed', { consumerId: consumer.id })
                            .catch(() => { });
                    });

                    consumer.on('producerpause', () => {
                        consumerPeer.notify('consumerPaused', { consumerId: consumer.id })
                            .catch(() => { });
                    });

                    consumer.on('producerresume', () => {
                        consumerPeer.notify('consumerResumed', { consumerId: consumer.id })
                            .catch(() => { });
                    });

                    consumer.on('score', (score) => {
                        logger.debug(
                            'consumer "score" event [consumerId:%s, score:%o]',
                            consumer.id, score);

                        consumerPeer.notify('consumerScore', { consumerId: consumer.id, score })
                            .catch(() => { });
                    });

                    consumer.on('layerschange', (layers) => {
                        consumerPeer.notify(
                            'consumerLayersChanged',
                            {
                                consumerId: consumer.id,
                                spatialLayer: layers ? layers.spatialLayer : null,
                                temporalLayer: layers ? layers.temporalLayer : null
                            })
                            .catch(() => { });
                    });

                    consumer.on('trace', (trace) => {
                        logger.debug(
                            'consumer "trace" event [producerId:%s, trace.type:%s, trace:%o]',
                            consumer.id, trace.type, trace);
                    });

                    // Send a protoo request to the remote Peer with Consumer parameters.
                    try {
                        await consumerPeer.request(
                            'newConsumer',
                            {
                                peerId: producerPeer.id,
                                producerId: producer.id,
                                id: consumer.id,
                                kind: consumer.kind,
                                rtpParameters: consumer.rtpParameters,
                                type: consumer.type,
                                appData: producer.appData,
                                producerPaused: consumer.producerPaused
                            });
                        logger.debug('_createConsumer() | newConsumer()');

                        // Now that we got the positive response from the remote endpoint, resume
                        // the Consumer so the remote endpoint will receive the a first RTP packet
                        // of this new stream once its PeerConnection is already ready to process
                        // and associate it.
                        await consumer.resume();

                        consumerPeer.notify(
                            'consumerScore',
                            {
                                consumerId: consumer.id,
                                score: consumer.score
                            })
                            .catch(() => { });
                    }
                    catch (error) {
                        logger.error('_createConsumer() | failed:%o', error);
                    }
                })()
            );
        }

        try {
            await Promise.all(promises);
        }
        catch (error) {
            logger.error('_createConsumer() | failed:%o', error);
        }
    }

    private async hasModeratePermissions(peerId: string) {
        if (peerId !== this._callCreator) {
            const hasPermission = await callHelper.hasPermissionToModerateCall(peerId, this._roomId);
            if (!hasPermission) {
                throw new Error(errors.server.NOT_ALLOWED);
            }
        }
    }

    private async hasJoinPermissions(peerId: string) {
        if (peerId !== this._callCreator) {
            const hasPermission = await callHelper.hasPermissionToJoinCall(peerId, this._roomId);
            if (!hasPermission) {
                throw new Error(errors.server.NOT_ALLOWED);
            }
        }
    }

    public handleCallUpdate(event: Events.PgNotify.CallServerCallUpdate) {
        this._slots = event.slots;
        this._stageSlots = event.stageSlots;
        this._audioOnly = event.audioOnly;
        this._highQuality = event.highQuality;
        const peers = this._getJoinedPeers();
        for (const peer of peers) {
            peer.notify('callUpdate', { slots: this._slots, stageSlots: this._stageSlots, audioOnly: this._audioOnly, highQuality: this._highQuality });
        }
    }
}

module.exports = Room;
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import fs from 'fs';
import https from 'https';
import protoo from 'protoo-server';
import express from "express";
import bodyParser from 'body-parser';
import url from 'url';
import cors from 'cors';
import { AwaitQueue } from 'awaitqueue';
import { createWorker } from "mediasoup";

import { httpsConf, mediasoupConfig } from "./mediasoup/config";
import { clone } from "./mediasoup/utils";
import { TransportListenIp } from 'mediasoup/node/lib/Transport';
import Room from "./mediasoup/room";
import * as types from "mediasoup/node/lib/types";
import { fakeHealthcheck } from './mediasoup/mediasoupHealthcheck';
import callHelper from './repositories/calls';
import { CallType } from './common/enums';
import { exec } from 'child_process';
import config from './common/config';
import errors from './common/errors';
import pool from './util/postgres';
import format from 'pg-format';
import { type PoolClient } from 'pg';

const rooms: Map<string, Room> = new Map();
const mediasoupWorkers: Array<types.Worker> = [];
const queue: AwaitQueue = new AwaitQueue();
let webServer: https.Server;
let protooWebSocketServer: protoo.WebSocketServer;
let expressApp: express.Express;
let nextMediasoupWorkerIdx = 0;

let domain = process.env.DOMAIN as string;
if (!domain) {
    throw new Error("process.env.DOMAIN has to be set to the server url");
}

let pgClient: PoolClient | null = null;
async function registerCallUpdateListener(listener: (event: Events.PgNotify.CallServerCallUpdate) => void) {
    if (!pgClient) {
        pgClient = await pool.connect();
    }
    else {
        throw new Error("Listener already registered");
    }
    
    const idResult = await pool.query<{id: string}>(format('SELECT id FROM callservers WHERE url = %L', domain));
    if (idResult.rows.length !== 1) {
        throw new Error("Could not find call server id");
    }
    const callServerId = idResult.rows[0].id;
    const eventName = `callservercallupdate_${callServerId.replace(/-/g, '_')}`;
    pgClient.query(`LISTEN "${eventName}"`);

    // Keepalive
    let interval: any = undefined;
    interval = setInterval(async () => {
        try {
            await pgClient!.query('SELECT 1');
        }
        catch (e) {
            console.log("KEEPALIVE ERROR", e);
            clearInterval(interval);
            process.exit(1);
        }
    }, 60000);

    pgClient.on("notification", (msg) => {
        if (!!msg.payload) {
          try {
            const payload: Events.PgNotify.CallServerCallUpdate = JSON.parse(msg.payload);
            if (payload.type === eventName) {
                listener(payload);
            }
            else {
              console.warn("WARN: Unknown change event type:", payload);
            }
          }
          catch (e) {
            console.trace(e);
          }
        }
    });
}

let lastReceived = 0;
let lastSent = 0;
async function getTrafficSinceLastCall(): Promise<{
    received: number;
    sent: number;
}> {
    return new Promise((resolve, reject) => {
        exec('/usr/bin/tail -1 /proc/net/dev', (err, stdout, stderr) => {
            if (err) {
                reject(err);
            }
            else {
                const parts = stdout.trim().split(/\s+/);
                const allReceived = Number(parts[1]);
                const allSent = Number(parts[9]);
                if (!Number.isNaN(allReceived) && !Number.isNaN(allSent)) {
                    const received = allReceived - lastReceived;
                    lastReceived = allReceived;
                    const sent = allSent - lastSent;
                    lastSent = allSent;
                    resolve({ received, sent });
                }
                else {
                    reject(new Error('Could not parse /proc/net/dev'));
                }
            }
        });
    });
}
let traffic = 0;
setInterval(async () => {
    const result = await getTrafficSinceLastCall();
    traffic = result.received + result.sent;
}, config.CALLSERVER_UPDATE_TRAFFIC_INTERVAL);

(async () => {
    try {
        await runExpressApp();
        await runWebServer();
        await runProtooWebSocketServer();
        await runMediasoupWorkers();
        fakeHealthcheck();
        await updateServerStatus();

        // clear database state
        await callHelper.resetCallServer(domain, false);
        await registerCallUpdateListener((event: Events.PgNotify.CallServerCallUpdate) => {
            // Todo: handle call update
            // It should not happen that events for stale calls are received, but still make sure that
            // state updates for unknown calls are ignored, but logged
            const room = rooms.get(event.callId);
            if (room) {
                room.handleCallUpdate(event);
            }
        });

    } catch (err) {
        console.error(err);
    }
})();

let updateServerStatusHandlerInterval: any = null;
async function updateServerStatus() {
    //update server each second
    if (updateServerStatusHandlerInterval !== null) {
        clearInterval(updateServerStatusHandlerInterval);
    }
    const handler = async () => {
        try {
            await callHelper.upsertCallServer({
                ongoingCalls: rooms.size,
                traffic,
            }, domain, false);
        }
        catch (e) {
            console.error("Error updating server status", e);
            exitProcess(1);
        }
    };
    updateServerStatusHandlerInterval = setInterval(handler, config.CALLSERVER_UPDATE_DATA_INTERVAL);
    await handler();
}

async function runMediasoupWorkers() {
    const { numWorkers } = mediasoupConfig;

    console.info('running %d mediasoup Workers...', numWorkers);

    for (let i = 0; i < numWorkers; ++i) {
        const worker = await createWorker(
            {
                logLevel: mediasoupConfig.workerSettings.logLevel,
                logTags: mediasoupConfig.workerSettings.logTags,
                rtcMinPort: Number(mediasoupConfig.workerSettings.rtcMinPort),
                rtcMaxPort: Number(mediasoupConfig.workerSettings.rtcMaxPort),
                disableLiburing: mediasoupConfig.workerSettings.disableLiburing,
            });

        worker.on('died', () => {
            console.error(
                'mediasoup Worker died, exiting  in 2 seconds... [pid:%d]', worker.pid);

            setTimeout(() => process.exit(1), 2000);
        });

        mediasoupWorkers.push(worker);

        // Create a WebRtcServer in this Worker.
        if (process.env.MEDIASOUP_USE_WEBRTC_SERVER !== 'false') {
            // Each mediasoup Worker will run its own WebRtcServer, so those cannot
            // share the same listening ports. Hence we increase the value in config.js
            // for each Worker.
            const webRtcServerOptions = clone(mediasoupConfig.webRtcServerOptions);
            const portIncrement = mediasoupWorkers.length - 1;

            for (const listenInfo of webRtcServerOptions.listenInfos) {
                if (listenInfo.port) {
                    listenInfo.port += portIncrement;
                }
            }

            const webRtcServer = await worker.createWebRtcServer(webRtcServerOptions);

            worker.appData.webRtcServer = webRtcServer;
        }
    }
}

async function runWebServer(): Promise<void> {
    const { key, cert } = httpsConf.tls;
    if (!fs.existsSync(key) || !fs.existsSync(cert)) {
        console.error('SSL files are not found. check your config.js file');
        process.exit(0);
    }
    const tls = {
        cert: fs.readFileSync(cert),
        key: fs.readFileSync(key),
    };
    webServer = https.createServer(tls, expressApp);
    webServer.on('error', (err) => {
        console.error('starting web server failed:', err.message);
    });

    await new Promise<void>((resolve) => {
        const { listenIp, listenPort } = httpsConf;
        webServer.listen(listenPort, listenIp, () => {
            if (mediasoupConfig?.webRtcTransportOptions?.listenIps?.[0]) {
                const listenIps: TransportListenIp = mediasoupConfig.webRtcTransportOptions.listenIps[0] as TransportListenIp;
                const ip = listenIps.announcedIp || listenIps.ip;
                console.log('server is running');
                console.log(`open https://${ip}:${listenPort} in your web browser`);
            }
            resolve();
        });
    });
}

async function runExpressApp() {
    console.info('creating Express app...');
    expressApp = express();
    expressApp.use(bodyParser.json());

    /**
     * For every API request, verify that the roomId in the path matches and
     * existing room.
     */
    expressApp.param(
        'roomId', (req: any, res: any, next, roomId: string) => {
            // The room must exist for all API requests.
            if (!rooms.has(roomId)) {
                const error: any = new Error(`room with id "${roomId}" not found`);

                error.status = 404;
                throw error;
            }

            req.room = rooms.get(roomId);

            next();
        });
    expressApp.get(
        '/rooms/:roomId', (req: any, res: any) => {
            const data = req.room.getRouterRtpCapabilities();

            res.status(200).json(data);
        });


    expressApp.use(cors());

    expressApp.use(
        (error: any, req: any, res: any, next: any) => {
            if (error) {
                console.error('Express app %s', String(error));

                error.status = error.status || (error.name === 'TypeError' ? 400 : 500);

                res.statusMessage = error.message;
                res.status(error.status).send(String(error));
            }
            else {
                next();
            }
        });


    expressApp.get('/hello', (req, res) => {
        res.send('Hello World!');
    });
}

async function runProtooWebSocketServer() {
    console.info('running protoo WebSocketServer...');

    // Create the protoo WebSocket server.
    protooWebSocketServer = new protoo.WebSocketServer(webServer,
        {
            maxReceivedFrameSize: 960000, // 960 KBytes.
            maxReceivedMessageSize: 960000,
            fragmentOutgoingMessages: true,
            fragmentationThreshold: 960000
        });

    // Handle connections from clients.
    protooWebSocketServer.on('connectionrequest', (info: any, accept, reject) => {
        // The client indicates the roomId and peerId in the URL query.
        const u = url.parse(info.request.url, true);
        const roomId: string = u.query['roomId'] as string;
        const peerId: string = u.query['peerId'] as string;
        const callType: CallType = u.query['callType'] as CallType;

        if (!roomId || !peerId) {
            reject(400, 'Connection request without roomId and/or peerId');

            return;
        }

        let consumerReplicas = Number(u.query['consumerReplicas']);

        if (isNaN(consumerReplicas)) {
            consumerReplicas = 0;
        }

        console.info(
            'protoo connection request [roomId:%s, peerId:%s, address:%s, origin:%s]',
            roomId, peerId, info.socket.remoteAddress, info.origin);

        // Serialize this code into the queue to avoid that two peers connecting at
        // the same time with the same roomId create two separate rooms with same
        // roomId.
        queue.push(async () => {
            const existingCall = await callHelper.getCallState(roomId);
            let { callCreator, callSlots, stageSlots, audioOnly, highQuality } = initializeCallParameters(peerId, callType, existingCall);
            const room = await getOrCreateRoom({ roomId, consumerReplicas, callType, callCreator, callSlots, stageSlots, audioOnly, highQuality });

            // Accept the protoo WebSocket connection.
            const protooWebSocketTransport = accept();
            const consume = true;

            await room.handleProtooConnection({ peerId, consume, protooWebSocketTransport });
        })
            .catch((error: any) => {
                console.error('room creation or room joining failed:%o', error);

                reject(error);
            });
    });
}

function initializeCallParameters(
    peerId: string, 
    callType: CallType,
    existingCall?: {
        callCreator: string, 
        slots: number, 
        stageSlots: number, 
        audioOnly: boolean, 
        highQuality: boolean, 
    }
) {
    let callCreator;
    let callSlots;
    let stageSlots;
    let audioOnly = false;
    let highQuality = false;
    if (existingCall) {
        callCreator = existingCall.callCreator;
        callSlots = existingCall.slots;
        stageSlots = existingCall.stageSlots;
        audioOnly = existingCall.audioOnly;
        highQuality = existingCall.highQuality;
    } else {
        callCreator = peerId;
        switch (callType) {
            case CallType.BROADCAST:
                stageSlots = config.PREMIUM.COMMUNITY_FREE.BROADCASTERS_SLOTS;
                callSlots = config.PREMIUM.COMMUNITY_FREE.BROADCAST_STANDARD;
                break;
            case CallType.DEFAULT:
                stageSlots = config.PREMIUM.COMMUNITY_FREE.BROADCASTERS_SLOTS;
                callSlots = config.PREMIUM.COMMUNITY_FREE.CALL_STANDARD;
                break;

            default:
                stageSlots = config.PREMIUM.COMMUNITY_FREE.BROADCASTERS_SLOTS;
                callSlots = config.PREMIUM.COMMUNITY_FREE.CALL_STANDARD;
                break;
        }
    }
    return { callCreator, callSlots, stageSlots, audioOnly, highQuality };
}

/**
 * Get next mediasoup Worker.
 */
function getMediasoupWorker() {
    const worker = mediasoupWorkers[nextMediasoupWorkerIdx];

    if (++nextMediasoupWorkerIdx === mediasoupWorkers.length)
        nextMediasoupWorkerIdx = 0;

    return worker;
}

/**
 * Get a Room instance (or create one if it does not exist).
 */
async function getOrCreateRoom({ 
        roomId, 
        consumerReplicas, 
        callType, 
        callCreator, 
        stageSlots, 
        callSlots, 
        audioOnly, 
        highQuality 
    }: { 
        roomId: string, 
        consumerReplicas: number, 
        callType: CallType, 
        callCreator?: string, 
        stageSlots: number, 
        callSlots: number, 
        audioOnly: boolean, 
        highQuality: boolean 
    }) {
    let room = rooms.get(roomId);
    
    const peerLenght = room ? room._getJoinedPeers().length : 0;

    if (peerLenght >= callSlots) {
        throw new Error(errors.server.CALL_LIMIT_EXCEEDED);
    }

    // If the Room does not exist create a new one.
    if (!room) {
        if (!callCreator) {
            throw new Error('Call creator not found');
        }

        console.info('creating a new Room [roomId:%s]', roomId);

        const mediasoupWorker = getMediasoupWorker();
        room = await Room.create({ mediasoupWorker, roomId, consumerReplicas, callType, callCreator, stageSlots, callSlots, audioOnly, highQuality });

        rooms.set(roomId, room);
        room.on('close', () => {
            callHelper.softEndCall(roomId);
            rooms.delete(roomId);
        });
        room.on('forceClose', () => {
            callHelper.endCallForEveryone(roomId);
            rooms.delete(roomId);
        });
    }
    
    const callState = await callHelper.getCallState(roomId);
    if (callState.endedAt) {
        rooms.delete(roomId);
        throw new Error('Call has already ended');
    }

    return room;
}

let isExiting = false;
const exitProcess = async (code = 0) => {
    if (!isExiting) {
        isExiting = true;
        console.log('Received SIGTERM signal. Cleaning up...');
        
        try {
            await callHelper.resetCallServer(domain, true);
        }
        catch (e) {
            console.error("Error resetting call server", e);
        }
        protooWebSocketServer.stop();

        // db state has been cleared, now we can set a timeout
        // for a hard exit
        console.log('DB state updated, setting timeout for hard exit (5000)...');
        setTimeout(() => {
            process.exit(1);
        }, 5000);

        console.log("Trying to close rooms...");
        await Promise.allSettled(
            Array.from(rooms.values()).map(async (r) => { await r.close() })
        );

        console.log("Rooms closed, trying to close mediasoup workers...");
        await Promise.allSettled(
            mediasoupWorkers.map(async (w) => { await w.close() })
        );

        console.log("Mediasoup workers closed, trying to close webServer...");
        webServer.close(() => {
            console.log('Cleanup complete. Exiting process.');
            process.exit(code);
        });
    }
};

process.on('SIGTERM', () => exitProcess(0));

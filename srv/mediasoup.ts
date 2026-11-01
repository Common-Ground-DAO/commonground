// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import fs from 'fs';
import https from 'https';
import protoo from 'protoo-server';
import express from "express";
import bodyParser from 'body-parser';
import cors from 'cors';
import { AwaitQueue } from 'awaitqueue';
import { createWorker } from "mediasoup";

import { httpsConf, mediasoupConfig } from "./mediasoup/config";
import { clone } from "./mediasoup/utils";
import { TransportListenInfo } from 'mediasoup/types';
import Room from "./mediasoup/room";
import * as types from "mediasoup/types";
import { fakeHealthcheck } from './mediasoup/mediasoupHealthcheck';
import callHelper from './repositories/calls';
import { exec } from 'child_process';
import config from './common/config';
import errors from './common/errors';
import pool from './util/postgres';
import format from 'pg-format';
import { type PoolClient } from 'pg';
import validators from './validators';
import deviceHelper from './repositories/device';
import { isSecurityStepRequiredForRealtime } from './util/securityStep';
import { uuidRe } from './util';
import { authenticateProtooTransport, connectionSourceKey, PendingConnectionLimiter } from './mediasoup/connectionGate';

const rooms: Map<string, Room> = new Map();
const mediasoupWorkers: Array<types.Worker> = [];
// Room creation and joining are serialized per room, so two peers connecting
// at the same time with the same roomId do not create two rooms.
const roomQueues: Map<string, AwaitQueue> = new Map();

/** Time a new connection gets to complete the protoo login. */
const PROTOO_LOGIN_TIMEOUT_MS = 5_000;
/**
 * Connections in the login phase: in total, and per source (an IPv4 address
 * or an IPv6 /64).
 */
const pendingConnections = new PendingConnectionLimiter(500, 10);
/**
 * Set when the call server is only reachable through a reverse proxy that
 * sets X-Forwarded-For (the selfhost profile's Caddy). Otherwise the header is
 * client-controlled and ignored.
 */
const TRUST_PROXY = process.env.MEDIASOUP_TRUST_PROXY === 'true';
/** Errors a failed join is reported with; anything else becomes UNKNOWN. */
const JOIN_ERROR_CODES: ReadonlySet<string> = new Set([
    errors.server.CALL_LIMIT_EXCEEDED,
    errors.server.NOT_ALLOWED,
    errors.server.NOT_FOUND,
]);
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
    try {
        const result = await getTrafficSinceLastCall();
        traffic = result.received + result.sent;
    } catch (error) {
        console.error('traffic sampling failed', error);
    }
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

    // mediasoup >= 3.16 dropped its own `disableLiburing` worker setting and now
    // relies on libuv's built-in io_uring, which is toggled via the UV_USE_IO_URING
    // environment variable inherited by the spawned worker process. Preserve the
    // existing MEDIASOUP_DISABLE_LIBURING deployment contract by translating it.
    if (process.env.MEDIASOUP_DISABLE_LIBURING === 'true' && process.env.UV_USE_IO_URING === undefined) {
        process.env.UV_USE_IO_URING = '0';
    }

    console.info('running %d mediasoup Workers...', numWorkers);

    for (let i = 0; i < numWorkers; ++i) {
        const worker = await createWorker(
            {
                logLevel: mediasoupConfig.workerSettings.logLevel,
                logTags: mediasoupConfig.workerSettings.logTags,
                rtcMinPort: Number(mediasoupConfig.workerSettings.rtcMinPort),
                rtcMaxPort: Number(mediasoupConfig.workerSettings.rtcMaxPort),
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
            const listenInfos = (mediasoupConfig?.webRtcTransportOptions as { listenInfos?: TransportListenInfo[] })?.listenInfos;
            if (listenInfos?.[0]) {
                const info: TransportListenInfo = listenInfos[0];
                const ip = info.announcedAddress || info.ip;
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
        const u = new URL(info.request.url, 'http://localhost').searchParams;
        const roomId: string = u.get('roomId') as string;
        const peerId: string = u.get('peerId') as string;

        if (!roomId || !peerId || !uuidRe.test(roomId) || !uuidRe.test(peerId)) {
            reject(400, 'Connection request without valid roomId and/or peerId');

            return;
        }

        // consumerReplicas is a debugging aid inherited from the mediasoup demo
        // that multiplies the consumers created per producer, and it is fixed
        // room-wide by whoever connects first. Clamp it hard so a single client
        // cannot force the worker to allocate an unbounded number of consumers.
        let consumerReplicas = Number(u.get('consumerReplicas'));

        if (isNaN(consumerReplicas) || consumerReplicas < 0) {
            consumerReplicas = 0;
        } else {
            consumerReplicas = Math.min(4, Math.floor(consumerReplicas));
        }

        const source = connectionSourceKey(
            info.socket.remoteAddress, info.request.headers['x-forwarded-for'], TRUST_PROXY);
        const releasePending = pendingConnections.tryAcquire(source);
        if (!releasePending) {
            reject(429, 'Too many pending connections');

            return;
        }

        console.info(
            'protoo connection request [roomId:%s, peerId:%s, address:%s, origin:%s]',
            roomId, peerId, source, info.origin);

        // Accept the WebSocket, then require the protoo login before the
        // connection touches any room state.
        let protooWebSocketTransport: protoo.WebSocketTransport;
        try {
            protooWebSocketTransport = accept();
        } catch (error) {
            releasePending();
            console.error('accepting the protoo connection failed:%o', error);

            return;
        }

        authenticateProtooTransport(protooWebSocketTransport, peerId, {
            timeoutMs: PROTOO_LOGIN_TIMEOUT_MS,
            verify: verifyProtooLogin,
        })
            .finally(releasePending)
            .then(async (connection) => {
                try {
                    await runInRoomQueue(roomId, async () => {
                        if (protooWebSocketTransport.closed) {
                            throw new Error('connection closed');
                        }
                        const room = await getOrCreateRoom({ roomId, peerId, consumerReplicas });
                        try {
                            await room.handleProtooConnection({ peerId, consume: true, protooWebSocketTransport });
                        } catch (error) {
                            room.closeIfEmpty();
                            throw error;
                        }
                    });
                    connection.confirm();
                }
                catch (error: any) {
                    console.error('room creation or room joining failed:%o', error);

                    connection.refuse(JOIN_ERROR_CODES.has(error?.message) ? error.message : errors.server.UNKNOWN);
                }
            }, (error: any) => {
                console.info(
                    'protoo login failed [roomId:%s, peerId:%s, address:%s]: %s',
                    roomId, peerId, source, error?.message);
            });
    });
}

/** Checks a protoo `login` payload; resolves to the device owner's user id. */
async function verifyProtooLogin(data: unknown, secret: string): Promise<string> {
    const login: API.Socket.login.Request = await validators.API.Socket.login.validateAsync(data);
    if (login.secret !== secret) {
        throw new Error(errors.server.INVALID_SECRET);
    }
    const { userId } = await deviceHelper.verifyDeviceAndGetUserId(login.deviceId, secret, login.base64Signature);
    if (await isSecurityStepRequiredForRealtime(userId, { useApiRecord: false })) {
        // the account must finish the account-security step first
        throw new Error(errors.server.SECURITY_STEP_REQUIRED);
    }
    return userId;
}

function runInRoomQueue<T>(roomId: string, task: () => Promise<T>): Promise<T> {
    let roomQueue = roomQueues.get(roomId);
    if (!roomQueue) {
        roomQueue = new AwaitQueue();
        roomQueues.set(roomId, roomQueue);
    }
    const queue = roomQueue;
    return queue.push(task).finally(() => {
        if (queue.size === 0 && roomQueues.get(roomId) === queue) {
            roomQueues.delete(roomId);
        }
    });
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
 * Get a Room instance (or create one if it does not exist) for a call that
 * exists and has not ended. The room's parameters come from the stored call.
 */
async function getOrCreateRoom({
        roomId,
        peerId,
        consumerReplicas,
    }: {
        roomId: string,
        peerId: string,
        consumerReplicas: number,
    }) {
    const callState = await callHelper.getCallState(roomId);
    if (!callState || callState.endedAt) {
        console.info('no ongoing call for this room [roomId:%s]', roomId);
        throw new Error(errors.server.NOT_FOUND);
    }
    // Same rule as the `join` request: only users who may join the call get a
    // peer in its room.
    if (peerId !== callState.callCreator && !(await callHelper.hasPermissionToJoinCall(peerId, roomId))) {
        throw new Error(errors.server.NOT_ALLOWED);
    }
    const { callCreator, slots: callSlots, stageSlots, audioOnly, highQuality, callType } = callState;

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
        const newRoom = await Room.create({ mediasoupWorker, roomId, consumerReplicas, callType, callCreator, stageSlots, callSlots, audioOnly, highQuality });

        rooms.set(roomId, newRoom);
        newRoom.on('close', async () => {
            try {
                await callHelper.softEndCall(roomId);
            } catch (error) {
                console.error('softEndCall failed', error);
            }
            if (rooms.get(roomId) === newRoom) {
                rooms.delete(roomId);
            }
        });
        newRoom.on('forceClose', async () => {
            try {
                await callHelper.endCallForEveryone(roomId);
            } catch (error) {
                console.error('endCallForEveryone failed', error);
            }
            if (rooms.get(roomId) === newRoom) {
                rooms.delete(roomId);
            }
        });
        room = newRoom;
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

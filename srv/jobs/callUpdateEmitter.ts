// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { isMainThread } from 'worker_threads';
import pool from '../util/postgres';
import { describeErrorForLog } from '../util/errorLog';
import eventHelper from '../repositories/event';
import callHelper from '../repositories/calls';
import config from '../common/config';

if (isMainThread) {
  throw new Error("CallUpdateEmitter can only be run as a worker job");
}

// contains timeouts to remove a callserver if it
// doesn't update it's data within the stale period
const callServerInactiveTimeouts = new Map<string, any>();

const callServers = new Map<string, {
  id: string;
  status: Models.Server.CallServerStatus;
  url: string;
  ongoingCalls: Map<string, {
    id: string;
    communityId: string;
    title: string;
    userIds: Set<string>;
    slots: number;
    startedAt: string;
    stageSlots: number;
    highQuality: boolean;
    audioOnly: boolean;
  }>;
}>();
const callServerIdsByCallIds = new Map<string, string>();
const onlineCallServerIds = new Set<string>();

/**
 * Wraps a periodic job so that its runs never overlap: an interval tick that
 * arrives while the previous run is still in flight (a slow database) is
 * skipped instead of starting a second, concurrent run.
 */
function nonOverlapping(job: () => Promise<void>) {
  let running = false;
  return async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await job();
    } finally {
      running = false;
    }
  };
}

const endEmptyCalls = nonOverlapping(async () => {
  try {
    const ended = await callHelper.endEmptyCalls();
    if (ended.length > 0) {
      console.log(`endEmptyCalls ended ${ended.length} empty calls`);
    }
  } catch (e) {
    console.error("Error in endEmptyCalls", e);
  }
});

/**
 * Ends the calls of call servers that are gone (see
 * `callHelper.endCallsOfGoneCallServers`). The liveness signal is the call
 * server's row in Postgres: mediasoup refreshes `callservers."updatedAt"`
 * every `CALLSERVER_UPDATE_DATA_INTERVAL` and sets `"deletedAt"` when it
 * shuts down. Clients learn about the ended calls from the `callchange`
 * notification of the UPDATE, like for every other way a call ends (see
 * `handleCallChange`).
 */
const endCallsOfGoneCallServers = nonOverlapping(async () => {
  try {
    const ended = await callHelper.endCallsOfGoneCallServers();
    if (ended.length > 0) {
      console.warn(`Ended ${ended.length} call(s) of unavailable call servers: ${ended.map(c => c.id).join(', ')}`);
    }
  } catch (e) {
    console.error("Error in endCallsOfGoneCallServers", e);
  }
});

async function getCallServerData() {
  const callServerResults = await pool.query(`
    SELECT
      id,
      status,
      url
    FROM callservers
    WHERE "updatedAt" > now() - interval '${config.CALLSERVER_STALE_AFTER_MILLISECONDS} milliseconds'
      AND "deletedAt" IS NULL
    GROUP BY id
  `);
  const callserverData = callServerResults.rows as {
    id: string;
    status: Models.Server.CallServerStatus;
    url: string;
  }[];
  return callserverData;
}

async function getOngoingCalls() {
  const callResults = await pool.query(`
    SELECT
      c.id,
      c."communityId",
      c."channelId",
      c."callServerId",
      c.title,
      c."previewUserIds",
      c.slots,
      c."startedAt",
      c."updatedAt",
      c."scheduleDate",
      c."stageSlots",
      c."highQuality",
      c."audioOnly",
      array_to_json(array_agg(cm."userId")) AS "userIds"
    FROM calls c
    LEFT OUTER JOIN callmembers cm
      ON c.id = cm."callId"
      AND cm."leftAt" IS NULL
    WHERE c."endedAt" IS NULL
    GROUP BY c.id, cm."callId"
  `);

  return callResults.rows as {
    id: string;
    communityId: string;
    channelId: string;
    callServerId: string;
    title: string;
    previewUserIds: string;
    slots: number;
    startedAt: string;
    updatedAt: string;
    userIds: string[];
    scheduleDate: string | null;
    stageSlots: number;
    highQuality: boolean;
    audioOnly: boolean;
  }[];
}

function addOrUpdateCallServer(data: {
  id: string;
  status: Models.Server.CallServerStatus;
  url: string;
  deletedAt: string | null;
}) {
  // update data
  if (data.deletedAt !== null) {
    onlineCallServerIds.delete(data.id);
    callServers.delete(data.id);

  } else {
    // update timeout
    const activeTimeout = callServerInactiveTimeouts.get(data.id);
    if (!!activeTimeout) {
      clearTimeout(activeTimeout);
    }
    callServerInactiveTimeouts.set(
      data.id,
      setTimeout(
        () => {
          onlineCallServerIds.delete(data.id);
          callServers.delete(data.id);
        },
        config.CALLSERVER_STALE_AFTER_MILLISECONDS,
      ),
    );

    onlineCallServerIds.add(data.id);
    const existing = callServers.get(data.id);
    if (!!existing) {
      existing.status = data.status;
      existing.url = data.url;

    } else {
      callServers.set(data.id, {
        id: data.id,
        status: data.status,
        url: data.url,
        ongoingCalls: new Map(),
      });
    }
  }
}

/**
 * Loads the live call servers and their ongoing calls into memory. Calls of
 * call servers that are not live are left to `endCallsOfGoneCallServers`,
 * which runs right after this.
 */
async function initialSetup() {
  const callserverData = await getCallServerData();

  if (callserverData.length > 0) {
    for (const callServer of callserverData) {
      addOrUpdateCallServer({ ...callServer, deletedAt: null });
    }
  }

  const calls = await getOngoingCalls();
  for (const call of calls) {
    const callServer = callServers.get(call.callServerId);
    if (!!callServer) {
      callServer.ongoingCalls.set(call.id, {
        id: call.id,
        communityId: call.communityId,
        slots: call.slots,
        startedAt: call.startedAt,
        title: call.title,
        userIds: new Set(call.userIds),
        audioOnly: call.audioOnly,
        highQuality: call.highQuality,
        stageSlots: call.stageSlots,
      });
      callServerIdsByCallIds.set(call.id, callServer.id);
    }
  }
}

function handleCallChange(payload: Events.PgNotify.CallChange) {
  if (payload.action === "INSERT") {
    const callServer = callServers.get(payload.callServerId);
    if (!!callServer) {
      callServer.ongoingCalls.set(payload.id, {
        id: payload.id,
        communityId: payload.communityId,
        slots: payload.slots,
        startedAt: payload.startedAt,
        title: payload.title,
        userIds: new Set(),
        audioOnly: payload.audioOnly,
        highQuality: payload.highQuality,
        stageSlots: payload.stageSlots,
      });
      callServerIdsByCallIds.set(payload.id, callServer.id);
    }
  } else if (payload.action === "UPDATE") {
    if (payload.endedAt !== null) {
      // An ended call is removed from every client, whoever ended it (the
      // call server's room, a moderator, a call server reset, or the sweeps
      // in this file) and whether or not its call server is still known
      // here: the calls of a crashed call server are ended after the server
      // has dropped out of `callServers`.
      const trackedOn = callServerIdsByCallIds.get(payload.id);
      if (trackedOn !== undefined) {
        callServers.get(trackedOn)?.ongoingCalls.delete(payload.id);
        callServerIdsByCallIds.delete(payload.id);
      }
      eventHelper.emit({
        type: 'cliCallEvent',
        action: 'delete',
        data: {
          id: payload.id,
          communityId: payload.communityId,
        },
      }, {
        communityIds: [payload.communityId]
      });
      return;
    }

    // existing call updated
    const callServer = callServers.get(payload.callServerId);
    if (!!callServer) {
      eventHelper.emit({
        type: 'cliCallEvent',
        action: 'update',
        data: {
          id: payload.id,
          communityId: payload.communityId,
          previewUserIds: payload.previewUserIds,
          updatedAt: payload.updatedAt,
        },
      }, {
        communityIds: [payload.communityId]
      })
    } else {
      console.warn(
        "Received call update for unavailable CallServer. CallServerId: "
        + payload.callServerId + ", CallId: " + payload.id)
    }

  } else {
    console.warn("Received invalid callchange event", payload);
  }
}

function handleCallMemberChange(payload: Events.PgNotify.CallMemberChange) {
  console.log("CallMember changed", payload);
  // user potentially joined or left call
  const callServerId = callServerIdsByCallIds.get(payload.callId);
  if (!callServerId) {
    return;
  }
  const call = callServers.get(callServerId)?.ongoingCalls?.get(payload.callId);
  if (!call) {
    console.warn("Received callmembership update for unavailable Call, this should not happen", payload);
    return;
  }
  if (
    payload.action === "INSERT" &&
    payload.leftAt === null
  ) {
    call.userIds.add(payload.userId);
    eventHelper.emit({
      type: 'cliCallEvent',
      action: 'update',
      data: {
        id: payload.callId,
        communityId: call.communityId,
        callMembers: call.userIds.size,
      },
    }, {
      communityIds: [call.communityId]
    });

  } else if (
    payload.action === "UPDATE" &&
    payload.leftAt !== null
  ) {
    call.userIds.delete(payload.userId);
    eventHelper.emit({
      type: 'cliCallEvent',
      action: 'update',
      data: {
        id: payload.callId,
        communityId: call.communityId,
        callMembers: call.userIds.size,
      },
    }, {
      communityIds: [call.communityId]
    });

  } else {
    console.warn("Unexpected update of callmember data", payload);
  }
}

(async () => {
  // Listen before loading the initial state and before ending anything, so
  // that no change in between is missed and every call ended from here on
  // (including the ones ended right below) reaches the clients.
  const client = await pool.connect();
  // the database restarted or closed the LISTEN connection: the jobs process
  // restarts this worker, which registers LISTEN again (srv/util/postgres.ts)
  client.on("error", (e) => {
    console.error(`callUpdateEmitter: LISTEN connection failed (${describeErrorForLog(e)}), exiting`);
    process.exit(1);
  });

  client.on("notification", (msg) => {
    if (!!msg.payload) {
      try {
        const payload = JSON.parse(msg.payload) as Events.PgNotify.CallChange | Events.PgNotify.CallMemberChange | Events.PgNotify.CallServerChange;
        if (payload?.type === "callchange") {
          handleCallChange(payload);
        }
        else if (payload?.type === "callmemberchange") {
          handleCallMemberChange(payload);
        }
        else if (payload?.type === "callserverchange") {
          addOrUpdateCallServer({
            id: payload.id,
            status: payload.status,
            url: payload.url,
            deletedAt: payload.deletedAt,
          });
        }
      } catch (e) {
        console.error("Error handling call notification", msg, e);
      }
    }
  });

  await client.query('LISTEN callchange');
  await client.query('LISTEN callmemberchange');
  await client.query('LISTEN callserverchange');

  // Keepalive
  let interval: any = undefined;
  interval = setInterval(async () => {
    try {
      await client.query('SELECT 1');
    }
    catch (e) {
      console.log("KEEPALIVE ERROR", e);
      clearInterval(interval);
      process.exit(1);
    }
  }, 60000);

  await initialSetup();
  await endCallsOfGoneCallServers();

  setInterval(endEmptyCalls, 1000);
  setInterval(endCallsOfGoneCallServers, config.ORPHANED_CALLS_SWEEP_INTERVAL);
})().catch(e => {
  // the jobs process restarts this worker (`createPermanentWorker`)
  console.error("callUpdateEmitter failed to start", e);
  process.exit(1);
});

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { isMainThread } from 'worker_threads';
import pool from '../util/postgres';
import format from 'pg-format';
import eventHelper from '../repositories/event';
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

async function endEmptyCalls() {
  try {
    const result = await pool.query(`
      WITH stale_calls AS (
        SELECT cl.id
        FROM calls cl
        LEFT JOIN callmembers cm
          ON cm."callId" = cl.id
        WHERE cm.id IS NULL
          AND cl."scheduleDate" IS NULL
          AND cl."startedAt" < now() - interval '${config.END_CALL_AFTER_EMPTY_PERIOD} milliseconds'
          AND cl."endedAt" IS NULL
      ), event_calls AS (
      SELECT 
        cl.id,
        ce."scheduleDate",
        ce."duration" * interval '1 minute' AS "duration"
      FROM calls cl
      LEFT JOIN communities_events ce
        ON ce."callId" = cl.id
      LEFT JOIN callmembers cm
        ON cm."callId" = cl.id
      WHERE ce.id IS NOT NULL
        AND cl."startedAt" < now() - interval '${config.END_CALL_AFTER_EMPTY_PERIOD} milliseconds'
        AND cl."endedAt" IS NULL
        GROUP BY cl.id, ce."scheduleDate", ce."duration"
        HAVING COUNT(cm.id) = COUNT(cm."leftAt")
      ), end_calls AS (
      SELECT id FROM stale_calls
      UNION
      SELECT id FROM event_calls
      WHERE 
        "scheduleDate" IS NULL
        OR "scheduleDate" + "duration" < now()
      )
      UPDATE calls
        SET "endedAt" = now(), "updatedAt" = NOW()
      WHERE id = ANY(SELECT id FROM end_calls)
    `);
    if ((result.rowCount ?? 0) > 0) {
      console.log(`endEmptyCalls ended ${result.rowCount} empty calls`);
    }
  } catch (e) {
    console.error("Error in endEmptyCalls", e);
  }
}
setInterval(endEmptyCalls, 1000);

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

async function endStaleCall(callId: string, callServerId: string) {
  await pool.query(`
    WITH ended_time AS (
      SELECT "updatedAt"
      FROM callservers
      WHERE id = ${format("%L::UUID", callServerId)}
    ), update_callmembers AS (
      UPDATE callmembers
      SET "leftAt" = COALESCE((SELECT "updatedAt" FROM ended_time), now())
      WHERE "callId" = ${format("%L::UUID", callId)}
    )
    UPDATE calls
    SET "endedAt" = COALESCE((SELECT "updatedAt" FROM ended_time), now())
    WHERE id = ${format("%L::UUID", callId)}
  `);
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

async function initialSetup() {
  const callserverData = await getCallServerData();

  if (callserverData.length > 0) {
    for (const callServer of callserverData) {
      addOrUpdateCallServer({ ...callServer, deletedAt: null });
    }
  }

  const updateStaleCallsPromises: Promise<any>[] = [];
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

    } else {
      if (call.scheduleDate !== null) {
        const isFinished = await isScheduledCallFinished(call.id);
        if (isFinished) {
          console.warn("Found ongoing call for unavailable call server", call);
          updateStaleCallsPromises.push(endStaleCall(call.id, call.callServerId));
        }
        else {
          console.log("Found scheduled call, skipping: ", call.id);
        }
      } else {
        console.warn("Found ongoing call for unavailable call server", call);
        updateStaleCallsPromises.push(endStaleCall(call.id, call.callServerId));
      }
    }
  }

  if (updateStaleCallsPromises.length > 0) {
    await Promise.all(updateStaleCallsPromises);
  }
}

async function isScheduledCallFinished(callId: string) {
  //check if community event is finished using scheduleDate and duration
  const result = await pool.query(`
    SELECT
      "scheduleDate",
      "duration"
    FROM communities_events
    WHERE "callId" = ${format("%L::UUID", callId)}
  `);
  if (result.rowCount === 0) {
    return false;
  }
  const event = result.rows[0];
  const duration = event.duration || 0;
  const scheduleDate = new Date(event.scheduleDate).getTime();
  const now = new Date().getTime();
  return scheduleDate + duration < now;
}

// Todo: have some periodic function find calls of unavailable
// call servers and end them

(async () => {
  await initialSetup();

  const client = await pool.connect();
  client.query('LISTEN callchange');
  client.query('LISTEN callmemberchange');
  client.query('LISTEN callserverchange');

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

  client.on("notification", (msg) => {
    if (!!msg.payload) {
      try {
        const payload = JSON.parse(msg.payload) as Events.PgNotify.CallChange | Events.PgNotify.CallMemberChange | Events.PgNotify.CallServerChange;
        if (payload && (
          payload.type === "callchange" ||
          payload.type === "callmemberchange" ||
          payload.type === "callserverchange"
        )) {
          if (payload.type === "callchange") {
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
              // existing call updated
              const callServer = callServers.get(payload.callServerId);
              if (!!callServer) {
                if (payload.endedAt !== null) {
                  callServer.ongoingCalls.delete(payload.id);
                  callServerIdsByCallIds.delete(payload.id);
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
                } else {
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
                }
              } else {
                console.warn(
                  "Received call update for unavailable CallServer, this can happen if a server " +
                  "comes back online after a crash and ends unfinished calls. CallServerId: "
                  + payload.callServerId + ", CallId: " + payload.id)
              }

            } else {
              console.warn("Received invalid callchange event", payload);
            }
          }

          else if (payload.type === "callmemberchange") {
            console.log("CallMember changed", payload);
            // user potentially joined or left call
            const callServerId = callServerIdsByCallIds.get(payload.callId);
            if (!!callServerId) {
              const call = callServers.get(callServerId)?.ongoingCalls?.get(payload.callId);
              if (!!call) {
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

              } else {
                console.warn("Received callmembership update for unavailable Call, this should not happen", payload)
              }

            } else {

            }
          }

          else if (payload.type === "callserverchange") {
            addOrUpdateCallServer({
              id: payload.id,
              status: payload.status,
              url: payload.url,
              deletedAt: payload.deletedAt,
            });
          }
        }
      } catch (e) {
        console.log("Expected callchange notification, but message is not JSON-parseable", msg);
      }
    }
  });
})();
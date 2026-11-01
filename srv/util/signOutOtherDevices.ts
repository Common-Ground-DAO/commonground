// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type express from "express";
import type { PoolClient } from "pg";
import errors from "../common/errors";
import deviceHelper from "../repositories/device";
import eventHelper from "../repositories/event";
import transferTokenHelper from "../repositories/transferTokens";
import userHelper from "../repositories/users";
import { publishGeneration } from "./sessionGenerations";
import { endOtherSessions, userSessionsOf } from "./userSessions";

/** the step a change runs inside its transaction, right before COMMIT */
export type BeforeCommit = (client: PoolClient) => Promise<void>;

function saveSession(request: express.Request) {
  return new Promise<void>((resolve, reject) => request.session.save((e) => (e ? reject(e) : resolve())));
}

function logError(what: string) {
  return (e: unknown) => console.error(`Error ${what} after signing out other devices`, e instanceof Error ? e.message : e);
}

/**
 * Runs a change that takes a way in away from the account (or replaces one)
 * and signs the session's user out everywhere else with it
 * (docs/auth-identity §2, "Signing out other devices"). `change` gets the
 * step to run inside its transaction right before COMMIT: it raises the
 * user's session generation and gives this session's device the new one
 * (users.bumpSessionGeneration). So the change and the sign-out commit
 * together or not at all — a refused change signs nobody out — and from the
 * commit on, every other device key and transfer link of the account is
 * invalid, checked in the SQL that looks them up. A change that wrote
 * nothing to the database without running the step gets a sign-out of its
 * own. Refused (LOGIN_REQUIRED) for a session that was itself signed out.
 *
 * After the commit, best effort (none of it is needed for the device keys
 * and links to be invalid):
 * - the new generation is copied to Valkey (retried; otherwise the
 *   reconciler copies it within RECONCILE_INTERVAL_MS, and `delayed` says
 *   so), which ends every other session at its next request; this session is
 *   stamped with it and named as the one that stays;
 * - the other sessions in the index end right away;
 * - the old device keys are deleted and their sockets told (`cliSignedOut`)
 *   and disconnected; old unused transfer links are deleted.
 *
 * Bots are not affected: they have no sessions, and their device is their
 * own account's. Returns the change's result and the number of other
 * devices signed out.
 */
export async function changeAndSignOut<T>(
  request: express.Request,
  change: (beforeCommit: BeforeCommit) => Promise<T>,
): Promise<{ result: T; devices: number; delayed: boolean }> {
  const user = request.session?.user;
  if (!user) {
    throw new Error(errors.server.LOGIN_REQUIRED);
  }
  const callerGeneration = request.session.gen ?? 0;
  let gen: number | undefined;
  const result = await change(async (client) => {
    gen = await userHelper.bumpSessionGeneration(client, user.id, callerGeneration, user.deviceId);
  });
  if (gen === undefined) {
    gen = await userHelper.bumpSessionGenerationAlone(user.id, callerGeneration, user.deviceId);
  }
  return { result, ...await afterSignOut(request, user, gen) };
}

/** User/signOutOtherDevices: the sign-out without a change */
export async function signOutOtherDevices(request: express.Request): Promise<{ devices: number; delayed: boolean }> {
  const { devices, delayed } = await changeAndSignOut(request, async () => undefined);
  return { devices, delayed };
}

/**
 * `delayed`: the copy to Valkey did not arrive — sessions of other devices
 * end once the reconciler copied it (within RECONCILE_INTERVAL_MS).
 */
async function afterSignOut(request: express.Request, user: { id: string; deviceId: string }, gen: number): Promise<{ devices: number; delayed: boolean }> {
  const sessions = userSessionsOf(request.sessionStore);
  const copied = sessions?.generations
    ? await publishGeneration(sessions.generations, user.id, gen, request.sessionID)
    : true;
  if (request.session) {
    request.session.gen = gen;
    await saveSession(request).catch(logError("saving the session"));
  }
  const ended = sessions
    ? await endOtherSessions(request.sessionStore, sessions.index, user.id, request.sessionID, gen).catch((e) => {
      logError("ending the indexed sessions")(e);
      return [] as { sid: string; deviceId: string | null }[];
    })
    : [];
  const deleted = await deviceHelper.deleteStaleDevices(user.id, gen).catch((e) => {
    logError("deleting the old device keys")(e);
    return [] as string[];
  });
  const devices = new Set<string>(deleted);
  for (const { deviceId } of ended) {
    if (deviceId) {
      devices.add(deviceId);
    }
  }
  devices.delete(user.deviceId);
  await eventHelper.signOutDeviceSockets([...devices]).catch(logError("notifying the signed-out devices"));
  await transferTokenHelper.deleteStale(user.id, gen).catch(logError("deleting old transfer links"));
  // a session without a device (none in practice) still counts once
  return { devices: devices.size + ended.filter(({ deviceId }) => !deviceId).length, delayed: !copied };
}

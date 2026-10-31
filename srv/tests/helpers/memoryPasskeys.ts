// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

// In-memory stand-in for srv/repositories/passkeys.ts (same method contract,
// same RP scoping), for jest.mock('../repositories/passkeys', ...).

import { randomUUID } from "node:crypto";
import type { NewPasskey, PasskeyRow } from "../../repositories/passkeys";

export const rows: PasskeyRow[] = [];
export const otherMethods = { password: false, wallets: 0 };

export function reset() {
  rows.length = 0;
  otherMethods.password = false;
  otherMethods.wallets = 0;
}

function toFullData(passkey: NewPasskey): Models.Passkey.FullData {
  return {
    webAuthnUserID: passkey.webAuthnUserID,
    credentialID: passkey.credentialID,
    credentialPublicKeyBase64: passkey.credentialPublicKeyBase64,
    credentialDeviceType: passkey.credentialDeviceType,
    credentialBackedUp: passkey.credentialBackedUp,
    transports: passkey.transports,
  };
}

export function insert(userId: string | null, passkey: NewPasskey): PasskeyRow {
  if (rows.some(r => r.rpId === passkey.rpId && r.data.credentialID === passkey.credentialID)) {
    throw new Error("EXISTS_ALREADY");
  }
  const now = new Date().toISOString();
  const row: PasskeyRow = {
    id: randomUUID(),
    userId,
    rpId: passkey.rpId,
    data: toFullData(passkey),
    counter: passkey.counter,
    name: passkey.name,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    deletedAt: null,
  };
  rows.push(row);
  return row;
}

export function passkeyInsertParams(passkey: NewPasskey) {
  return [passkey.rpId, passkey.origin, passkey.name, JSON.stringify(toFullData(passkey)), passkey.counter];
}

const store = {
  async addPasskey(userId: string, passkey: NewPasskey) {
    return insert(userId, passkey).id;
  },
  async getByCredentialId(rpId: string, credentialID: string) {
    const matches = rows.filter(r => r.rpId === rpId && r.data.credentialID === credentialID);
    return matches.find(r => r.deletedAt === null) || matches[0] || null;
  },
  async getById(rpId: string, id: string) {
    return rows.find(r => r.rpId === rpId && r.id === id) || null;
  },
  async getByIdAnyRp(id: string) {
    return rows.find(r => r.id === id) || null;
  },
  async listUserPasskeys(userId: string, rpId: string) {
    return rows.filter(r => r.userId === userId && r.rpId === rpId && r.deletedAt === null);
  },
  async getUserHandle(userId: string, rpId: string) {
    return rows.find(r => r.userId === userId && r.rpId === rpId)?.data.webAuthnUserID || null;
  },
  async recordUse(id: string, counter: number) {
    const row = rows.find(r => r.id === id && r.deletedAt === null);
    if (!row) throw new Error("NOT_FOUND");
    row.counter = counter;
    row.lastUsedAt = new Date().toISOString();
  },
  async rename(userId: string, rpId: string, id: string, name: string) {
    const row = rows.find(r => r.id === id && r.userId === userId && r.rpId === rpId && r.deletedAt === null);
    if (!row) throw new Error("NOT_FOUND");
    row.name = name;
  },
  async removeUnlessLastMethod(userId: string, rpId: string, id: string) {
    const row = rows.find(r => r.id === id && r.userId === userId && r.rpId === rpId && r.deletedAt === null);
    if (!row) return 'not-found' as const;
    const others = rows.filter(r => r.userId === userId && r.rpId === rpId && r.deletedAt === null && r.id !== id).length;
    if (others === 0 && !otherMethods.password && otherMethods.wallets === 0) return 'last' as const;
    row.deletedAt = new Date().toISOString();
    return 'removed' as const;
  },
};

export default store;

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import localData from "data/appstate/localData";

const DEVICE_IDB_IDENT = "CG_DEVICE_KEY_IDENT";

type IDBKeyPairObject = {
  userId: string,
  deviceId: string,
  keyPair: CryptoKeyPair
}

export async function generateNewKeyPair(): Promise<CryptoKeyPair> {
  return await window.crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-384"
    },
    false,
    ["sign"]
  );
}

/** Resolve only on transaction commit, never on a single request's success.
 * Close on every exit, including failed requests and another tab's upgrade.
 */
async function withDeviceStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
  return localData.run(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DEVICE_IDB_IDENT, 1);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => request.result.createObjectStore(DEVICE_IDB_IDENT, { keyPath: 'deviceId' });
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(DEVICE_IDB_IDENT, mode);
        let value: T;
        tx.oncomplete = () => resolve(value);
        tx.onabort = () => reject(tx.error ?? new Error('Device key transaction aborted'));
        try {
          operation(tx.objectStore(DEVICE_IDB_IDENT), result => { value = result; });
        } catch (error) {
          tx.abort();
          reject(error);
        }
      });
    } finally {
      db.close();
    }
  });
}

export async function getDeviceKeyPair(deviceId: string): Promise<IDBKeyPairObject> {
  const keyPair = await withDeviceStore<IDBKeyPairObject | undefined>('readonly', (store, result) => {
    const request = store.get(deviceId);
    request.onsuccess = () => result(request.result);
  });
  if (!keyPair) throw new Error('KeyPair not found');
  return keyPair;
}

export async function getAllDeviceKeyPairs(): Promise<IDBKeyPairObject[]> {
  return withDeviceStore('readonly', (store, result) => {
    const request = store.getAll();
    request.onsuccess = () => result(request.result);
  });
}

export async function saveDeviceKeyPair(userId: string, deviceId: string, keyPair: CryptoKeyPair): Promise<void> {
  await withDeviceStore<void>('readwrite', store => {
    store.clear();
    store.put({ userId, deviceId, keyPair });
  });
}

export async function deleteDeviceKeyPair(deviceId: string): Promise<void> {
  await withDeviceStore<void>('readwrite', store => { store.delete(deviceId); });
}

export async function signApiSecret(deviceId: string, secret: string) {
  const keyPairObj = await getDeviceKeyPair(deviceId);
  const encoder = new TextEncoder();
  const signature_arrayBuffer = await crypto.subtle.sign(
    {
      name: "ECDSA",
      hash: "SHA-384"
    },
    keyPairObj.keyPair.privateKey as any,
    encoder.encode(secret)
  );
  const uint8arr = new Uint8Array(signature_arrayBuffer);
  const base64Signature = btoa(String.fromCharCode(...Array.from(uint8arr)));
  const result: API.Socket.login.Request = {
    secret,
    base64Signature,
    deviceId
  };
  return result;
}
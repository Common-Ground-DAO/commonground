// SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md
import { describe, expect, it, vi } from 'vitest';
import { IDBObjectStore } from 'fake-indexeddb';
import { installBrowserEnv } from 'test/env';
import { installFakeIdb } from 'test/fakeIdb';
import { importAsNewTab } from 'test/modules';
import { useDataLayerFakeTimers } from 'test/timers';

async function setup() {
  installBrowserEnv(); installFakeIdb();
  return importAsNewTab(() => import('./device'));
}
const keys = { publicKey: { type: 'public' }, privateKey: { type: 'private' } } as CryptoKeyPair;

describe('device key persistence', () => {
  it('stores committed keys and closes a missing-key read without poisoning later access', async () => {
    const device = await setup();
    await expect(device.getDeviceKeyPair('missing')).rejects.toThrow('KeyPair not found');
    await device.saveDeviceKeyPair('u1', 'd1', keys);
    expect((await device.getDeviceKeyPair('d1')).userId).toBe('u1');
    await device.saveDeviceKeyPair('u1', 'd2', keys);
    expect((await device.getAllDeviceKeyPairs()).map(x => x.deviceId)).toEqual(['d2']);
    await device.deleteDeviceKeyPair('d2');
    expect(await device.getAllDeviceKeyPairs()).toEqual([]);
  });

  it('rejects a transaction aborted after put success and preserves the previous key', async () => {
    const device = await setup();
    await device.saveDeviceKeyPair('u1', 'old', keys);
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      const request = put.apply(this, args);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    try {
      await expect(device.saveDeviceKeyPair('u1', 'new', keys)).rejects.toThrow('Local data');
    } finally { spy.mockRestore(); }
    // A fresh page can read the old key; no website-data reset needed.
    const fresh = await importAsNewTab(() => import('./device'));
    expect((await fresh.getAllDeviceKeyPairs()).map(x => x.deviceId)).toEqual(['old']);
  });

  it('bounds a stalled database open and exposes recovery', async () => {
    const device = await setup();
    useDataLayerFakeTimers();
    const { default: data, LOCAL_DATA_TIMEOUT_MS } = await import('data/appstate/localData');
    const spy = vi.spyOn(indexedDB, 'open').mockReturnValue({} as IDBOpenDBRequest);
    try {
      const result = Promise.allSettled([device.getAllDeviceKeyPairs()]);
      await vi.advanceTimersByTimeAsync(LOCAL_DATA_TIMEOUT_MS);
      expect((await result)[0].status).toBe('rejected');
      expect(data.error).not.toBeNull();
    } finally { spy.mockRestore(); }
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, it, expect, vi } from 'vitest';
import { listInputDevices, reconcileDeviceSelection } from './callDeviceSelection';

const dev = (kind: MediaDeviceKind, deviceId: string) =>
  ({ kind, deviceId, groupId: '', label: '', toJSON: () => ({}) }) as MediaDeviceInfo;

describe('reconcileDeviceSelection', () => {
  const mics = [dev('audioinput', 'mic-a'), dev('audioinput', 'mic-b')];

  it('keeps a stored device that is still listed', () => {
    expect(reconcileDeviceSelection('mic-b', mics)).toBe('mic-b');
  });

  it('picks the first device when nothing is stored', () => {
    expect(reconcileDeviceSelection('', mics)).toBe('mic-a');
  });

  it('picks the first device when the stored one is gone', () => {
    expect(reconcileDeviceSelection('unplugged', mics)).toBe('mic-a');
  });

  // Regression: the provider used to do `devices[0].deviceId` here and threw
  // "Cannot read properties of undefined (reading 'deviceId')" on every reload
  // without a camera / before media permission.
  it('does not throw and keeps the stored id when no device is listed', () => {
    expect(() => reconcileDeviceSelection('stale-cam', [])).not.toThrow();
    expect(reconcileDeviceSelection('stale-cam', [])).toBe('stale-cam');
    expect(reconcileDeviceSelection('', [])).toBe('');
  });
});

describe('listInputDevices', () => {
  it('splits inputs by kind and drops entries without a device id', async () => {
    const enumerateDevices = vi.fn(async () => [
      dev('audioinput', 'mic-a'),
      dev('audioinput', ''), // before permission
      dev('videoinput', 'cam-a'),
      dev('videoinput', ''),
      dev('audiooutput', 'speaker'),
    ]);
    const { audio, video } = await listInputDevices({ enumerateDevices });
    expect(enumerateDevices).toHaveBeenCalledTimes(1);
    expect(audio.map(d => d.deviceId)).toEqual(['mic-a']);
    expect(video.map(d => d.deviceId)).toEqual(['cam-a']);
  });

  it('returns empty lists before permission (only id-less entries)', async () => {
    const { audio, video } = await listInputDevices({
      enumerateDevices: async () => [dev('audioinput', ''), dev('videoinput', '')],
    });
    expect(audio).toEqual([]);
    expect(video).toEqual([]);
  });

  it('returns empty lists without navigator.mediaDevices (insecure context)', async () => {
    await expect(listInputDevices(undefined)).resolves.toEqual({ audio: [], video: [] });
    await expect(listInputDevices({})).resolves.toEqual({ audio: [], video: [] });
  });

  it('returns empty lists when enumerateDevices rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      listInputDevices({ enumerateDevices: () => Promise.reject(new Error('NotAllowedError')) }),
    ).resolves.toEqual({ audio: [], video: [] });
    warn.mockRestore();
  });
});

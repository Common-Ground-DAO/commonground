// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Pure helpers behind `CallDevicesProvider`: list the usable audio/video input
 * devices and reconcile the stored selection against them.
 */

type DeviceLike = Pick<MediaDeviceInfo, 'deviceId' | 'kind'>;

export type MediaDevicesSource = {
  enumerateDevices?: () => Promise<MediaDeviceInfo[]>;
} | undefined;

/**
 * Audio and video input devices with a usable id. Before media permission is
 * granted, browsers report inputs with an empty `deviceId` (or none at all);
 * those are left out. `navigator.mediaDevices` is missing outside a secure
 * context, and `enumerateDevices` can reject — both yield empty lists instead
 * of an error.
 */
export async function listInputDevices(
  mediaDevices: MediaDevicesSource,
): Promise<{ audio: MediaDeviceInfo[]; video: MediaDeviceInfo[] }> {
  let devices: MediaDeviceInfo[] = [];
  try {
    devices = (await mediaDevices?.enumerateDevices?.()) ?? [];
  } catch (e) {
    console.warn('enumerateDevices() failed', e);
  }
  const usable = devices.filter(d => !!d?.deviceId);
  return {
    audio: usable.filter(d => d.kind === 'audioinput'),
    video: usable.filter(d => d.kind === 'videoinput'),
  };
}

/**
 * The device id to keep selected, given the stored one and the devices
 * currently listed.
 *
 * - The stored id is listed → keep it.
 * - Nothing is listed → keep the stored id as well. An empty list usually
 *   means "no permission yet" (ids are hidden), not "device gone", so the
 *   user's choice must survive until the devices are visible again; consumers
 *   (`RoomClient`) already fall back to the default device when a stored id
 *   does not resolve.
 * - Otherwise (nothing stored, or the stored device is gone) → the first one.
 */
export function reconcileDeviceSelection(selected: string, devices: DeviceLike[]): string {
  if (devices.length === 0) return selected;
  if (selected !== '' && devices.some(d => d.deviceId === selected)) return selected;
  return devices[0].deviceId;
}

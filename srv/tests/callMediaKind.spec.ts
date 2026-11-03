// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Which call permission a `produce` request on the call server needs
 * (`mediaPermissionOf`); the permission check itself runs against a real
 * database in callMediaPermissionDb.spec.ts.
 */

import { mediaPermissionOf } from '../mediasoup/mediaPermissions';
import { CallPermission } from '../common/enums';

describe('mediaPermissionOf', () => {
  it('audio needs AUDIO_SEND, whatever appData says', () => {
    expect(mediaPermissionOf('audio')).toBe(CallPermission.AUDIO_SEND);
    expect(mediaPermissionOf('audio', { share: true })).toBe(CallPermission.AUDIO_SEND);
  });

  it('video needs VIDEO_SEND, a screen share SHARE_SCREEN', () => {
    expect(mediaPermissionOf('video')).toBe(CallPermission.VIDEO_SEND);
    expect(mediaPermissionOf('video', {})).toBe(CallPermission.VIDEO_SEND);
    expect(mediaPermissionOf('video', { share: false })).toBe(CallPermission.VIDEO_SEND);
    expect(mediaPermissionOf('video', { share: true })).toBe(CallPermission.SHARE_SCREEN);
  });
});

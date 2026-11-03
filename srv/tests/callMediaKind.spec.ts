// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * What a `produce` request on the call server needs (`mediaPermissionOf`,
 * `authorizeProduce` in srv/mediasoup/mediaPermissions.ts, which
 * `Room._handleProtooRequest` calls before it creates the Producer): the
 * permission per kind, the order audio-only → broadcast stage → permission,
 * and `onStage` for broadcasts. The permission check itself runs against a
 * real database in callMediaPermissionDb.spec.ts.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { authorizeProduce, mediaPermissionOf } from '../mediasoup/mediaPermissions';
import { CallPermission, CallType } from '../common/enums';

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

describe('authorizeProduce', () => {
  const defaultCall = { callType: CallType.DEFAULT, audioOnly: false, isBroadcaster: false };
  const broadcast = (isBroadcaster: boolean) => ({ callType: CallType.BROADCAST, audioOnly: false, isBroadcaster });
  const allow = () => jest.fn(async () => true);
  const deny = () => jest.fn(async () => false);

  it.each([
    ['audio', undefined, CallPermission.AUDIO_SEND],
    ['video', undefined, CallPermission.VIDEO_SEND],
    ['video', { share: true }, CallPermission.SHARE_SCREEN],
  ] as const)('a default call asks for the permission of the kind (%s, %j)', async (kind, appData, permission) => {
    const mayProduce = allow();
    await expect(authorizeProduce(defaultCall, kind, appData as any, mayProduce)).resolves.toBeUndefined();
    expect(mayProduce).toHaveBeenCalledWith(permission, false);
  });

  it('refuses with NOT_ALLOWED when the permission is missing', async () => {
    await expect(authorizeProduce(defaultCall, 'audio', undefined, deny())).rejects.toThrow('NOT_ALLOWED');
  });

  it('a broadcast: the stage first, then the check with onStage', async () => {
    const offStage = allow();
    await expect(authorizeProduce(broadcast(false), 'audio', undefined, offStage)).rejects.toThrow('BROADCASTERS_LIMIT_EXCEEDED');
    expect(offStage).not.toHaveBeenCalled();

    const onStage = allow();
    await authorizeProduce(broadcast(true), 'video', { share: true }, onStage);
    expect(onStage).toHaveBeenCalledWith(CallPermission.SHARE_SCREEN, true);

    // a ban (or an ended call) still refuses a peer on the stage
    await expect(authorizeProduce(broadcast(true), 'audio', undefined, deny())).rejects.toThrow('NOT_ALLOWED');
  });

  it('audio-only refuses video before anything else, without asking', async () => {
    const mayProduce = allow();
    await expect(authorizeProduce({ ...defaultCall, audioOnly: true }, 'video', undefined, mayProduce)).rejects.toThrow('audio-only');
    await expect(authorizeProduce({ ...broadcast(false), audioOnly: true }, 'video', undefined, mayProduce)).rejects.toThrow('audio-only');
    expect(mayProduce).not.toHaveBeenCalled();
    await authorizeProduce({ ...defaultCall, audioOnly: true }, 'audio', undefined, mayProduce);
    expect(mayProduce).toHaveBeenCalledWith(CallPermission.AUDIO_SEND, false);
  });

  it('the room\'s produce handler calls it before it creates the Producer', () => {
    // Room pulls in mediasoup and protoo; the wiring is checked on its source
    const source = readFileSync(path.join(__dirname, '../mediasoup/room.ts'), 'utf8');
    const produce = source.slice(source.indexOf("case 'produce':"), source.indexOf("case 'closeProducer':"));
    const authorize = produce.indexOf('await authorizeProduce(');
    expect(authorize).toBeGreaterThan(0);
    expect(authorize).toBeLessThan(produce.indexOf('transport.produce('));
    expect(produce).toContain('isBroadcaster: !!this._broadCasters.get(peer.id)');
    expect(produce).toContain('(permission, onStage) => callHelper.hasPermissionToSendMedia(peer.id, this._roomId, permission, onStage)');
  });
});

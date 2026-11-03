// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { CallPermission, CallType } from '../common/enums';
import errors from '../common/errors';

export type MediaSendPermission = CallPermission.AUDIO_SEND | CallPermission.VIDEO_SEND | CallPermission.SHARE_SCREEN;

/**
 * The call permission a `produce` request needs: audio is AUDIO_SEND, video
 * marked as a screen share by the client (`appData.share`, as the web client
 * sends it) is SHARE_SCREEN, other video is VIDEO_SEND.
 */
export function mediaPermissionOf(kind: 'audio' | 'video', appData?: Record<string, unknown>): MediaSendPermission {
    if (kind === 'audio') {
        return CallPermission.AUDIO_SEND;
    }
    return appData?.share ? CallPermission.SHARE_SCREEN : CallPermission.VIDEO_SEND;
}

export type ProduceRoom = {
    callType: CallType;
    audioOnly: boolean;
    /** the peer is on the stage (`_broadCasters`) */
    isBroadcaster: boolean;
};

/**
 * Whether a peer may produce media of `kind` in a room, in this order:
 * 1. an audio-only call takes no video (the client also hides the camera,
 *    but a modified client must not publish video into a call every
 *    participant believes is audio-only);
 * 2. on a broadcast, only a peer on the stage produces;
 * 3. the peer's call permission for the kind (`mayProduce`, i.e.
 *    `callHelper.hasPermissionToSendMedia`): on a broadcast the peer is on the
 *    stage by now, and being put there is the permission (`onStage`), so only
 *    the call, the community and the ban are checked.
 * Throws the refusal; resolves when the peer may produce.
 */
export async function authorizeProduce(
    room: ProduceRoom,
    kind: 'audio' | 'video',
    appData: Record<string, unknown> | undefined,
    mayProduce: (permission: MediaSendPermission, onStage: boolean) => Promise<boolean>,
): Promise<void> {
    if (room.audioOnly && kind === 'video') {
        throw new Error('this call is audio-only');
    }
    if (room.callType === CallType.BROADCAST && !room.isBroadcaster) {
        throw new Error(errors.server.BROADCASTERS_LIMIT_EXCEEDED);
    }
    const onStage = room.callType === CallType.BROADCAST;
    if (!(await mayProduce(mediaPermissionOf(kind, appData), onStage))) {
        throw new Error(errors.server.NOT_ALLOWED);
    }
}

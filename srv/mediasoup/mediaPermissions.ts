// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { CallPermission } from '../common/enums';

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

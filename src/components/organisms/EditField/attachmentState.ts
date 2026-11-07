// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { InMemoryAttachment } from './useAttachments/useAttachments';

/**
 * Whether an attachment still keeps the message from being sent: the NSFW
 * pre-check is running, the image is still uploading (a picked file without
 * its uploaded ids yet), or its uploaded image is still loading. Sending
 * meanwhile would drop the image without a word (only images with both ids
 * are sent). A failed upload does not block: it shows its error and is left
 * out when the message is sent.
 */
export function isAttachmentBusy(attachment: InMemoryAttachment): boolean {
  if (attachment.precheckPending || attachment.state === 'LOADING') return true;
  return attachment.type === 'image'
    && !!attachment.tentativeFile
    && !attachment.largeImageId
    && !attachment.uploadFailed;
}

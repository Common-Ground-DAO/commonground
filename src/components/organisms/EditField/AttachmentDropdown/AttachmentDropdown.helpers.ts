// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { checkImageBeforeUpload } from "moderation/checkImageBeforeUpload";
import { InMemoryAttachment } from "../useAttachments/useAttachments";

/**
 * Async since the NSFW pre-check: every image runs through
 * `checkImageBeforeUpload` before it is uploaded, and files the user declines
 * in the confirmation dialog are dropped again. Sequential rather than
 * `Promise.all` on purpose — the dialog can only ask about one image at a time,
 * and the model load is shared anyway.
 *
 * The attachments are added to state *synchronously*, in `precheckPending`
 * state, and only then checked. Waiting for the check before touching state
 * would leave the composer showing nothing at all for as long as the check
 * takes (up to a 4.4 MB model download on the first image of a session), which
 * both invites duplicate picks and lets a message be sent in the meantime —
 * the send would clear `attachments`, and the pending update would then land on
 * the emptied list and attach the image to the *next* message.
 *
 * `tentativeFile` identity, not `imageId`, is what pairs a verdict back to its
 * tile: `imageId` starts out as the file name, which two picked files can
 * share.
 */
export async function addFiles(
  setAttachments: React.Dispatch<React.SetStateAction<InMemoryAttachment[]>>,
  setAttachmentError: (error: string) => void,
  files: File[],
  attachmentLimit: number
) {
  if (files.length === 0) return;

  const newAttachments: InMemoryAttachment[] = files.map(file => ({ imageId: file.name, largeImageId: '', type: 'image', tentativeFile: file, state: 'INITIAL', precheckPending: true }));
  // files cut off by the attachment limit must not be pre-checked either —
  // a confirmation dialog about an image that is not in the composer answers
  // nothing. Assigned (not appended) inside the updater so a double-invoked
  // updater stays idempotent.
  let attachedFiles: File[] = [];
  setAttachments(oldAttachments => {
    const attachmentList = [...oldAttachments, ...newAttachments];
    if (attachmentList.length > attachmentLimit) {
      setAttachmentError(`Whoa there, only ${attachmentLimit} attachments allowed at once 😳`);
    }
    const kept = attachmentList.slice(0, attachmentLimit);
    attachedFiles = newAttachments.filter(att => kept.includes(att)).map(att => att.tentativeFile!);
    return kept;
  });

  // Sequential on purpose (beyond the dialog UX): EditField keys attachment
  // tiles by list index, so removing a declined file mid-list remounts the
  // tiles after it. That is only safe while those tiles are still
  // precheckPending (no upload started) — which sequential checking
  // guarantees and a Promise.all would not.
  for (const file of attachedFiles) {
    const accepted = await checkImageBeforeUpload(file);
    setAttachments(oldAttachments => accepted
      ? oldAttachments.map(att => att.tentativeFile === file ? { ...att, precheckPending: false } : att)
      : oldAttachments.filter(att => att.tentativeFile !== file));
  }
}

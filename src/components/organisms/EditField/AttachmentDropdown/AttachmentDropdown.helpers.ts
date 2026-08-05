// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { checkImageBeforeUpload } from "moderation/checkImageBeforeUpload";
import { InMemoryAttachment } from "../useAttachments/useAttachments";

/**
 * Async since the NSFW pre-check: every image runs through
 * `checkImageBeforeUpload` before it becomes an attachment, and files the user
 * declines in the confirmation dialog are dropped. Sequential rather than
 * `Promise.all` on purpose — the dialog can only ask about one image at a time,
 * and the model load is shared anyway.
 */
export async function addFiles(
  setAttachments: React.Dispatch<React.SetStateAction<InMemoryAttachment[]>>,
  setAttachmentError: (error: string) => void,
  files: File[],
  attachmentLimit: number
) {
  const acceptedFiles: File[] = [];
  for (const file of files) {
    if (await checkImageBeforeUpload(file)) acceptedFiles.push(file);
  }
  if (acceptedFiles.length === 0) return;

  const newAttachments: InMemoryAttachment[] = acceptedFiles.map(file => ({ imageId: file.name, largeImageId: '', type: 'image', tentativeFile: file, state: 'INITIAL' }));
  setAttachments(oldAttachments => {
    const attachmentList = [...oldAttachments, ...newAttachments];
    if (attachmentList.length > attachmentLimit) {
      setAttachmentError(`Whoa there, only ${attachmentLimit} attachments allowed at once 😳`);
    }
    return attachmentList.slice(0, attachmentLimit);
  });
}

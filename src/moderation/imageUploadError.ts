// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import errors from 'common/errors';
import { notifyImageRejected } from './suspiciousImageDialog';

/**
 * The server-side filter answers with `{ status: 'ERROR', error:
 * 'IMAGE_CONTENT_REJECTED' }` at HTTP 200, which `FileApiConnector.uploadImage`
 * turns into `Error('IMAGE_CONTENT_REJECTED')`. Nineteen call sites share that
 * one throw, so the mapping to something a human can read lives here rather
 * than being retyped in each of them.
 */
export function isImageContentRejected(error: unknown): boolean {
  return error instanceof Error && error.message === errors.server.IMAGE_CONTENT_REJECTED;
}

/**
 * The one way a server-side rejection is reported to the user.
 *
 * Call it first in every image-upload `catch`:
 *
 * ```ts
 * if (!notifyIfImageRejected(err)) { …the call site's generic handling… }
 * ```
 *
 * Returns `true` when it took over (a modal is now up and the call site should
 * not also raise a snackbar or an inline error), `false` for every other
 * failure. A rejection is a policy decision, not a transient glitch, and the
 * per-site snackbars/error tags it replaces were routinely missed — so it gets
 * one dialog, the same one everywhere. See `./suspiciousImageDialog.ts`.
 */
export function notifyIfImageRejected(error: unknown): boolean {
  if (!isImageContentRejected(error)) return false;
  notifyImageRejected();
  return true;
}

/**
 * Text for an upload failure: the friendly rejection message when the filter
 * turned the image down, otherwise whatever the call site would have shown
 * anyway (the raw error message, or `fallback` when there is none).
 *
 * Prefer `notifyIfImageRejected` for the rejection case — this remains for
 * `fallback`-only use, where the rejection branch is dead because the caller
 * has already handled it.
 */
export function imageUploadErrorText(error: unknown, fallback: string): string {
  if (isImageContentRejected(error)) return errors.client.IMAGE_CONTENT_REJECTED;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

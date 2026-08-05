// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import errors from 'common/errors';

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
 * Text for an upload failure: the friendly rejection message when the filter
 * turned the image down, otherwise whatever the call site would have shown
 * anyway (the raw error message, or `fallback` when there is none).
 */
export function imageUploadErrorText(error: unknown, fallback: string): string {
  if (isImageContentRejected(error)) return errors.client.IMAGE_CONTENT_REJECTED;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

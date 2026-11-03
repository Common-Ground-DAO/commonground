// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import errors from "common/errors";

/** the kinds of media the call server may refuse to take from us */
export type RefusedMediaKind = "audio" | "video" | "share";

/**
 * Whether a failed produce was refused by the call server for lack of
 * permission (the protoo error carries the server's error text).
 */
export function isMediaRefusal(error: unknown): boolean {
  return error instanceof Error && error.message === errors.server.NOT_ALLOWED;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from "express";
import { handleError } from "./util";
import { asyncRequestHandler, type AsyncErrorResponder } from "../util/asyncHandler";

export type { AsyncErrorResponder };

/**
 * `asyncRequestHandler` (srv/util/asyncHandler.ts) with the api's default
 * responder: a throw or rejection anywhere in `handler` ends in `onError`
 * (default: `handleError`, the API's `{ status: 'ERROR', error }` body); pass
 * the route's own error page or status where it answers differently.
 *
 * `registerPostRoute` handlers get the same treatment; raw
 * `router.get/post/use(...)` registrations with an async function must use
 * this wrapper.
 */
export function asyncHandler(
  handler: (request: express.Request, response: express.Response, next: express.NextFunction) => unknown,
  onError: AsyncErrorResponder = handleError,
): express.RequestHandler {
  return asyncRequestHandler(handler, onError);
}

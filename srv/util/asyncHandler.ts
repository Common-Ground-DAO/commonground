// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type express from "express";
import { describeErrorForLog } from "./errorLog";

export type AsyncErrorResponder = (response: express.Response, error: unknown) => void | Promise<void>;

/**
 * Wraps a route handler or middleware that may return a promise, for any
 * express app in the backend (dependency-free; the api's routers use
 * `asyncHandler` from `srv/api/asyncHandler.ts`, which defaults `onError` to
 * `handleError`).
 *
 * Express 5 hands a rejected handler promise to the error middleware, which
 * answers with HTTP 500 (the api: `apiErrorHandler`). With
 * this wrapper every failure — a throw outside the handler's own try/catch,
 * or an error raised by its catch block — ends in `onError(response, error)`
 * instead, so each route keeps its own error format (the api's
 * `{ status: 'ERROR', error }` envelope, an HTML page, plain text). The
 * wrapper returns nothing, so Express never sees the handler's promise.
 *
 * If the response has already been started, nothing more is sent: the error
 * is logged, and an unfinished response is handed to `next(error)` so Express
 * closes the connection. If `onError` itself throws or rejects, the error goes
 * to `next(error)` as well (the app's error middleware answers).
 */
export function asyncRequestHandler(
  handler: (request: express.Request, response: express.Response, next: express.NextFunction) => unknown,
  onError: AsyncErrorResponder,
): express.RequestHandler {
  return (request, response, next) => {
    const fail = (error: unknown) => {
      if (response.headersSent) {
        console.error(`Request ${request.method} ${request.path} failed after the response was started:`, describeErrorForLog(error));
        if (!response.writableEnded) {
          next(error);
        }
        return;
      }
      try {
        const answered = onError(response, error);
        if (isThenable(answered)) {
          answered.then(undefined, next);
        }
      } catch (responderError) {
        next(responderError);
      }
    };
    try {
      const result = handler(request, response, next);
      if (isThenable(result)) {
        result.then(undefined, fail);
      }
    } catch (error) {
      fail(error);
    }
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof (value as PromiseLike<unknown>).then === 'function';
}

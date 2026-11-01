// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type express from "express";

export type AsyncErrorResponder = (response: express.Response, error: unknown) => void | Promise<void>;

/**
 * Wraps a route handler or middleware that may return a promise, for any
 * express app in the backend (dependency-free; the api's routers use
 * `asyncHandler` from `srv/api/asyncHandler.ts`, which defaults `onError` to
 * `handleError`).
 *
 * Express 4 ignores the promise a handler returns, so a rejection — a throw
 * outside the handler's own try/catch, or an error raised by its catch block —
 * would otherwise never reach a response. With this wrapper every failure ends
 * in `onError(response, error)`.
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
        console.error(`Request ${request.method} ${request.path} failed after the response was started:`, error);
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

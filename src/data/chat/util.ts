// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { ChatClock } from './types';

/** the browser's clock (the app passes this; tests use fake timers or their own clock) */
export const systemClock: ChatClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The route does not exist on this server (deploy window: new client, old
 * server). baseConnector rejects with `Unexpected status: 404`; an error
 * object carrying `status: 404` counts as well.
 */
export function isHttpNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const status = (error as { status?: unknown }).status;
  if (status === 404) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /\bstatus:? 404\b/.test(message);
}

/** the server rejected the request body (Joi) */
export function isValidationError(error: unknown): boolean {
  return error instanceof Error && error.message === 'VALIDATION';
}

/** the server answered NOT_FOUND */
export function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message === 'NOT_FOUND';
}

/** one pending timer, re-armed or cleared by name */
export class Timer {
  private handle: unknown = undefined;
  private armed = false;

  constructor(private readonly clock: ChatClock) {}

  get pending(): boolean {
    return this.armed;
  }

  /** start unless already running */
  ensure(ms: number, fn: () => void): void {
    if (this.armed) return;
    this.start(ms, fn);
  }

  /** (re)start */
  start(ms: number, fn: () => void): void {
    this.clear();
    this.armed = true;
    this.handle = this.clock.setTimeout(() => {
      this.armed = false;
      this.handle = undefined;
      fn();
    }, ms);
  }

  clear(): void {
    if (this.armed) this.clock.clearTimeout(this.handle);
    this.armed = false;
    this.handle = undefined;
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/** the default limit of one poll's page.evaluate (lib/live.ts, lib/tabs.ts, connectionState) */
export const EVAL_TIMEOUT_MS = 10_000;

/**
 * Rejects when `promise` takes longer than `ms`. Poll helpers wrap their
 * page.evaluate in it, so a page that stops answering (a frozen or crashed
 * renderer) fails that poll after seconds instead of hanging the step until
 * the browser's protocol timeout (120 s, src/main.ts).
 */
export async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: the page did not answer within ${ms / 1000} s`)), ms);
      }),
    ]);
  }
  finally {
    clearTimeout(timer);
  }
}

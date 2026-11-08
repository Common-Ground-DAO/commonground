// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * What an unexpected error may put into the log: its name, message and stack
 * — never the error object itself, which can carry request data (an HTTP
 * client error holds the request it sent, including credentials; a database
 * error the values of the row).
 *
 * Dependency-free so that every backend process (memberlist included) can use
 * it; `srv/api/util.ts` re-exports it.
 */
export function describeErrorForLog(e: unknown): string {
  if (e instanceof Error) {
    return e.stack || `${e.name}: ${e.message}`;
  }
  return `non-error value of type ${typeof e}`;
}

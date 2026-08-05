// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Module-level bridge between the pre-check (a plain async function, called
 * from `<input onChange>` handlers, dropzone callbacks and a Slate paste
 * handler alike) and the React modal that asks the user about a suspicious
 * image.
 *
 * `SuspiciousImageModalProvider` registers the handler once at app root; see
 * `src/context/SuspiciousImageModalProvider.tsx`. Same shape as
 * `ReportModalProvider`, minus the context — the callers are not components, so
 * a hook is not an option.
 */

type ConfirmHandler = () => Promise<boolean>;

let handler: ConfirmHandler | undefined;

/** Called by the provider on mount (and with `undefined` on unmount). */
export function registerSuspiciousImageConfirm(next: ConfirmHandler | undefined): void {
  handler = next;
}

/**
 * Resolves `true` when the upload should go ahead.
 *
 * With no provider mounted this resolves `true`: the client check is advisory,
 * and silently dropping a file because a modal host is missing would be worse
 * than letting the server decide.
 */
export function confirmSuspiciousImage(): Promise<boolean> {
  if (!handler) return Promise.resolve(true);
  return handler();
}

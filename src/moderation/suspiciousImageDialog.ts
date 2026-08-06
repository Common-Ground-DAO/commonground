// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Module-level bridge between the image-moderation dialogs (plain functions,
 * called from `<input onChange>` handlers, dropzone callbacks and a Slate paste
 * handler alike) and the React modals that show them.
 *
 * Two dialogs share this bridge and the same host:
 *
 * - `confirmSuspiciousImage()` — the *pre-upload* question ("this may be
 *   explicit, upload anyway?"), answered by the user.
 * - `notifyImageRejected()` — the *post-upload* notice that the server-side
 *   filter turned the image down. It answers nothing; it exists so that a
 *   rejection is impossible to miss, identically at every upload surface,
 *   instead of the per-site mix of snackbars and inline error text it replaces.
 *
 * `SuspiciousImageModalProvider` registers both handlers once at app root; see
 * `src/context/SuspiciousImageModalProvider.tsx`. Same shape as
 * `ReportModalProvider`, minus the context — the callers are not components, so
 * a hook is not an option.
 */

type ConfirmHandler = () => Promise<boolean>;
type RejectedNoticeHandler = () => void;

let handler: ConfirmHandler | undefined;
let rejectedNoticeHandler: RejectedNoticeHandler | undefined;

/** Called by the provider on mount (and with `undefined` on unmount). */
export function registerSuspiciousImageConfirm(next: ConfirmHandler | undefined): void {
  handler = next;
}

/** Called by the provider on mount (and with `undefined` on unmount). */
export function registerImageRejectedNotice(next: RejectedNoticeHandler | undefined): void {
  rejectedNoticeHandler = next;
}

/**
 * Shows the "this image was not uploaded" notice.
 *
 * A no-op with no provider mounted: the call sites keep their own generic error
 * handling for everything else, so a missing modal host costs the user nothing
 * beyond this one message.
 */
export function notifyImageRejected(): void {
  rejectedNoticeHandler?.();
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

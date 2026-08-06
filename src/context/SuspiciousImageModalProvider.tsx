// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Button from 'components/atoms/Button/Button';
import errors from 'common/errors';
import {
  registerImageRejectedNotice,
  registerSuspiciousImageConfirm,
} from 'moderation/suspiciousImageDialog';

import './SuspiciousImageModalProvider.css';

/**
 * Hosts both image-moderation dialogs:
 *
 * - the *pre-upload* "this image may be explicit" confirmation, and
 * - the *post-upload* "the server rejected this image" notice.
 *
 * Mounted once at app root (next to `ReportModalProvider`) and driven
 * imperatively, because the callers are `<input onChange>` handlers and helper
 * functions rather than components — see `moderation/suspiciousImageDialog.ts`.
 *
 * The confirmation is a warning, never a block. The client classifier is ~90%
 * accurate, so a hard stop there would silently strand legitimate uploads;
 * "Upload anyway" always exists, and the server still gets the final say. The
 * notice is the other end of that sentence: when the server does say no, every
 * upload surface says so the same way, in a dialog the user cannot walk past —
 * it replaces a per-site mix of snackbars and inline error tags that manual
 * testing showed people miss.
 *
 * ## Why this does not use `ScreenAwareModal` / `Modal`
 *
 * Every picker that can trigger this dialog lives *inside* another modal
 * (Create Community, Schedule Event, user settings, the bot editor …), so the
 * confirmation is always a nested modal, and both shared modal hosts break in
 * that position:
 *
 * - `ScreenAwareModal` renders a `BottomSliderModal` on mobile, which portals
 *   into `document.body` at `z-index: 1000` — underneath `#modal-root-anchor`
 *   (10000) and its `.modal-root` (10100). The dialog would be painted below
 *   the parent modal's backdrop and receive no pointer events, so nothing could
 *   ever answer the promise and the picked file would be lost with no feedback.
 * - `Modal` mutates the *shared* `#modal-root-anchor` on mount and resets it on
 *   unmount. Closing a nested modal therefore strips the backdrop off the
 *   parent modal that is still open (`CreateCommunityModal` works around this
 *   with `noBackground` + its own overlay).
 *
 * A two-button confirmation is not worth either risk, so it renders into its
 * own portal node on `document.body`, with its own backdrop and a z-index above
 * every modal layer in the app. See `SuspiciousImageModalProvider.css`.
 */

/**
 * One queue for both dialogs, so they can never stack on top of each other:
 * a multi-file drop can ask about file 2 while file 1's upload is already
 * coming back rejected. A `confirm` entry owes its caller an answer, a
 * `rejected` entry owes nothing and only has to be dismissed.
 */
type DialogEntry =
  | { kind: 'confirm'; resolve: (proceed: boolean) => void }
  | { kind: 'rejected' };

export function SuspiciousImageModalProvider(props: React.PropsWithChildren<{}>) {
  // A queue, not a single slot: a multi-file drop checks its files one after
  // another, and a second suspicious file must not lose its resolver.
  const queueRef = useRef<DialogEntry[]>([]);
  // Mirrors `queueRef.current[0]?.kind` into render. `undefined` = nothing open.
  const [currentKind, setCurrentKind] = useState<DialogEntry['kind'] | undefined>(undefined);
  const isOpen = currentKind !== undefined;
  const [portalNode] = useState(() => {
    const node = document.createElement('div');
    node.id = 'suspicious-image-dialog-root';
    return node;
  });

  useEffect(() => {
    document.body.appendChild(portalNode);
    return () => {
      portalNode.remove();
    };
  }, [portalNode]);

  useEffect(() => {
    const enqueue = (entry: DialogEntry) => {
      // Notices coalesce: dropping four files that all come back rejected is
      // one piece of news, not four identical dialogs to click through. A
      // `confirm` is never collapsed — each one owns a file's fate.
      if (entry.kind === 'rejected' && queueRef.current.some((e) => e.kind === 'rejected')) return;
      queueRef.current.push(entry);
      setCurrentKind(queueRef.current[0].kind);
    };
    registerSuspiciousImageConfirm(
      () => new Promise<boolean>((resolve) => enqueue({ kind: 'confirm', resolve })),
    );
    registerImageRejectedNotice(() => enqueue({ kind: 'rejected' }));
    return () => {
      registerSuspiciousImageConfirm(undefined);
      registerImageRejectedNotice(undefined);
      // Nothing is left to answer the pending questions; let them through
      // rather than dropping the files silently. Queued notices are simply
      // dropped — there is nobody waiting on them.
      const pending = queueRef.current;
      queueRef.current = [];
      for (const entry of pending) if (entry.kind === 'confirm') entry.resolve(true);
    };
  }, []);

  const answer = useCallback((proceed: boolean) => {
    const entry = queueRef.current.shift();
    if (entry?.kind === 'confirm') entry.resolve(proceed);
    setCurrentKind(queueRef.current[0]?.kind);
  }, []);

  // Closing by backdrop/escape is a cancel for the confirmation (the safer of
  // the two answers) and a plain dismiss for the notice.
  const onClose = useCallback(() => answer(false), [answer]);

  // Captured on the way down, and swallowed: while this dialog is up it is the
  // topmost thing on screen, so Escape must answer *it* and not also close the
  // modal underneath (`ManagementContentModal` for one listens on `document`
  // and would not recognise this dialog as "inside" a modal). Tab is confined
  // to the dialog for the same reason — otherwise focus keeps walking the
  // parent modal's controls behind the backdrop and Enter would activate them
  // with the confirmation still unanswered.
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!currentKind) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // aria-modal container is focusable itself; initial focus goes to the
    // safe answer (Cancel = first button; the notice only has "OK")
    dialogRef.current?.querySelector<HTMLElement>('button')?.focus();
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopImmediatePropagation();
        ev.preventDefault();
        onClose();
        return;
      }
      if (ev.key === 'Tab') {
        const buttons = dialogRef.current?.querySelectorAll<HTMLElement>('button');
        if (!buttons || buttons.length === 0) return;
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        const active = document.activeElement;
        // cycle within the dialog; also recapture focus that escaped it
        if (ev.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
          ev.preventDefault();
          last.focus();
        } else if (!ev.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
          ev.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus?.();
    };
    // Keyed on the *kind*, so swapping between the two dialogs re-runs initial
    // focus; a second entry of the same kind reuses the button that is already
    // focused.
  }, [currentKind, onClose]);

  return (
    <>
      {props.children}
      {isOpen &&
        createPortal(
          <div className="suspicious-image-dialog-backdrop" onClick={onClose}>
            <div
              ref={dialogRef}
              className="suspicious-image-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="suspicious-image-dialog-title"
              onClick={(ev) => ev.stopPropagation()}
            >
              <div id="suspicious-image-dialog-title" className="cg-heading-3">
                {currentKind === 'rejected' ? 'Image not uploaded' : 'Sensitive content?'}
              </div>
              <p className="cg-text-main">
                {currentKind === 'rejected'
                  ? errors.client.IMAGE_CONTENT_REJECTED
                  : 'This image may contain inappropriate content. Upload it anyway?'}
              </p>
              <div className="btnList justify-end gap-4">
                {currentKind === 'rejected' ? (
                  <Button text="OK" role="primary" onClick={onClose} />
                ) : (
                  <>
                    <Button text="Cancel" role="secondary" onClick={onClose} />
                    <Button text="Upload anyway" role="primary" onClick={() => answer(true)} />
                  </>
                )}
              </div>
            </div>
          </div>,
          portalNode,
        )}
    </>
  );
}

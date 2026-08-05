// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Button from 'components/atoms/Button/Button';
import { registerSuspiciousImageConfirm } from 'moderation/suspiciousImageDialog';

import './SuspiciousImageModalProvider.css';

/**
 * Hosts the "this image may be explicit" confirmation.
 *
 * Mounted once at app root (next to `ReportModalProvider`) and driven
 * imperatively, because the callers are `<input onChange>` handlers and helper
 * functions rather than components — see `moderation/suspiciousImageDialog.ts`.
 *
 * It is a warning, never a block. The client classifier is ~90% accurate, so a
 * hard stop here would silently strand legitimate uploads; "Upload anyway"
 * always exists, and the server still gets the final say.
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
export function SuspiciousImageModalProvider(props: React.PropsWithChildren<{}>) {
  // A queue, not a single slot: a multi-file drop checks its files one after
  // another, and a second suspicious file must not lose its resolver.
  const queueRef = useRef<((proceed: boolean) => void)[]>([]);
  const [isOpen, setIsOpen] = useState(false);
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
    registerSuspiciousImageConfirm(
      () =>
        new Promise<boolean>((resolve) => {
          queueRef.current.push(resolve);
          setIsOpen(true);
        }),
    );
    return () => {
      registerSuspiciousImageConfirm(undefined);
      // Nothing is left to answer the pending questions; let them through
      // rather than dropping the files silently.
      const pending = queueRef.current;
      queueRef.current = [];
      for (const resolve of pending) resolve(true);
    };
  }, []);

  const answer = useCallback((proceed: boolean) => {
    queueRef.current.shift()?.(proceed);
    setIsOpen(queueRef.current.length > 0);
  }, []);

  // Closing by backdrop/escape is a cancel: the safer of the two answers.
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
    if (!isOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // aria-modal container is focusable itself; initial focus goes to the
    // safe answer (Cancel = first button)
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
  }, [isOpen, onClose]);

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
                Sensitive content?
              </div>
              <p className="cg-text-main">
                This image may contain inappropriate content. Upload it anyway?
              </p>
              <div className="btnList justify-end gap-4">
                <Button text="Cancel" role="secondary" onClick={onClose} />
                <Button text="Upload anyway" role="primary" onClick={() => answer(true)} />
              </div>
            </div>
          </div>,
          portalNode,
        )}
    </>
  );
}

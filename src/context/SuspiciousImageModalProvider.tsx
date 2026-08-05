// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useRef, useState } from 'react';
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import Button from 'components/atoms/Button/Button';
import { useWindowSizeContext } from './WindowSizeProvider';
import { registerSuspiciousImageConfirm } from 'moderation/suspiciousImageDialog';

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
 */
export function SuspiciousImageModalProvider(props: React.PropsWithChildren<{}>) {
  const { isMobile } = useWindowSizeContext();
  // A queue, not a single slot: a multi-file drop checks its files one after
  // another, and a second suspicious file must not lose its resolver.
  const queueRef = useRef<((proceed: boolean) => void)[]>([]);
  const [isOpen, setIsOpen] = useState(false);

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

  return (
    <>
      {props.children}
      <ScreenAwareModal title="Sensitive content?" isOpen={isOpen} onClose={onClose}>
        <div className={`flex flex-col gap-4${isMobile ? ' p-4 pb-16' : ' p-4'}`}>
          <p className="cg-text-main">
            This image may contain inappropriate content. Upload it anyway?
          </p>
          <div className="btnList justify-end gap-4">
            <Button text="Cancel" role="secondary" onClick={onClose} />
            <Button text="Upload anyway" role="primary" onClick={() => answer(true)} />
          </div>
        </div>
      </ScreenAwareModal>
    </>
  );
}

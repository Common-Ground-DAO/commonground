// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import { Sheet, SheetRef } from 'react-modal-sheet'
import Scrollable from 'components/molecules/Scrollable/Scrollable';

import './BottomSliderModal.css';

type Props = {
  isOpen: boolean;
  onClose: () => void;
  customClassname?: string;
  hideMobileHandler?: boolean;
  noDefaultScrollable?: boolean;
  floatingMode?: boolean;

  overrideZIndex?: number;
  footerActions?: React.JSX.Element;
}

const BottomSliderModal: React.FC<React.PropsWithChildren<Props>> = (props) => {
  const { isOpen, onClose, customClassname, children, hideMobileHandler, noDefaultScrollable, floatingMode } = props;
  const ref = React.useRef<SheetRef>(null);

  const className = [
    'bottom-slider-modal-container',
    customClassname || '',
    hideMobileHandler ? 'header-hidden' : '',
    floatingMode ? 'floating-mode' : 'full-mode'
  ].join(' ').trim();

  let content: React.ReactNode;
  if (noDefaultScrollable) {
    content = children;
  } else {
    content = <Scrollable innerClassName='pb-4'>
      {children}
    </Scrollable>;
  }

  return (
    <Sheet
      isOpen={isOpen}
      onClose={onClose}
      ref={ref}
      detent='content'
      className={className}
      /*
        react-modal-sheet v5 added virtual-keyboard avoidance and enables it by
        default. On Chromium it flips `navigator.virtualKeyboard.overlaysContent`
        to `true` for as long as a sheet is open, which stops `visualViewport.height`
        from shrinking when the keyboard opens — and that is exactly the signal
        `WindowSizeProvider` uses to drive `--visualHeight` (and this component's
        own height, see BottomSliderModal.css). On iOS Safari (no VirtualKeyboard
        API) it instead pads the scroller by `window.innerHeight -
        visualViewport.height` — the same delta `WindowSizeProvider` already
        subtracts from `--visualHeight`, so it would double-compensate. Keeping
        it off preserves the v2 behaviour on both platforms and leaves keyboard
        handling with the app.
      */
      avoidKeyboard={false}
      /*
        v5 also raised the flick-to-dismiss velocity threshold from v2's
        500 px/s to 1200 px/s; without this prop a normal quick downward swipe
        would snap the sheet back open instead of closing it. Keep v2's feel.
      */
      dragVelocityThreshold={500}
      style={{ zIndex: props.overrideZIndex || 1000 }}
    >
      <Sheet.Container>
        {!hideMobileHandler && <Sheet.Header />}
        {/*
          `Sheet.Content` renders its own scroller child (class
          `react-modal-sheet-content-scroller`) since react-modal-sheet v5, which
          replaces the `Sheet.Scroller` compound component v2 needed around the
          children — same DOM depth; the scroller keeps v2's height/overflow and
          adds `overscroll-behavior-y: none` (plus `touch-action: pan-down`
          while scrolled to the top, which is what makes the drag-to-close
          gesture win over scrolling there).
        */}
        <Sheet.Content>
          {content}
          {props.footerActions && <div className='flex justify-center p-2'>
            {props.footerActions}
          </div>}
        </Sheet.Content>
      </Sheet.Container>
      <Sheet.Backdrop onTap={onClose} />
    </Sheet>
  )
}

export default BottomSliderModal
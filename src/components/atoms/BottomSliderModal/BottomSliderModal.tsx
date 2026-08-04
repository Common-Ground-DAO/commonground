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
  footerActions?: JSX.Element;
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
        default. Its implementation flips `navigator.virtualKeyboard.overlaysContent`
        to `true` for as long as a sheet is open, which stops `visualViewport.height`
        from shrinking when the keyboard opens — and that is exactly the signal
        `WindowSizeProvider` uses to drive `--visualHeight` (and this component's
        own height, see BottomSliderModal.css). Keeping it off preserves the v2
        behaviour and leaves keyboard handling with the app.
      */
      avoidKeyboard={false}
      style={{ zIndex: props.overrideZIndex || 1000 }}
    >
      <Sheet.Container>
        {!hideMobileHandler && <Sheet.Header />}
        {/*
          `Sheet.Content` renders its own scroller child (class
          `react-modal-sheet-content-scroller`) since react-modal-sheet v5, which
          replaces the `Sheet.Scroller` compound component v2 needed around the
          children — same DOM depth, same scroller styles.
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
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useWindowSizeContext } from 'context/WindowSizeProvider';
import React from 'react'
import BottomSliderModal from '../BottomSliderModal/BottomSliderModal';
import Modal from '../Modal/Modal';

import './ScreenAwareModal.css';

type Props = {
  isOpen: boolean;
  title?: string;
  closeOnClick?: boolean;
  onClose: () => void;
  hideHeader?: boolean;
  customClassname?: string;
  hideMobileHandler?: boolean;
  noDefaultScrollable?: boolean;
  footerActions?: React.JSX.Element;
  modalRootStyle?: React.CSSProperties;
};

const ScreenAwareModal: React.FC<React.PropsWithChildren<Props>> = (props) => {
  const { isMobile } = useWindowSizeContext();

  if (isMobile) {
    return <BottomSliderModal {...props} />
  } else {
    if (props.isOpen) {
      return <Modal
        close={props.onClose}
        headerText={props.title}
        closeOnClick={props.closeOnClick}
        hideHeader={props.hideHeader}
        modalInnerClassName={props.customClassname}
        noDefaultScrollable={props.noDefaultScrollable}
        footerActions={props.footerActions}
        modalRootStyle={props.modalRootStyle}
      >
        {props.children}
      </Modal>
    }
  }

  return null;
}

export default ScreenAwareModal
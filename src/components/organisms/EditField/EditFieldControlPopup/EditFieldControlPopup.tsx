// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'

import './EditFieldControlPopup.css';

type Props = {
  visible: boolean;
  close: () => void;
  editFieldHeight: number;
  triggerRef: React.RefObject<HTMLDivElement | null>;
}

const EditFieldControlPopup: React.FC<React.PropsWithChildren<Props>> = (props) => {
  const { visible, close, triggerRef } = props;
  const styleBottom = props.editFieldHeight;
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handleClickOutside = (ev: MouseEvent) => {
      const target = ev.target as Element;
      if (visible && target && !ref?.current?.contains(target) && !triggerRef.current?.contains(target)) {
        close();
      }
    };
    document.addEventListener('click', handleClickOutside, true);
    return () => {
      document.removeEventListener('click', handleClickOutside, true);
    };
  }, [close, triggerRef, visible]);
  
  if (!props.visible) return null;

  return (
    <div style={{ bottom: styleBottom }} className='edit-field-control-popup-container'>
      <div ref={ref} className='edit-field-control-popup'>{props.children}</div>
    </div>
  )
}

export default EditFieldControlPopup;
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Scrollable from 'components/molecules/Scrollable/Scrollable';
import './SidebarContainer.css';
import React, { useEffect, useRef } from 'react';

type Props = {
  isOpen: boolean;
  onClose: () => void;
  sidebarClassName?: string;
};

const SidebarContainer: React.FC<React.PropsWithChildren<Props>> = (props) => {
  const { isOpen, onClose, children, sidebarClassName } = props;
  const selfRef = useRef<HTMLDivElement>(null);

  // Outside click listener
  useEffect(() => {
    const handleClickOutside = (ev: MouseEvent) => {
      const target = ev.target as Element;
      
      // Don't close if clicking inside fullscreen image modal or other modals
      if (document.querySelector('.fullscreen-image-modal')?.contains(target)) {
        return;
      }
      if (target.closest('.modal-root')) {
        return;
      }
      
      if (isOpen && !selfRef?.current?.contains(target)) {
        onClose();
      }
    };

    document.addEventListener('click', handleClickOutside, true);
    return () => {
      document.removeEventListener('click', handleClickOutside, true);
    };
  }, [isOpen, onClose]);

  return (<div className={`sidebar-overlay absolute inset-0 ${isOpen ? 'open' : 'pointer-events-none'}`}>
    <div className={`sidebar-container overflow-hidden absolute cg-border-xxl ${isOpen ? ' open' : ''} ${sidebarClassName || ''}`} ref={selfRef}>
      <Scrollable
        hideOnNoScroll={true}
        hideOnNoScrollDelay={500}
      >
        {children}
      </Scrollable>
    </div>
  </div>);
}

export default React.memo(SidebarContainer);
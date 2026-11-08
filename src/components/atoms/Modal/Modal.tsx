// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect, useMemo } from "react";
import './Modal.css';
import { createPortal } from "react-dom";
import Button from "../Button/Button";
import Scrollable from "components/molecules/Scrollable/Scrollable";
import { XMarkIcon } from "@heroicons/react/24/solid";

type ModalProps = {
  close?: () => void;
  headerText?: string;
  hideHeader?: boolean;
  modalInnerClassName?: string;
  closeOnClick?: boolean;
  noBackground?: boolean;
  noDefaultScrollable?: boolean;
  footerActions?: React.JSX.Element;
  modalRootStyle?: React.CSSProperties;
}

export default function Modal(props: React.PropsWithChildren<ModalProps>) {
  const portalRoot = useMemo(() => document.getElementById("modal-root-anchor") as HTMLElement, []);

  useEffect(() => {
    if (props.noBackground) return;

    portalRoot.style.backgroundColor = "rgba(0, 0, 0, 0.8)";
    portalRoot.style.right = "0";
    portalRoot.style.bottom = "0";

    return () => {
      portalRoot.style.backgroundColor = "transparent";
      portalRoot.style.right = "auto";
      portalRoot.style.bottom = "auto";
    }
  }, []);

  const handleMove = (ev: React.MouseEvent) => {
    ev.stopPropagation();
  }

  const modalClassName = [
    'modal-centered',
    `${props.modalInnerClassName ? `${props.modalInnerClassName}` : ''}`,
    `${props.hideHeader ? 'modal-no-header' : ''}`,
    !!props.footerActions ? 'w-footer' : ''
  ].join(' ').trim();

  const content = props.noDefaultScrollable ? <div className="modal-content">
    {props.children}
  </div> : <Scrollable innerClassName="modal-content">
    {props.children}
  </Scrollable>;

  return createPortal(
    <div className="modal-root" onMouseMove={handleMove} onClick={props.closeOnClick ? props.close : undefined} style={props.modalRootStyle}>
      <div
        className={modalClassName}
      >
        {!props.hideHeader && <div className="modal-header">
          {!!props.headerText && <div className="header-text">{props.headerText}</div>}
          <Button
            className="cg-circular"
            role="secondary"
            iconLeft={<XMarkIcon className='w-6 h-6' />}
            onClick={props.close}
          />
        </div>}
        {content}
        {!!props.footerActions && <div className="modal-footer">
          {props.footerActions}
        </div>}
      </div>
    </div>,
    portalRoot
  );
}
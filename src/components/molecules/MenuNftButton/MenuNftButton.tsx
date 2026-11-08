// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import Button from "../../../components/atoms/Button/Button";
import HexagonalIconButton from "../HexagonalIconButton/HexagonalIconButton";
import './MenuNftButton.css';

type Props = {
  icon: React.JSX.Element;
  onClick: () => void;
  isNFT: boolean;
  isActive?: boolean;
  className?: string;
  text?: string;
  isMobile?: boolean;
}

export default function MenuNftButton(props: Props) {
  const className = `${props.className ?? ''} ${props.isActive ? 'active' : ''}`;

  return (
    <>
      {props.isNFT && <HexagonalIconButton icon={props.icon} onClick={props.onClick} className={`menu-nft-button ${className}`} />}
      {!props.isNFT && <Button role={props.isMobile ? "borderless" : "secondary"} text={props.text} iconLeft={props.icon} onClick={props.onClick} className={`menu-non-nft-button ${className}`} />}
    </>
  );
}
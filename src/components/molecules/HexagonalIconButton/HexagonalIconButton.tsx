// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Button, { ButtonRole } from "../../../components/atoms/Button/Button";
import HexagonalIconHover from "../../atoms/icons/48/HexagonalIconHover.svg?react";
import HexagonalIcon from "../../atoms/icons/48/HexagonalIcon.svg?react";
import './HexagonalIconButton.css';

type Props = {
  text?: string;
  icon?: JSX.Element;
  onClick?: () => void;
  className?: string;
  role?: ButtonRole;
}

export default function HexagonalIconButton(props: Props) {
  return (
    <Button
      className={`hexagonal-icon-button ${props.className || ''}`}
      iconLeft={<div className="complex-icon">
        <HexagonalIconHover className="background-icon hover"/>
        <HexagonalIcon className="background-icon bgIcon"/>
        <span className="foreground-icon">
          {props.icon}
        </span>
      </div>}
      text={props.text}
      onClick={props.onClick}
      role={props.role}
    />
  );
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useRef, useState } from 'react';
import SpinnerIcon from '../../atoms/icons/16/Spinner.svg?react';

import "./Button.css";

export type ButtonRole = "primary" | "secondary" | "borderless" | "textual" | "inactive" | "admin" | "audio" | "menu" | "chip" | "destructive" | "final";

export interface ButtonProps {
  iconLeft?: JSX.Element;
  iconRight?: JSX.Element;
  text?: string | JSX.Element;
  className?: string;
  style?: React.CSSProperties;
  role?: ButtonRole;
  disabled?: boolean;
  onClick?: (ev: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseEnter?: (ev: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseLeave?: (ev: React.MouseEvent<HTMLButtonElement>) => void;
  tabIndex?: number;
  buttonRef?: React.RefObject<HTMLButtonElement>;
  loading?: boolean;
  active?: boolean;
  longPress?: boolean;
};

const Button: React.FC<ButtonProps> = ({ onClick, onMouseEnter, onMouseLeave, iconLeft, iconRight, text, role, disabled, className, style, tabIndex, buttonRef, loading, active, longPress }) => {
  const [isLongPressing, setIsLongPressing] = useState(false);
  let classNameFull: string | undefined = `${className ?? ''}${!!text ? '' : ' btnNoText'}${!!active ? ' active' : ''}${!!longPress ? ' longPress' : ''}${!!isLongPressing ? ' pressing' : ''}`;
  const longPressTimeoutRef = useRef<any>(null);

  switch (role) {
    case "primary": {
      classNameFull = `btnPrimary ${classNameFull}`;
      break;
    }
    case "secondary": {
      classNameFull = `btnSecondary ${classNameFull}`;
      break;
    }
    case "inactive": {
      classNameFull = `btnInactive ${classNameFull}`;
      break;
    }
    case "borderless": {
      classNameFull = `btnBorderless ${classNameFull}`;
      break;
    }
    case "textual": {
      classNameFull = `btnTextual ${classNameFull}`;
      break;
    }
    case "admin": {
      classNameFull = `btnAdmin ${classNameFull}`;
      break;
    }
    case "audio": {
      classNameFull = `btnAudio ${classNameFull}`;
      break;
    }
    case "menu": {
      classNameFull = `btnMenu ${classNameFull}`;
      break;
    }
    case "chip": {
      classNameFull = `btnChip ${classNameFull}`;
      break;
    }
    case "destructive": {
      classNameFull = `btnDestructive ${classNameFull}`;
      break;
    }
    case "final": {
      classNameFull = `btnFinal ${classNameFull}`;
      break;
    }
    default: {
      classNameFull = className;
      break;
    }
  }

  const cancelLongPress = useCallback(() => {
    if (longPressTimeoutRef.current !== null) {
      clearTimeout(longPressTimeoutRef.current);
      longPressTimeoutRef.current = null;
    }

    setIsLongPressing(false);
  }, []);

  const longPressStart = useCallback((ev: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (ev?.type === "click" && ev.button !== 0) {
      return;
    }

    if (longPressTimeoutRef.current === null) {
      setIsLongPressing(true);
      longPressTimeoutRef.current = setTimeout(() => {
        onClick?.(ev);
      }, 1000);
    }
  }, [disabled, onClick]);

  const btnClick = useCallback((ev: React.MouseEvent<HTMLButtonElement>) => {
    ev.currentTarget.blur();
    if (!longPress) onClick?.(ev);
  }, [longPress, onClick]);

  const btnEnter = useCallback((ev: React.MouseEvent<HTMLButtonElement>) => {
    onMouseEnter?.(ev);
  }, [onMouseEnter]);

  const btnLeave = useCallback((ev: React.MouseEvent<HTMLButtonElement>) => {
    onMouseLeave?.(ev);
    if (longPress) cancelLongPress();
  }, [cancelLongPress, longPress, onMouseLeave]);

  let content = <div className='spinner'>
    <SpinnerIcon />
  </div>;

  if (!loading) {
    content = <>
      {iconLeft && <div className="btnIconLeft">
        {iconLeft}
      </div>}
      {text && <div className="btnText">
        {text}
      </div>}
      {iconRight && <div className="btnIconRight">
        {iconRight}
      </div>}
    </>
  }

  return (
    <button
      onClick={btnClick}
      onMouseEnter={btnEnter}
      onMouseLeave={btnLeave}
      style={style}
      className={classNameFull}
      disabled={disabled || loading}
      tabIndex={tabIndex}
      ref={buttonRef}

      onMouseDown={longPress ? longPressStart : undefined}
      onTouchStart={longPress ? ev => longPressStart(ev as any) : undefined}
      onMouseUp={longPress ? cancelLongPress : undefined}
      onMouseOut={longPress ? cancelLongPress : undefined}
      onTouchEnd={longPress ? () => cancelLongPress : undefined}
      onTouchCancel={longPress ? () => cancelLongPress : undefined}
    >
      {content}
    </button>
  );
}

export default React.memo(Button);
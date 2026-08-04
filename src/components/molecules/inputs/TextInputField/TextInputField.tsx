// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect } from "react";
import Button from "../../../atoms/Button/Button";
import InlineToast, { InlineToastType } from "../../../atoms/InlineToast/InlineToast";
import "./TextInputField.css";
import EmojiPickerTooltip from "components/molecules/EmojiPickerTooltip/EmojiPickerTooltip";

type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string | React.JSX.Element;
  subLabel?: string;
  inputClassName?: string;
  labelClassName?: string;
  error?: string;
  hideErrorText?: boolean;
  disabled?: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  inlineToast?: InlineToastType;
  toastSuccessText?: string;
  forceShowToast?: true;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onKeyPress?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onFocus?: (e: React.FocusEvent<Element>) => void;
  onBlur?: (e: React.FocusEvent<Element>) => void;
  onMouseEnter?: (e: React.MouseEvent) => void;
  onMouseLeave?: (e: React.MouseEvent) => void;
  type?: React.HTMLInputTypeAttribute;
  tabIndex?: number;
  maxLetters?: number;
  autoCapitalize?: string;
  autoFocus?: boolean;
  iconLeft?: React.JSX.Element;
  iconRight?: React.JSX.Element;
  autoComplete?: string;
  name?: string;
  pattern?: string;
  backgroundColor?: string;

  showEmojiButton?: boolean;
  currentEmoji?: string;
  onEmojiPicked?: (emoji: string) => void;
}

export default function TextInputField(props: Props) {
  const { value,
    onChange,
    placeholder,
    label,
    subLabel,
    inputClassName,
    labelClassName,
    error,
    hideErrorText,
    disabled,
    type,
    inputRef,
    inlineToast,
    toastSuccessText,
    forceShowToast,
    onKeyDown,
    onKeyPress,
    onFocus,
    onBlur,
    onMouseEnter,
    onMouseLeave,
    tabIndex,
    maxLetters,
    autoCapitalize,
    iconLeft,
    iconRight,
    autoComplete,
    autoFocus,
    name,
    pattern,
    backgroundColor,
    showEmojiButton,
    currentEmoji,
    onEmojiPicked
  } = props;
  const internalInputRef = React.useRef<HTMLInputElement>(null);
  const actualInputRef = inputRef || internalInputRef;
  const isFocused = document.activeElement === actualInputRef.current;
  const showCharacterLimit = !!maxLetters && value.length >= maxLetters * 0.8;

  const thisInputClassName = [
    "input",
    inputClassName || '',
    error ? 'error' : '',
    showEmojiButton ? 'input-with-emoji' : '',
    iconLeft ? 'with-icon-left' : ''
  ].join(' ').trim();
  
  const onEmojiInput = React.useCallback((emoji: string) => {
    onEmojiPicked?.(emoji);
  }, [onEmojiPicked])

  useEffect(() => {
    if (autoFocus) {
      actualInputRef.current?.focus();
    }
  }, [actualInputRef, autoFocus]);

  let style: React.CSSProperties | undefined = undefined;
  if (backgroundColor) {
    style = { backgroundColor };
  }

  return (
    <div className="input-container">
      {!!label && <div className="flex justify-between cg-text-lg-500 mb-2 cg-text-main">
        <label className={labelClassName}>{label}</label>
        {!!showCharacterLimit && <span className="cg-text-secondary cg-text-md-400"><span className="cg-text-main">{value.length}</span>/{maxLetters}</span>}
      </div>}
      <div className="input-container-inner">
        {iconLeft && <span className="text-input-icon-left">{iconLeft}</span>}
        <input
          autoCapitalize={autoCapitalize}
          type={type || 'text'}
          className={thisInputClassName}
          value={value}
          onChange={(ev: React.ChangeEvent<HTMLInputElement>) => onChange(ev.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          ref={actualInputRef}
          onKeyDown={onKeyDown}
          onKeyPress={onKeyPress}
          onFocus={onFocus}
          onBlur={onBlur}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
          tabIndex={tabIndex}
          maxLength={maxLetters}
          autoComplete={autoComplete}
          name={name}
          style={style}
        />
        {!label && !!showCharacterLimit && <span className="cg-text-secondary cg-text-md-400"><span className="cg-text-main">{value.length}</span>/{maxLetters}</span>}
        {iconRight}
        {showEmojiButton && <div className="absolute left-2">
          <EmojiPickerTooltip        
            triggerContent={<Button className="text-input-emoji-picker" role="secondary" text={currentEmoji} />}
            onEmojiClick={onEmojiInput}
          />
        </div>}
        {((!isFocused || !!forceShowToast) && !!inlineToast) && <InlineToast type={inlineToast} successText={toastSuccessText} />}
      </div>
      {subLabel && <p className="sub-label">{subLabel}</p>}
      {error && !hideErrorText && <span className="error">{error}</span>}
    </div>
  );
}

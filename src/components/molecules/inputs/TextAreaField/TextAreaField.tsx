// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect } from 'react';
import InlineToast, { InlineToastType } from "../../../atoms/InlineToast/InlineToast";
import "./TextAreaField.css";
import useAutosizeTextArea from './useAutosizeTextArea';

type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  subLabel?: string;
  inputClassName?: string;
  labelClassName?: string;
  error?: string;
  rows?: number;
  autoGrow?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  maxLetters?: number;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  inlineToast?: InlineToastType;
  onKeyPress?: (e: React.KeyboardEvent<Element>) => void;
  onFocus?: (e: React.FocusEvent<Element>) => void;
  onBlur?: (e: React.FocusEvent<Element>) => void;
  tabIndex?: number;
}

export default function TextAreaField(props: Props) {
  const { value, onChange, placeholder, label, subLabel, inputClassName, labelClassName, error, rows, autoGrow, autoFocus, disabled, maxLetters, inputRef, inlineToast, onKeyPress, onFocus, onBlur, tabIndex } = props;
  const internalInputRef = React.useRef<HTMLTextAreaElement>(null);
  const actualInputRef = inputRef || internalInputRef;
  const showCharacterLimit = !!maxLetters && value.length >= maxLetters * 0.8;

  let thisInputClassName = "input scrollable";
  if (inputClassName) {
    thisInputClassName = thisInputClassName + " " + inputClassName;
  }
  if (autoGrow) {
    thisInputClassName += ' autogrow'
  }
  if (error) {
    thisInputClassName = thisInputClassName + " error";
  }

  const isFocused = document.activeElement === actualInputRef.current;
  useAutosizeTextArea(autoGrow ? actualInputRef : null, value);

  useEffect(() => {
    if (autoFocus) {
      actualInputRef.current?.focus();
    }
  }, [actualInputRef, autoFocus]);

  return (
    <div className="input-container">
      {label && <div className="flex justify-between cg-text-lg-500 mb-2 cg-text-main">
        <label className={labelClassName}>{label}</label>
        {!!showCharacterLimit && <span className="cg-text-secondary cg-text-md-400"><span className="cg-text-main">{value.length}</span>/{maxLetters}</span>}
      </div>}
      <div className="textarea-container">
        <textarea
          value={value}
          placeholder={placeholder}
          onChange={ev => onChange(ev.target.value)}
          className={thisInputClassName}
          ref={internalInputRef}
          rows={rows}
          disabled={disabled}
          maxLength={maxLetters}
          onKeyPress={onKeyPress}
          onFocus={onFocus}
          onBlur={onBlur}
          tabIndex={tabIndex}
        />
        {(!label && !!showCharacterLimit) && <div className='flex flex-col self-start px-1'>
          {!isFocused && <InlineToast type={inlineToast} textAreaToast noAbsolute={!!maxLetters} />}
          {!label && !!showCharacterLimit && <span className="cg-text-secondary cg-text-md-400 self-start"><span className="cg-text-main">{value.length}</span>/{maxLetters}</span>}
        </div>}
      </div>
      {subLabel && <p className="sub-label">{subLabel}</p>}
      {error && <span className="error">{error}</span>}
    </div>
  );
}
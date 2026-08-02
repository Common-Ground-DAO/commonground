// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useCallback, useEffect, useRef, useState } from "react";

import { InlineToastType } from "../../atoms/InlineToast/InlineToast";
import TextInputField from "../inputs/TextInputField/TextInputField";
import { Tooltip } from "../../atoms/Tooltip/Tooltip";
import Button from "../../../components/atoms/Button/Button";

import CloseIcon from '../../../components/atoms/icons/16/Close.svg?react';

import "./SocialLink.css";

type Props = {
  icon?: JSX.Element;
  placeholder: string;
  index: number;
  value: string;
  setValue: (value: string) => void;
  removeLink?: (index: number) => void;
  loading?: InlineToastType;
  error?: string;
}

export default function SocialLink(props: Props) {
  const { icon, placeholder, index, value, setValue, removeLink, loading, error } = props;

  const inputRef = useRef<HTMLInputElement>(null);
  const [_value, _setValue] = useState<string>(value || "");
  const [_error, setError] = useState<string>();

  useEffect(() => {
      _setValue(value || "");
  }, [value]);

  useEffect(() => {
    setError(error || "");
  }, [error]);

  useEffect(() => {
      if (_value.length > 80) {
          setError('You’ve reached the 80 character limit! Well done!');
      } else {
          setError(undefined);
      }
  }, [_value]);

  const handleKeyPress = async (e: React.KeyboardEvent<Element>) => {
    if (e.code === "Enter") {
      inputRef.current?.blur();
    }
  }

  const handleBlur = useCallback(() => {
    if (_value !== value && !error) {
      setValue(_value);
    }
  }, [_value, value, error, setValue]);

  const onClickRemoveLink = (ev: React.MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    if (removeLink) {
      removeLink(index);
    }
  };

  return (
    <div className="social-link" key={`sociallink_${index}`}>
      {icon}
      <TextInputField
        inputRef={inputRef}
        value={_value}
        onChange={_setValue}
        placeholder={placeholder}
        onKeyPress={handleKeyPress}
        onBlur={handleBlur}
        error={_error}
        inlineToast={loading}
        maxLetters={80}
        tabIndex={index * 2 + 1}
      />
      {removeLink &&
        <Tooltip
          placement="right"
          triggerContent={
            <Button
              role="secondary"
              onClick={(ev) => onClickRemoveLink(ev)}
              tabIndex={index * 2 + 2}
              iconLeft={<CloseIcon />}
            />
          }
          tooltipContent="Remove"
          offset={4}
        />
      }
    </div>
  );
}
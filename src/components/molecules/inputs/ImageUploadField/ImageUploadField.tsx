// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useRef, useState } from "react";
import './ImageUploadField.css';
import errors from "../../../../common/errors";
import CameraPlusIcon from "../../../atoms/icons/24/CameraPlusIcon.svg?react";
import ToastErrorIcon from "../../../atoms/icons/16/ToastErrorIcon.svg?react";
import Button from "../../../atoms/Button/Button";
import config from "../../../../common/config";
import { ArrowUpTrayIcon } from "@heroicons/react/20/solid";
import { checkImageBeforeUpload } from "moderation/checkImageBeforeUpload";


type Props = {
  label: string;
  subLabels?: string[];
  imageURL: string | undefined;
  onChange: (data?: File) => void;
  onRemove?: () => void;
  imagePreviewStyle?: React.CSSProperties;
}

export default function ImageUploadField(props: Props) {
  const { label, subLabels, imageURL, onChange, onRemove, imagePreviewStyle } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();

  const handleImageChange = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    // Read the file and clear the input *before* any await: `ev.target` is not
    // safe to touch afterwards, and leaving the value set would make re-picking
    // the same file after a "Cancel" in the pre-check dialog fire no change
    // event at all.
    const input = ev.target;
    const file = input.files?.[0];
    input.value = '';
    if (onChange) {
      if (!file) {
        onChange(undefined);
      } else if (file.size > config.IMAGE_UPLOAD_SIZE_LIMIT) {
        setError(errors.client.UPLOAD_SIZE_LIMIT);
      } else {
        if (!await checkImageBeforeUpload(file)) return;
        try {
          onChange(file);
          setError(undefined);
        } catch (err) {
          setError("An unknown error has occurred");
        }
      }
    }
  }

  const handleClick = () => {
    const fileInput = inputRef?.current;
    if (!!fileInput) {
      (fileInput as HTMLInputElement).value = '';
      fileInput.click();
    }
  }

  const handleRemoveImageClick = (ev: React.MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    if (onRemove) {
      onRemove();
    }
  };

  return <div className="flex flex-col gap-2">
    <div className="flex flex-col">
    <span className="cg-text-lg-500 cg-text-main">{label}</span>
    {subLabels?.map(sublabel => <span key={sublabel} className="cg-text-md-400 cg-text-secondary">{sublabel}</span>)}
    </div>
    <div className="image-upload-field-image" onClick={handleClick} style={{...imagePreviewStyle, backgroundImage: `url(${imageURL})`}}>
      <input type="file" ref={inputRef} onChange={handleImageChange} style={{ display: "none" }} accept={config.ACCEPTED_IMAGE_FORMATS} />
      {!imageURL && <ArrowUpTrayIcon className="w-5 h-5" />}
      {!!imageURL && onRemove && (
        <Button
          iconLeft={<ToastErrorIcon />}
          role="secondary"
          className="absolute top-2 right-2"
          onClick={handleRemoveImageClick}
        />
      )}
    </div>
    {error && <div className='text-red-400 header-error-msg'>{error}</div>}
  </div>
}
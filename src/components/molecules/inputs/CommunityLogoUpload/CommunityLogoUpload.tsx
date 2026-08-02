// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { createRef, useState } from "react";
import errors from "../../../../common/errors";
import CameraPlusIcon from "../../../../components/atoms/icons/24/CameraPlusIcon.svg?react";
import Button from "../../../../components/atoms/Button/Button";
import config from "../../../../common/config";
import { useWindowSizeContext } from "../../../../context/WindowSizeProvider";

import "./CommunityLogoUpload.css";

type Props = {
    imageURL: string | undefined;
    onChange: (file?: File) => void;
    className?: string;
}

export default function CommunityLogoUpload(props: Props) {
    const { imageURL, onChange, className } = props;
    const { isMobile } = useWindowSizeContext();
    const inputRef = createRef<HTMLInputElement>();
    const [ error, setError ] = useState<string>();

    const handleImageChange = (ev: React.ChangeEvent<HTMLInputElement>) => {
      if (onChange) {
        if (!ev.target.files || ev.target.files.length === 0) {
          onChange(undefined);
        } else if (ev.target.files[0].size > config.IMAGE_UPLOAD_SIZE_LIMIT) {
          setError(errors.client.UPLOAD_SIZE_LIMIT);
        } else {
          try {
            onChange(ev.target.files[0]);
            setError(undefined);
          } catch (err){
            setError("An unknown error has occurred");
          }
        }
      }
    }

    const style = imageURL ? { backgroundImage: `url(${imageURL})` } : {};

    return (
      <>
        <div
          onClick={() => inputRef?.current?.click()}
          className={`community-logo-upload ${className ? className : ""} ${!imageURL ? 'is-empty' : ''}`}
          style={style}
        >
          <Button
            iconLeft={<CameraPlusIcon />}
            role="primary"
            className='community-logo-upload-add-icon'
            text={"Logo"}
          />
          <input type="file" ref={inputRef} onChange={handleImageChange} style={{ display: "none" }} accept={config.ACCEPTED_IMAGE_FORMATS} />
        </div>
        {error && <div className='text-red-400 community-logo-error-msg'>{error}</div>}
      </>
    )
}
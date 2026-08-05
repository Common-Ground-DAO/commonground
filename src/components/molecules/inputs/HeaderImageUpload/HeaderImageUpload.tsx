// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { createRef, useState } from "react";
import errors from "../../../../common/errors";
import CameraPlusIcon from "../../../atoms/icons/24/CameraPlusIcon.svg?react";
import ToastErrorIcon from "../../../atoms/icons/16/ToastErrorIcon.svg?react";
import Button from "../../../atoms/Button/Button";
import config from "../../../../common/config";
import { checkImageBeforeUpload } from "moderation/checkImageBeforeUpload";

import "./HeaderImageUpload.css";

type Props = {
    imageURL: string | undefined;
    onChange: (data?: File) => void;
    onRemove: () => void;
    className?: string;
    readonly?: boolean;
    showGuidelines?: boolean;
}

export default function HeaderImageUpload(props: Props) {
    const { imageURL, onChange, onRemove, className, readonly } = props;
    const inputRef = createRef<HTMLInputElement>();
    const [ error, setError ] = useState<string>();

    const handleImageChange = async (ev: React.ChangeEvent<HTMLInputElement>) => {
        if (onChange) {
            if (!ev.target.files || ev.target.files.length === 0) {
                onChange(undefined);
            } else if (ev.target.files[0].size > config.IMAGE_UPLOAD_SIZE_LIMIT) {
                setError(errors.client.UPLOAD_SIZE_LIMIT);
            } else {
                // Read before awaiting: the input is reset on the next open.
                const file = ev.target.files[0];
                if (!await checkImageBeforeUpload(file)) return;
                try {
                    onChange(file);
                    setError(undefined);
                } catch (err){
                    setError("An unknown error has occurred");
                }
            }
        }
    }

    const handleClick = () => {
        if (!readonly) {
            const fileInput = inputRef?.current;
            if (!!fileInput) {
                (fileInput as HTMLInputElement).value = '';
                fileInput.click();
            }
        }
    }

    const handleRemoveImageClick = (ev: React.MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
        if (onRemove) {
            onRemove();
        }
    };

    if (!readonly || imageURL) {
        return (
            <>
                <div className={`add-image-container ${className ?? ""} ${readonly ? "" : "editable"} ${!readonly && !imageURL ? "is-empty" : ""}`} onClick={handleClick}>
                    {!!imageURL ? <img className='header-image preview' src={imageURL} alt='Header' /> : <div className="header-image empty" />}
                    {!readonly && (
                        <Button
                            text="Header"
                            iconLeft={<CameraPlusIcon />}
                            role="primary"
                        />
                    )}
                    <input type="file" ref={inputRef} onChange={handleImageChange} style={{ display: "none" }} accept={config.ACCEPTED_IMAGE_FORMATS} />
                    {!readonly && !!imageURL && (
                        <Button
                            iconLeft={<ToastErrorIcon />}
                            role="secondary"
                            className="absolute top-4 right-4"
                            onClick={handleRemoveImageClick}
                        />
                    )}
                    {props.showGuidelines && imageURL && <>
                        <div className="image-ratio-guide ratio-1-1">1:1</div>
                        <div className="image-ratio-guide ratio-16-9">16:9</div>
                    </>}
                </div>
                {error && <div className='text-red-400 header-error-msg'>{error}</div>}
            </>
        );
    } else {
        return null;
    }
}
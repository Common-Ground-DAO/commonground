// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import "./RolePhoto.css";
import React, { createRef, useState } from "react";
import fileApi from "data/api/file";
import errors from "../../../common/errors";
import config from "../../../common/config";
import { checkImageBeforeUpload } from "moderation/checkImageBeforeUpload";
import { isImageContentRejected } from "moderation/imageUploadError";
import { useSignedUrl } from "hooks/useSignedUrl";
import { UserCircle } from "@phosphor-icons/react";

type Props = {
  communityId: string;
  roleId: string;
  imageId: string | null;
  setImageId?: (imageId: string | null) => void;
  editMode?: boolean;
  small?: boolean;
  tiny?: boolean;
}

const RolePhoto: React.FC<Props> = (props: Props) => {
  const { roleId, communityId, imageId, setImageId, editMode, small, tiny } = props;
  const imgUrl = useSignedUrl(imageId);

  const [error, setError] = useState<string>();
  const imageUploadRef = createRef<HTMLInputElement>();

  const handleImageChange = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    ev.stopPropagation();
    if (ev.target.files && ev.target.files.length === 1) {
      if (ev.target.files[0].size > config.IMAGE_UPLOAD_SIZE_LIMIT) {
        setError(errors.client.UPLOAD_SIZE_LIMIT);
      } else {
        // Read before awaiting: the input is reset on the next open.
        const file = ev.target.files[0];
        if (!await checkImageBeforeUpload(file)) return;
        try {
          const result = await fileApi.uploadImage({ type: 'roleImage', roleId, communityId }, file);
          setImageId?.(result.imageId);
          setError(undefined);
        } catch (err) {
          console.error(err);
          setError(isImageContentRejected(err)
            ? errors.client.IMAGE_CONTENT_REJECTED
            : "An unknown error has occurred");
        }
      }
    }
  }

  const openLoadImagePopup = (ev: React.MouseEvent) => {
    if (editMode && imageUploadRef && imageUploadRef.current) {
      ev.stopPropagation();
      imageUploadRef.current.click();
    }
  }

  const className = [
    'role-photo',
    `${editMode ? 'edit-mode' : ''}`,
    `${small ? 'small' : ''}`,
    `${tiny ? 'tiny' : ''}`,
  ].join(' ').trim();

  return (
    <>
      <div className={className} style={{ backgroundImage: `url(${imgUrl})`}} onClick={openLoadImagePopup}>
        {editMode && <input type="file" ref={imageUploadRef} onChange={handleImageChange} style={{ display: "none" }} accept={config.ACCEPTED_IMAGE_FORMATS} />}
        {!imgUrl && <UserCircle weight="duotone" className="w-6 h-6" />}
      </div>
      {error && <div className='text-red-400 header-error-msg'>{error}</div>}
    </>
  )
}

export default React.memo(RolePhoto);

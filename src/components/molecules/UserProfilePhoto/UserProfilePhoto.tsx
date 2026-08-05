// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { createRef, useState } from "react";
import CameraPlusIcon from "../../../components/atoms/icons/24/CameraPlusIcon.svg?react";
import fileApi from "data/api/file";
import errors from "../../../common/errors";
import Jdenticon from "../../../components/atoms/Jdenticon/Jdenticon";
import Button from "../../../components/atoms/Button/Button";
import config from "../../../common/config";
import { checkImageBeforeUpload } from "moderation/checkImageBeforeUpload";
import { isImageContentRejected } from "moderation/imageUploadError";
import { useNavigate } from "react-router-dom";
import { getUrl } from 'common/util';

import "./UserProfilePhoto.css";
import { useUserData } from "context/UserDataProvider";
import { useUserPremiumTier } from "hooks/usePremiumTier";
import SupporterIcon from "components/atoms/SupporterIcon/SupporterIcon";

type Props = {
  userId: string;
  editMode?: boolean;
}

export default function UserProfilePhoto(props: Props) {
  const { userId, editMode } = props;
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const user = useUserData(userId);
  const premiumTier = useUserPremiumTier(user);

  const imageUploadRef = createRef<HTMLInputElement>();

  const handleImageChange = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    ev.stopPropagation();
    // Read the file and clear the input *before* any await: `ev.target` is not
    // safe to touch afterwards, and leaving the value set would make re-picking
    // the same file after a "Cancel" in the pre-check dialog fire no change
    // event at all.
    const input = ev.target;
    const files = input.files;
    const file = files && files.length === 1 ? files[0] : undefined;
    input.value = '';
    if (file) {
      if (file.size > config.IMAGE_UPLOAD_SIZE_LIMIT) {
        setError(errors.client.UPLOAD_SIZE_LIMIT);
      } else {
        if (!await checkImageBeforeUpload(file)) return;
        try {
          await fileApi.uploadImage({ type: 'userProfileImage' }, file);
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

  const moveToProfile = (ev: React.MouseEvent) => {
    if (user && !editMode) {
      ev.stopPropagation();
      navigate(getUrl({ type: 'user', user }));
    }
  }

  return (
    <>
      <div className={`user-profile-photo-with-blurred-background ${editMode ? '' : 'cursor-pointer'}`} onClick={moveToProfile}>
        <div className="blurred-background"><Jdenticon userId={userId} /></div>
        <div className={`user-photo ${editMode ? 'edit-mode' : ''}`} onClick={openLoadImagePopup}>
          <Jdenticon userId={userId} hideStatus />
          {editMode &&
            <Button
              iconLeft={<CameraPlusIcon />}
              role="primary"
              className='plus-icon'
            />}
          {editMode && <input type="file" ref={imageUploadRef} onChange={handleImageChange} style={{ display: "none" }} accept={config.ACCEPTED_IMAGE_FORMATS} />}
          {premiumTier.type !== 'free' && <div className="absolute -bottom-3 -right-3 w-fit h-fit">
            <SupporterIcon type={premiumTier.type} size={48} redirectToSupporterPurchase />
          </div>}
        </div>
      </div>
      {error && <div className='text-red-400 header-error-msg'>{error}</div>}
    </>
  )
}
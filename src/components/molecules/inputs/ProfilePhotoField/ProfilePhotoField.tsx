// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { ArrowUpTrayIcon, PhotoIcon } from '@heroicons/react/20/solid';
import React, { createRef, useMemo, useState } from 'react'
import Button from 'components/atoms/Button/Button';
import config from 'common/config';
import errors from 'common/errors';

import './ProfilePhotoField.css';
import { XCircleIcon } from '@heroicons/react/24/solid';

type Props = {
  currentFile: File |undefined;
  setFile: (file: File | undefined) => void;
  originalFileUrl?: string;
  extraElement?: React.JSX.Element;
};

const ProfilePhotoField: React.FC<Props> = (props) => {
  const { currentFile, setFile, originalFileUrl, extraElement } = props;
  const [error, setError] = useState<string>();
  const fileUrl = useMemo(() => currentFile ? URL.createObjectURL(currentFile) : originalFileUrl || '', [currentFile, originalFileUrl]);

  const imageUploadRef = createRef<HTMLInputElement>();

  const handleImageChange = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    ev.stopPropagation();
    if (ev.target.files && ev.target.files.length === 1) {
      if (ev.target.files[0].size > config.IMAGE_UPLOAD_SIZE_LIMIT) {
        setError(errors.client.UPLOAD_SIZE_LIMIT);
      } else {
        setFile(ev.target.files[0]);
      }
    }
  }

  const openLoadImagePopup = (ev: React.MouseEvent) => {
    if (imageUploadRef.current) {
      ev.stopPropagation();
      imageUploadRef.current.click();
    }
  }

  return (
    <div className='flex flex-col gap-1'>
      <div className='flex gap-4'>
        <div className='profile-photo-preview' onClick={openLoadImagePopup} style={{ backgroundImage: `url(${fileUrl})` }} >
          {!currentFile && !originalFileUrl && <ArrowUpTrayIcon className='w-5 h-5' />}
          {currentFile && <XCircleIcon className='absolute w-6 h-6 top-0 right-0 cg-text-warning' onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setFile(undefined);
          }}/>}
          {extraElement}
        </div>
        <div className='flex flex-col gap-2 justify-center'>
          <span className='cg-text-lg-500'>Profile picture</span>
          <span className='cg-text-secondary cg-text-md-400'>PNG, JPEG, under 5MB</span>
          <input type="file" ref={imageUploadRef} onChange={handleImageChange} style={{ display: "none" }} accept={config.ACCEPTED_IMAGE_FORMATS} />
        </div>
      </div>
      {error && <div className='error'>{error}</div>}
    </div>
  )
}

export default React.memo(ProfilePhotoField);
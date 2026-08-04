// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useRef, useState } from 'react'
import Dropdown from '../../../molecules/Dropdown/Dropdown';
import { InMemoryAttachment } from '../useAttachments/useAttachments';
import AddIcon from '../../../../components/atoms/icons/16/Add.svg?react';
import PcIcon from '../../../../components/atoms/icons/24/PcIcon.svg?react';
import DropdownItem from '../../../atoms/ListItem/ListItem';
import { addFiles } from './AttachmentDropdown.helpers';
import config from 'common/config';

import './AttachmentDropdown.css';

type Props = {
  setAttachments: React.Dispatch<React.SetStateAction<InMemoryAttachment[]>>;
  setAttachmentError: (error: string) => void;
  setLockFocus: (lockFocus: boolean) => void;
  onPick: () => void;
  attachmentLimit: number;
}

const AttachmentDropdown: React.FC<Props> = ({ setAttachments, setAttachmentError, setLockFocus, onPick, attachmentLimit }) => {
  const inputFileRef = useRef<HTMLInputElement>(null);
  const [isOpen, setOpen] = useState(false);

  const handleChatMediaChange = React.useCallback((ev: React.ChangeEvent<HTMLInputElement>) => {
    setTimeout(() => {
      setLockFocus(false);
      onPick();
    }, 10);
    if (!ev.target.files || ev.target.files.length === 0) {
      return;
    }

    const files = Array.from(ev.target.files);
    addFiles(setAttachments, setAttachmentError, files, attachmentLimit);

    ev.target.value = '';
  }, [attachmentLimit, onPick, setAttachmentError, setAttachments, setLockFocus]);

  const onUploadImageClick = React.useCallback(() => {
    if (inputFileRef.current) { 
      setLockFocus(true);
      inputFileRef.current.click();
    }
  }, [inputFileRef, setLockFocus]);

  return (
    <div className={`message-field-control${isOpen ? ' selected' : ''}`}>
      <input
        type="file"
        accept={config.ACCEPTED_IMAGE_FORMATS}
        multiple={true}
        name="image-uploader"
        ref={inputFileRef}
        onChange={handleChatMediaChange}
        style={{ display: "none" }}
      />
      <Dropdown
        onOpen={() => setOpen(true)}
        onClose={() => setOpen(false)}
        triggerContent={
          <button className="message-field-attachment-button" >
            <AddIcon className="message-field-control-icon" />
          </button>
        }
        className='attachmentDropdown'
        items={[<DropdownItem key="image" title='Upload images' icon={<PcIcon />} onClick={onUploadImageClick} />]}
        placement="top-start"
        title='Attachments'
      />
    </div>
  )
}

export default React.memo(AttachmentDropdown);
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useRef } from 'react'
import Dropdown from '../../../molecules/Dropdown/Dropdown';
import DropdownItem from '../../../atoms/ListItem/ListItem';
import AddIcon from '../../../atoms/icons/24/AddCircle.svg?react';
import PcIcon from '../../../atoms/icons/24/PcIcon.svg?react';
import VideoIcon from '../../../atoms/icons/24/VideoIcon.svg?react';
import Button from '../../../atoms/Button/Button';
import EmbedModal from '../EmbedModal/EmbedModal';
import { createTranslator } from 'short-uuid';
import { ReactEditor, useSlate } from 'slate-react';
import { Editor, Transforms } from 'slate';
import { isCurrentNodeEmptyParagraph } from '../EditField.helpers';
import config from 'common/config';
import { checkImageBeforeUpload } from 'moderation/checkImageBeforeUpload';

import './MediaPickerDropdown.css';

type Props = {

};

const randomIdGen = createTranslator();

/**
 * Async since the NSFW pre-check: a file the user declines in the confirmation
 * dialog never becomes an image node, so it never reaches the upload.
 */
export async function addImageMedia(editor: Editor, file: File) {
  if (!await checkImageBeforeUpload(file)) return;

  const elementId = randomIdGen.generate();

  if (isCurrentNodeEmptyParagraph(editor)) {
    Transforms.setNodes(editor, { type: 'image', children: [{ text: '' }], id: elementId, fileCandidate: file, imageId: '', largeImageId: '', caption: '', size: 'medium' });
    Transforms.insertNodes(editor, { type: 'paragraph', children: [{ text: '' }] });
  } else {
    Transforms.insertNodes(editor, { type: 'image', children: [{ text: '' }], id: elementId, fileCandidate: file, imageId: '', largeImageId: '', caption: '', size: 'medium' });
  }
  ReactEditor.focus(editor);
}

const MediaPickerDropdown: React.FC<Props> = (props) => {
  const editor = useSlate();
  const inputFileRef = useRef<HTMLInputElement>(null);
  const [showEmbedModal, setShowEmbedModal] = React.useState(false);

  const handleMediaChange = React.useCallback(async (ev: React.ChangeEvent<HTMLInputElement>) => {
    setTimeout(() => ReactEditor.focus(editor), 10);
    if (!ev.target.files || ev.target.files.length === 0) {
      return;
    }

    // Creates node with file candidate, node will try to load  and validate image by itself
    const file = ev.target.files[0];
    await addImageMedia(editor, file);
  }, [editor]);

  const openMediaPicker = React.useCallback(() => {
    if (inputFileRef.current) inputFileRef.current.click();
  }, [inputFileRef]);

  return (
    <>
      <input
        type="file"
        accept={config.ACCEPTED_IMAGE_FORMATS}
        name="image-uploader"
        ref={inputFileRef}
        onChange={handleMediaChange}
        style={{ display: "none" }}
      />
      <Dropdown
        title='Attachments'
        triggerContent={<Button iconLeft={<AddIcon />} role='secondary' tabIndex={-1}/>}
        items={[
          <DropdownItem key='Upload image' icon={<PcIcon />} title='Upload Image' onClick={openMediaPicker} />,
          <DropdownItem key='Embed Youtube Video' icon={<VideoIcon />} title='Embed Youtube Video' onClick={() => setShowEmbedModal(true)} />
        ]}
        className='mediaPickerDropdown'
        placement='top-start'
      />
      {showEmbedModal && <EmbedModal closeModal={() => setShowEmbedModal(false)} />}
    </>
  )
}

export default React.memo(MediaPickerDropdown);

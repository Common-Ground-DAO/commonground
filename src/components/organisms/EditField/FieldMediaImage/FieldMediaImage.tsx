// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Button from '../../../atoms/Button/Button';
import { Popover } from '../../../atoms/Tooltip/Tooltip';
import { useSignedUrl } from '../../../../hooks/useSignedUrl';
import React from 'react'
import { Transforms } from 'slate';
import { RenderElementProps, useFocused, useSelected, useSlate } from 'slate-react';
import { ImageElement } from '../EditField.helpers';
import CameraPlusIcon from "../../../atoms/icons/24/CameraPlusIcon.svg?react";
import { matchNodeRule, validateAndUpdateImage } from './FieldMediaImage.projections';
import MediaControl from '../MediaControl/MediaControl';
import Tag from '../../../atoms/Tag/Tag';
import config from 'common/config';
import { checkImageBeforeUpload } from 'moderation/checkImageBeforeUpload';

import './FieldMediaImage.css';
import { Spinner } from '@phosphor-icons/react';

const FieldMediaImage: React.FC<RenderElementProps & { element: ImageElement }> = (props) => {
  const editor = useSlate();
  const selected = useSelected({ suppressThrow: true });
  const focused = useFocused();

  const imageUrl = useSignedUrl(props.element.imageId);
  const [error, setError] = React.useState<string | undefined>(undefined);

  const mediaInputRef = React.useRef<HTMLInputElement>(null);
  const captionInputRef = React.useRef<HTMLTextAreaElement>(null);

  // Load file candidate if existing
  React.useEffect(() => {
    const validateImage = async () => {
      if (props.element.fileCandidate) {
        const errorResult = await validateAndUpdateImage(editor, props.element.fileCandidate, props.element.id);
        setError(errorResult);
      }
    }

    validateImage();
  }, [editor, props.element.fileCandidate, props.element.id])

  const updateSize = React.useCallback((size: Common.Content.MediaSize) => {
    Transforms.setNodes(editor, { size }, {
      match: matchNodeRule(props.element.id),
      at: []
    });
  }, [editor, props.element.id])

  const removeNode = React.useCallback(() => {
    Transforms.removeNodes(editor, {
      match: matchNodeRule(props.element.id),
      at: []
    });
  }, [editor, props.element.id]);

  // "Replace" is a `File` entering upload state just like the insert path in
  // `addImageMedia`, so it goes through the same NSFW pre-check. Read the file
  // and clear the input before the first await: `ev.target` is not safe to
  // touch afterwards, and leaving the value set would make re-picking the same
  // file after a "Cancel" in the dialog fire no change event at all.
  const handleMediaUpdate = React.useCallback(async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const input = ev.target;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    if (!await checkImageBeforeUpload(file)) return;

    const errorResult = await validateAndUpdateImage(editor, file, props.element.id);
    setError(errorResult);
  }, [editor, props]);

  const updateCaption = React.useCallback(() => {
    const captionInput = captionInputRef.current;
    if (captionInput) {
      Transforms.setNodes(editor, { caption: captionInput.value }, {
        match: matchNodeRule(props.element.id),
        at: []
      });
    }
  }, [editor, props]);

  const size = props.element.size;
  return (
    <div {...props.attributes} contentEditable={false} className='mediaElement fieldMedia' style={{
      boxShadow: selected && focused ? '0 0 0 1px #BABABA' : 'none',
    }}>
      <input type="file" ref={mediaInputRef} onChange={handleMediaUpdate} style={{ display: "none" }} accept={config.ACCEPTED_IMAGE_FORMATS} />
      <Popover
        triggerContent={
          <>
            <div className='fieldMediaImageContainer'>
              {imageUrl && <img className='fieldMediaImage' src={imageUrl} alt={imageUrl} />}
              {!imageUrl && <div className='fieldMediaLoading'><Spinner className="spinner" /></div>}
              <Button
                text="Replace"
                iconLeft={<CameraPlusIcon />}
                role="primary"
                onClick={() => mediaInputRef.current?.click()}
              />
              {error && <div className='infoTagContainer' >
                <Tag label={error || ""} variant='error' />
              </div>}
            </div>
            <textarea rows={2} ref={captionInputRef} key={props.element.caption || 'caption-default-key'} placeholder='Add a caption...' className='captionInput' defaultValue={props.element.caption} onBlur={updateCaption} />
          </>
        }
        triggerClassName={`fieldMediaContent ${size}`}
        tooltipClassName="fieldMediaControl"
        tooltipContent={<MediaControl currSize={size} onRemoveNode={removeNode} onUpdateSize={updateSize} />}
        placement="top"
        triggerType="hover"
        closeOn="mouseleaveTriggerAndPopover"
        offset={-24}
        disableFlip={true}
        dismissOnScroll
      />
      {props.children}
    </div>
  );
}

export default React.memo(FieldMediaImage);
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import './MediaAttachment.css';
import { InMemoryAttachment } from 'components/organisms/EditField/useAttachments/useAttachments';
import CloseIcon from '../../../components/atoms/icons/16/Close.svg?react';
import { useSignedUrl } from '../../../hooks/useSignedUrl';
import { Popover } from '../../../components/atoms/Tooltip/Tooltip';
import FullscreenImageModal from '../../../components/atoms/FullscreenImageModal/FullscreenImageModal';
import config from '../../../common/config';
import fileApi from 'data/api/file';
import { imageUploadErrorText, notifyIfImageRejected } from 'moderation/imageUploadError';
import { Spinner } from '@phosphor-icons/react';

type Props = InMemoryAttachment & {
  updateAttachment: (imageId: string, largeImageId: string) => void;
  removeAttachment: () => void;
  setIsLoadedState: (imageId: string, state: boolean) => void;
};

type UploadImageResult = {
  ok: false,
  /** The server refused the image; the shared modal has already said so. */
  rejected?: true,
  error?: string
} | {
  ok: true,
  imageId: string,
  largeImageId: string
}

async function uploadImage(file: File): Promise<UploadImageResult> {
  if (file.size > config.IMAGE_UPLOAD_SIZE_LIMIT) {
    // derived from the limit rather than written out — the hardcoded "5MB" here
    // had been wrong since the limit moved to 8 MB
    return { ok: false, error: `Images must have at most ${config.IMAGE_UPLOAD_SIZE_LIMIT / (1024 * 1024)}MB in size` };
  } else {
    try {
      // Upload, get image id
      const { imageId, largeImageId } = await fileApi.uploadImage({
        type: "channelAttachmentImage",
      }, file);
      return { ok: true, imageId, largeImageId };
    } catch (err: any) {
      // A rejection is final: the tile gets removed rather than parked in the
      // error state, so no `error` text is returned for it.
      if (notifyIfImageRejected(err)) return { ok: false, rejected: true };
      return { ok: false, error: imageUploadErrorText(err, 'An unknown error has occurred, please try again') };
    }
  }
}


const AttachmentButton: React.FC<Props> = (props) => {
  const [requestStarted, setRequestStarted] = React.useState(false);
  const [error, setError] = React.useState('');
  const [showPreview, setShowPreview] = React.useState(false);
  const closeButtonRef = React.useRef<HTMLDivElement>(null);

  // Don't get imageId if there's no largeImageId.
  // No largeImageId -> still using filename for imageId
  const imageId = props.type === 'image' && props.largeImageId ? props.imageId : undefined;
  const imageUrl = useSignedUrl(imageId);

  const { updateAttachment, setIsLoadedState } = props;

  // `removeAttachment` is rebuilt on every render of `EditField` (it closes
  // over `setAttachments` and the imageId), so it is read through a ref: the
  // upload effect below must not restart because the parent re-rendered.
  const removeAttachmentRef = React.useRef(props.removeAttachment);
  React.useEffect(() => {
    removeAttachmentRef.current = props.removeAttachment;
  });

  // The upload outlives this component whenever the user hits "Remove" (or
  // sends) while it is in flight. Set on mount rather than at declaration so a
  // StrictMode remount flips it back to `true`.
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  React.useEffect(() => {
    // `precheckPending` means the NSFW pre-check has not answered for this file
    // yet — the tile is already on screen (spinner and all), but uploading now
    // would defeat the point of asking. `addFiles` either clears the flag, at
    // which point this effect runs again and uploads, or removes the
    // attachment altogether.
    if (!requestStarted && !props.precheckPending) {
      setRequestStarted(true);

      const uploadFunc = async (file: File) => {
        const result = await uploadImage(file);
        if (result.ok) {
          updateAttachment(result.imageId, result.largeImageId);
          if (mountedRef.current) setError('');
        } else if (result.rejected) {
          // The modal is up; the tile itself goes away instead of staying in
          // the composer as an error thumbnail the user has to hover to
          // understand and then remove by hand. Removing is a `setAttachments`
          // call on the *parent*, so it is safe from here even though it
          // unmounts this component — and it is a no-op if the attachment is
          // already gone.
          removeAttachmentRef.current();
        } else if (mountedRef.current) {
          setError(result.error || '');
        }
      }

      if (props.tentativeFile) {
        uploadFunc(props.tentativeFile);
      }
    }
  }, [updateAttachment, props.tentativeFile, props.precheckPending, requestStarted]);

  const fileUrl = React.useMemo(() => {
    if (props.tentativeFile) {
      return window.URL.createObjectURL(props.tentativeFile);
    }
  }, [props.tentativeFile])

  const currentImageUrl = imageUrl || fileUrl || '';

  const isLoaded = React.useMemo(() => {
    return !!error || !!imageUrl;
  }, [error, imageUrl]);

  React.useEffect(() => {
    if (imageId) setIsLoadedState(imageId, isLoaded);
  }, [imageId, isLoaded, setIsLoadedState]);

  let attachmentImage = <div className='inputMediaAttachmentImage' style={{ backgroundImage: `url(${currentImageUrl})` }} onClick={() => setShowPreview(true)} />;
  if (error) {
    attachmentImage = <Popover
      triggerContent={attachmentImage}
      placement='top'
      tooltipContent={error}
      triggerType="hover"
      closeOn='mouseleaveTrigger'
      triggerClassName='w-full h-full'
      tooltipClassName='mediaAttachmentTooltip'
      offset={15}
    />
  }

  return (
    <div className={`inputMediaAttachment ${error ? 'error' : ''}`}>
      {!isLoaded && <>
        <div className='loadingOverlay' />
        <Spinner className="spinner" />
      </>}
      {attachmentImage}
      <FullscreenImageModal open={showPreview} images={[{url: fileUrl}]} close={() => setShowPreview(false)} />
      {isLoaded && <div ref={closeButtonRef} role="button" className='attachmentCloseButton' onClick={props.removeAttachment}>
        <div className='attachmentCloseButtonInternal'>
          <CloseIcon />
          <span>Remove</span>
        </div>
      </div>}
    </div>
  );
}

export default React.memo(AttachmentButton);
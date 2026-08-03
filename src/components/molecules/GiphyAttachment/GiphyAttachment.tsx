// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import './GiphyAttachment.css';
import { InMemoryAttachment } from 'components/organisms/EditField/useAttachments/useAttachments';
import CloseIcon from '../../../components/atoms/icons/16/Close.svg?react';
import { useAsyncMemo } from 'hooks/useAsyncMemo';
import { gf } from 'util/giphy';
import { Gif } from '@giphy/react-components';
import FullscreenImageModal from 'components/atoms/FullscreenImageModal/FullscreenImageModal';

type Props = InMemoryAttachment & {
  removeAttachment: () => void;
};

const GiphyAttachment: React.FC<Props> = (props) => {
  const [showPreview, setShowPreview] = React.useState(false);

  const giphyGif = useAsyncMemo(async () => {
    if (props.giphyGif) return props.giphyGif;
    else if (props.type === 'giphy') {
      const response = await gf.gif(props.gifId);
      return response.data;
    }
  }, [props.type, props.giphyGif]);

  return (
    <div className={`giphyAttachment`}>
      {giphyGif && <Gif
        onGifClick={() => setShowPreview(true)}
        gif={giphyGif}
        width={50}
        style={{height: '100%', display: 'flex'}}
        hideAttribution
        noLink
        className='items-center'
      />}
      <FullscreenImageModal open={showPreview} images={[{url: giphyGif?.images.original.url}]} close={() => setShowPreview(false)} />
      <div role="button" className='attachmentCloseButton' onClick={props.removeAttachment}>
        <div className='attachmentCloseButtonInternal'>
          <CloseIcon />
          <span>Remove</span>
        </div>
      </div>
    </div>
  );
}

export default React.memo(GiphyAttachment);
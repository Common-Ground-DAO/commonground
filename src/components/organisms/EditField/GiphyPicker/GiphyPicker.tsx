// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useMemo, useRef, useState } from 'react';
import './GiphyPicker.css';
import { Grid } from '@giphy/react-components';
import { PopoverHandle } from 'components/atoms/Tooltip/Tooltip';
import { GifIcon } from '@heroicons/react/24/solid';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import { MagnifyingGlassIcon } from '@heroicons/react/20/solid';
import { debounce } from '../../../../util';
import giphyLogoLightmode from './giphyLogoLightmode.png';
import giphyLogoDarkmode from './giphyLogoDarkmode.png';
import { useDarkModeContext } from 'context/DarkModeProvider';
import { InMemoryAttachment } from '../useAttachments/useAttachments';
import { gf } from 'util/giphy';
import { IGif } from '@giphy/js-types';
import ScreenAwarePopover from 'components/atoms/ScreenAwarePopover/ScreenAwarePopover';
import { useWindowSizeContext } from 'context/WindowSizeProvider';

// fetch 10 gifs at a time as the user scrolls (offset is handled by the grid)
// if this function changes, change the Grid key to recreate the grid and start over
// see the codesandbox for a runnable example

type Props = {
  setAttachments: React.Dispatch<React.SetStateAction<InMemoryAttachment[]>>;
  setAttachmentError: (error: string) => void;
  setLockFocus: (lockFocus: boolean) => void;
  onPick: () => void;
  attachmentLimit: number;
};

const GiphyPicker: React.FC<Props> = (props) => {
  const { setAttachments, setAttachmentError, setLockFocus, onPick } = props;
  const { isMobile } = useWindowSizeContext();
  const [isOpen, _setOpen] = useState(false);
  const [searchInputValue, _setSearchInputValue] = useState('');
  const [searchTerm, _setSearchTerm] = useState('');
  const { isDarkMode } = useDarkModeContext();
  const textInputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<PopoverHandle>(null);

  const setSearchTermDebounced = useMemo(() => {
    return debounce(_setSearchTerm, 1000);
  }, []);

  const setSearchTerm = useCallback((value: string) => {
    _setSearchInputValue(value);
    setSearchTermDebounced(value);
  }, [setSearchTermDebounced]);

  const fetchGifs = (offset: number) => {
    // `rating: 'g'` explicitly rather than relying on the Giphy API default:
    // GIFs are never stored server-side (the client loads them straight from
    // the Giphy CDN), so they cannot pass through the image filter and this
    // rating is the only content control on them.
    if (searchTerm) return gf.search(searchTerm, { offset, limit: 10, rating: 'g' })
    else return gf.trending({ offset, limit: 10, rating: 'g' });
  };

  const setOpen = useCallback((open: boolean) => {
    setLockFocus(open);
    _setOpen(open);
    if (open) {
      setTimeout(() => textInputRef.current?.focus(), 10);
    }
  }, [setLockFocus]);

  const addAttachment = (gif: IGif) => {
    const newAttachment: InMemoryAttachment = {
      type: 'giphy',
      gifId: gif.id as string,
      giphyGif: gif,
    }
    setAttachments(oldAttachments => {
      const attachmentList = [...oldAttachments, newAttachment];
      if (attachmentList.length > props.attachmentLimit) {
        setAttachmentError(`Whoa there, only ${props.attachmentLimit} attachments allowed at once 😳`);
      }
      return attachmentList.slice(0, props.attachmentLimit);
    });
  }

  return (
    <div className={`message-field-control${isOpen ? ' selected' : ''}`}>
      <ScreenAwarePopover
        ref={popoverRef}
        noDefaultScrollable
        triggerType='click'
        closeOn='toggle'
        onOpen={() => setOpen(true)}
        onClose={() => setOpen(false)}
        triggerContent={<button className="message-field-attachment-button" >
          <GifIcon className="message-field-control-icon" />
        </button>}
        placement="top-start"
        tooltipContent={<div className='giphy-picker'>
          <div className={isMobile ? 'px-2' : undefined}>
            <TextInputField
              placeholder='Search'
              inputRef={textInputRef}
              value={searchInputValue}
              onChange={setSearchTerm}
              iconLeft={<MagnifyingGlassIcon className='w-5 h-5' />}
            />
          </div>
          {isDarkMode && <img src={giphyLogoDarkmode} style={{ marginLeft: 'auto', height: '16px' }} alt='giphy' />}
          {!isDarkMode && <img src={giphyLogoLightmode} style={{ marginLeft: 'auto', height: '16px' }} alt='giphy' />}
          <Grid
            width={isMobile ? (window.innerWidth - 46) : Math.min(440, window.innerWidth) - 40}
            className='giphy-grid self-center'
            columns={3}
            gutter={6}
            fetchGifs={fetchGifs}
            key={searchTerm}
            hideAttribution
            onGifClick={(gif, e) => {
              e.preventDefault();
              addAttachment(gif);
              setSearchTerm('');
              popoverRef.current?.close();
              setTimeout(onPick, 1);
            }}
          />
        </div>}
      />
    </div>
  )
}

export default GiphyPicker;
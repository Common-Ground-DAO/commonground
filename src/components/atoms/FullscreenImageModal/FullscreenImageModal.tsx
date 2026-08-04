// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useMemo } from 'react'
import Lightbox, { SlideImage } from "yet-another-react-lightbox";
import Thumbnails from "yet-another-react-lightbox/plugins/thumbnails";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import { useWindowSizeContext } from '../../../context/WindowSizeProvider';

import "yet-another-react-lightbox/styles.css";
import "yet-another-react-lightbox/plugins/thumbnails.css";

import './FullscreenImageModal.css';
import { useSignedUrls } from 'hooks/useSignedUrl';

type ModalImage = { id?: string; url?: string};

type Props = {
  open: boolean;
  close: () => void;
  images: ModalImage[];
  selectedIndex?: number;
}

export const FullscreenImageModal: React.FC<Props> = (props) => {
  if (props.open) {
    return <InnerComponent {...props} />;
  }
  else {
    return null;
  }
}

const InnerComponent: React.FC<Props> = (props) => {
  const { isMobile } = useWindowSizeContext();

  const imageIds = useMemo(() => {
    return props.images.map(image => image.id).filter(id => !!id) as string[];
  }, [props.images]);
  const signedUrls = useSignedUrls(imageIds);
  const signedUrlsMap = useMemo(() => {
    const result = new Map<string, string>();
    for (let i = 0; i < imageIds.length; i++) {
      const signedUrl = signedUrls[i];
      if (signedUrl) {
        result.set(imageIds[i], signedUrl);
      }
    }
    return result;
  }, [signedUrls, imageIds.length]);

  const imageUrls = useMemo(() => {
    const result: string[] = [];
    for (const image of props.images) {
      if (image.url) {
        result.push(image.url);
      } else if (image.id) {
        result.push(signedUrlsMap.get(image.id) || '');
      }
    }
    return result;
  }, [props.images, signedUrlsMap]);

  const slides: SlideImage[] = imageUrls.map(url => ({
    src: url,
  }));

  const plugins = React.useMemo(() => {
    if (slides.length > 1) return [Thumbnails, Zoom];
    else return [Zoom];
  }, [slides]);

  return <Lightbox
    className='fullscreen-image-modal'
    open={props.open}
    close={props.close}
    slides={slides}
    index={props.selectedIndex ?? 0}
    plugins={plugins}
    carousel={{
      finite: true,
      preload: 3,
      // v3 narrowed `carousel.padding` from a CSS shorthand string to a single
      // `LengthOrPercentage` applied on all four sides, so the desktop
      // `'2% 5%'` (2% vertical / 5% horizontal) has to collapse to one value.
      // `'2%'` is the side that must not grow: CSS percentage padding resolves
      // against the container *width*, so keeping 5% would have turned a 38px
      // top/bottom gutter on a 1920px viewport into 96px and shrunk the image.
      // Taking 2% instead only widens the picture horizontally.
      padding: isMobile ? '5%' : '2%'
    }}
    controller={{
      closeOnBackdropClick: true
    }}
    animation={{
      swipe: 300,
      zoom: 300,
      fade: 100
    }}
    thumbnails={{
      position: 'bottom',
      border: 0,
    }}
    render={{
      buttonPrev: slides.length > 1 ? undefined : () => null,
      buttonNext: slides.length > 1 ? undefined : () => null
    }}
  />
}

export default React.memo(FullscreenImageModal);

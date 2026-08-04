// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import { useNavigate } from "react-router-dom";
import { useWindowSizeContext } from "../../../context/WindowSizeProvider";

import Button from "../../../components/atoms/Button/Button";
import ArrowLeftIcon from '../../../components/atoms/icons/24/ArrowLeft.svg?react';

import "./HorizontalCardSlider.css";
import { getUrl } from 'common/util';

export type PositionData = {
  isLeft: boolean;
  isRight: boolean;
};

type Props = {
  mode: 'limited' | 'unlimited';
  title?: React.JSX.Element;
  className?: string;
  positionCallback?: (data: PositionData) => void;
}

export default function HorizontalCardSlider(props: React.PropsWithChildren<Props>) {
  const { mode, title, className, positionCallback, children } = props;
  const navigate = useNavigate();
  const { isMobile, isTablet, isSmallTablet } = useWindowSizeContext();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [isLeftMost, setIsLeftMost] = React.useState(true);
  const [isRightMost, setIsRightMost] = React.useState(false);
  const isLimitedMode = mode === 'limited';

  let extraContainerClassname = 'desktop';
  if (isSmallTablet) {
    extraContainerClassname = 'smallTablet';
  } else if (isTablet) {
    extraContainerClassname = 'tablet';
  } else if (isMobile) {
    extraContainerClassname = 'mobile';
  }

  const scrollLeft = React.useCallback(() => {
    const container = containerRef.current;
    if (container) {
      container.scroll({ left: container.scrollLeft - container.clientWidth, behavior: 'smooth' });
    }
  }, []);

  const scrollRight = React.useCallback(() => {
    const container = containerRef.current;
    if (container) {
      container.scroll({ left: container.scrollLeft + container.clientWidth, behavior: 'smooth' });
    }
  }, []);

  React.useEffect(() => {
    const captureEvent = (isMobile) ? 'touchmove' : 'scroll';
    const listener = () => {
      const container = containerRef.current;
      if (container) {

        const isLeftMost = container.scrollLeft === 0;
        const isRightMost =
          ((container.scrollLeft || 0) + (container.clientWidth || 0) === container.scrollWidth) ||
          container.scrollWidth < container.clientWidth;

        setIsLeftMost(isLeftMost);
        setIsRightMost(isRightMost);
        if (positionCallback) {
          positionCallback({
            isLeft: isLeftMost,
            isRight: isRightMost
          })
        }
      }
    }

    const container = containerRef.current;
    if (container) {
      listener();
      container.addEventListener(captureEvent, listener);
    }

    return () => container?.removeEventListener(captureEvent, listener);
  }, [isMobile, isTablet, isSmallTablet, children, positionCallback]);

  return (
    <div className={`horizontal-card-slider ${className ? className : ''}`}>
      <div className='slider-title-button-container'>
        {!!title && <div className='slider-title-container'>{title}</div>}
        {isLimitedMode && !isMobile && <div className='slider-button-controls'>
          <Button role='primary' disabled={isLeftMost} iconLeft={<ArrowLeftIcon />} onClick={scrollLeft} />
          <Button role='primary' disabled={isRightMost} className='rotatedArrow' iconLeft={<ArrowLeftIcon />} onClick={scrollRight} />
        </div>}
      </div>
      <div ref={containerRef} className={`cards-container scrollbar ${extraContainerClassname}`}>
        {children}
      </div>
      {!isLimitedMode && <div className='cta-buttons'>
        <Button role='secondary' text='Home' onClick={() => navigate(getUrl({type: 'home'}))} />
      </div>}
    </div>
  );
}
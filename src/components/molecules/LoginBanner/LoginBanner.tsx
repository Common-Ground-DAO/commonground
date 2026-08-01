// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Button from 'components/atoms/Button/Button';
import './LoginBanner.css';
import React, { useEffect, useRef, useState } from 'react'
import { useUserOnboardingContext } from 'context/UserOnboarding';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import bannerBg from './bannerbg.webp';

import { ArrowRightIcon } from '@heroicons/react/20/solid';

type Props = {
  stickyMode?: boolean;
};

const useHalfHidden = () => {
  const [isSticky, setIsSticky] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // mount 
  useEffect(() => {
    const cachedRef = ref.current;
    if (!cachedRef) return;

    const observer = new IntersectionObserver(
      ([e]) => {
        const refTop = ref.current?.getBoundingClientRect().top || 0;
        setIsSticky(e.intersectionRatio < 0.5 && refTop < 0);
      },
      {
        threshold: [0.5],
      }
    );

    observer.observe(cachedRef);

    // unmount
    return () => {
      observer.unobserve(cachedRef);
    }
  }, [ref]);

  return [isSticky, ref] as [boolean, React.RefObject<HTMLDivElement>];
}

const LoginBanner: React.FC<Props> = ({ stickyMode }) => {
  const { isMobile } = useWindowSizeContext();
  const { setUserOnboardingVisibility } = useUserOnboardingContext();
  const [isStickyPosition, ref] = useHalfHidden();
  const isSticky = isStickyPosition && stickyMode;

  const onLogin = () => {
    setUserOnboardingVisibility(true);
  }

  const className = [
    'login-banner cg-text-main',
    isSticky ? 'collapsed' : '',
  ].join(' ').trim();

  const floatingStyle: React.CSSProperties | undefined = (() => {
    const style: React.CSSProperties = {};
   
    if (isMobile || !isSticky) return style;

    const boundingBox = ref.current?.getBoundingClientRect();
    if (boundingBox) {
      style.left = `${boundingBox.left}px`;
      style.right = `${window.innerWidth - boundingBox.right}px`;
    }
    return style;
  })();

  const getContent = () => {
    if (isSticky) return null;

    return <div className='flex flex-col justify-center items-center py-2 gap-2 flex-1 z-10'>
      <h2 className='text-center'>Common Ground</h2>
      <h3 className='text-center'>the onchain social network where you matter.</h3>
    </div>
  }

  const getButtonText = () => {
    return 'Join for free';
  }

  return (<div className='login-banner-container' ref={ref}>
    <div className={className} style={floatingStyle}>
      {getContent()}
      <div className='absolute inset-0 bg-center bg-cover bg-no-repeat opacity-50' style={{ backgroundImage: `url(${bannerBg})` }} />
      <div className='flex gap-2 w-full items-center justify-center z-10'>
        <Button className={!isSticky ? 'w-60' : ''} role='primary' text={getButtonText()} iconRight={<ArrowRightIcon className='w-5 h-5 cg-text-secondary' />} onClick={onLogin} />
      </div>
    </div>
  </div>);
}

export default React.memo(LoginBanner);
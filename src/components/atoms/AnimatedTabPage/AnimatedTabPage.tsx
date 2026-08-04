// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useRef, useState } from 'react'
import './AnimatedTabPage.css';

type Props = {
  visible: boolean;
  className: string;
}

const AnimatedTabPage: React.FC<React.PropsWithChildren<Props>> = (props) => {
  const {
    visible: propsVisible,
    children
  } = props;
  const [fullyHidden, setFullyHidden] = useState(true);
  const [isAnimating, setIsAnimating] = useState<'in' | 'out' | null>();
  const fullyHiddenTimout = useRef<any>(undefined);

  // Start going in if should be visible
  if (propsVisible && isAnimating !== 'in') {
    if (fullyHiddenTimout.current) clearTimeout(fullyHiddenTimout.current);
    setIsAnimating('in');
    setFullyHidden(false);
  // Start going out if was visible and should not be
  } else if (!propsVisible && isAnimating === 'in') {
    setIsAnimating('out');
    fullyHiddenTimout.current = setTimeout(() => setFullyHidden(true), 200);
  }

  if (fullyHidden) return null;

  const className = [
    'animated-tab-page',
    isAnimating === 'in' ? 'animating-in' : isAnimating === 'out' ? 'animating-out' : '',
    props.className || ''
  ].join(' ').trim();

  return (<div className={className}>
    {children}
  </div>);
}

export default React.memo(AnimatedTabPage);
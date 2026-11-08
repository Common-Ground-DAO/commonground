// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { CheckCircleIcon, ExclamationCircleIcon } from '@heroicons/react/20/solid';
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import config from 'common/config';

import './Snackbar.css';

export type SnackbarType = 'info' | 'warning' | 'updating' | 'success';

export type Props = {
  type: SnackbarType;
  text: string;
  rightElement?: React.JSX.Element;
  durationSeconds?: number;
};

const Snackbar: React.FC<Props> = (props) => {
  const [isShowing, setShowing] = useState(false);
  const { isMobile } = useWindowSizeContext();
  let className = [
    'snackbar',
    props.type,
    isMobile ? 'mobile-snackbar' : 'desktop-snackbar',
    isShowing ? 'showing' : ''
  ].join(' ');

  useEffect(() => {
    setTimeout(() => setShowing(true), 2);
    const duration = (props.durationSeconds || config.SNACKBAR_DURATION) * 1000;
    setTimeout(() => setShowing(false), duration);
  }, [props.durationSeconds]);

  const rightElement = useMemo(() => {
    if (props.rightElement) return props.rightElement;
    if (props.type === 'warning') return <ExclamationCircleIcon className='w-5 h-5'/>
    return <CheckCircleIcon className='w-5 h-5' />
  }, [props.rightElement, props.type]);

  const dismiss = useCallback((ev: React.MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    setShowing(false);
  }, []);

  return (<div className={className} onClick={dismiss}>
    <span>{props.text}</span>
    {rightElement}
  </div>)
}

export default React.memo(Snackbar);
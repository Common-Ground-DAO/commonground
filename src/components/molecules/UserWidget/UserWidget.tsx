// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './UserWidget.css';
import { useCallContext } from 'context/CallProvider';
import { AudioManagerButtons } from '../AudioManagerButtons/AudioManagerButtons';
import Jdenticon from 'components/atoms/Jdenticon/Jdenticon';
import { useOwnUser } from 'context/OwnDataProvider';
import { useUserOnboardingContext } from 'context/UserOnboarding';
import UserSettingsModalContent from 'components/organisms/UserSettingsModalContent/UserSettingsModalContent';
import { useSignedUrl } from 'hooks/useSignedUrl';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import { createPortal } from "react-dom";
import { getDisplayName } from '../../../util';
import { useUserSettingsContext } from 'context/UserSettingsProvider';
import SparkIcon from 'components/atoms/icons/misc/spark.svg?react';
import { useSnackbarContext } from 'context/SnackbarContext';

type Props = {
  collapsed: boolean;
};

const UserWidget: React.FC<Props> = (props) => {
  const { isMobile } = useWindowSizeContext();
  const { setIsOpen } = useUserSettingsContext();

  if (isMobile) {
    // Used to be the same on desktop, now only works for mobile but kept using screen-aware popover
    // because it's easier
    return <div className='w-full'>
      <div className={'user-widget-container'} onClick={() => setIsOpen(true)}>
        <div className='user-widget'>
          <UserWidgetContent collapsed={false} />
        </div>
      </div>
    </div>;
  } else {
    return <DesktopUserWidgetContainer {...props} />;
  }
}

const DesktopUserWidgetContainer: React.FC<Props> = (props) => {
  const portalRoot = useMemo(() => document.getElementById("user-settings-root") as HTMLElement, []);
  const { setUserOnboardingVisibility, setStep } = useUserOnboardingContext();
  const { isConnected } = useCallContext();
  const { isOpen, setIsOpen } = useUserSettingsContext();
  const [style, setStyle] = useState<React.CSSProperties>({});
  const [closedWidth, setClosedWidth] = useState(0);
  const [isModalLocked, lockModal] = useState(false);
  const ownUser = useOwnUser();
  const { showSnackbar } = useSnackbarContext();

  const selfRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const setIsClosed = useCallback((closed: boolean) => {
    // Can only set closed to false if own user is set
    setIsOpen(!closed && !!ownUser);
  }, [ownUser, setIsOpen]);

  const ownUserBalance = ownUser?.pointBalance;
  const [pointBalance, setPointBalance] = useState<number|undefined>(ownUserBalance || 0);
  useEffect(() => {
    setPointBalance(oldBalance => {
      if (ownUserBalance !== undefined && oldBalance !== undefined && oldBalance !== ownUserBalance) {
        if (oldBalance > ownUserBalance) {
          showSnackbar({ type: 'info', text: `You have spent ${(oldBalance - ownUserBalance).toLocaleString()} spark!` });
        }
        else {
          showSnackbar({ type: 'info', text: `🎉 You have received ${(ownUserBalance - oldBalance).toLocaleString()} spark!` });
        }
      }
      return ownUserBalance;
    });
  }, [ownUserBalance, showSnackbar]);

  const repositionWidget = useCallback(() => {
    const boundingBox = selfRef.current?.getBoundingClientRect();
    let left = (boundingBox?.left || 0);
    let bottom = document.body.clientHeight - (boundingBox?.bottom || 0);
    let width = boundingBox?.width || 0;

    // Undo parent padding
    if (isConnected) {
      left -= 8;
      bottom -= 8;
    }

    // Keep full size collapsed and connected
    if (isConnected && props.collapsed) {
      width += 16;
    }

    setStyle({
      left,
      bottom,
    });
    setClosedWidth(width);
  }, [isConnected, props.collapsed]);

  // Reposition on connected with delay
  useEffect(() => {
    if (isConnected) {
      setTimeout(repositionWidget, 120);
    }
  }, [isConnected, repositionWidget]);

  // Resize listener
  useEffect(() => {
    const listener: ResizeObserverCallback = async ([entry]) => {
      if (entry) {
        repositionWidget();
      }
    }

    const observer = new ResizeObserver(listener);
    if (selfRef.current) {
      observer.observe(selfRef.current);
    }

    return () => observer.disconnect();
  }, [props.collapsed, repositionWidget]);

  // Outside click listener
  useEffect(() => {
    if (isModalLocked) return;

    const handleClickOutside = (ev: MouseEvent) => {
      const target = ev.target as Element;
      if (isOpen && !modalRef?.current?.contains(target) && !portalRoot.contains(target)) {
        setIsClosed(true);
      }
    };

    document.addEventListener('click', handleClickOutside, true);
    return () => {
      document.removeEventListener('click', handleClickOutside, true);
    };
  }, [lockModal, isModalLocked, isOpen, portalRoot, setIsClosed]);

  const containerClassname = [
    'user-widget-container',
    isConnected ? 'call-active' : '',
  ].join(' ').trim();

  const portalContainerClassName = useMemo(() => {
    if (isConnected) {
      return [
        'h-10 relative',
        props.collapsed ? 'w-10' : ''
      ].join(' ').trim();
    } else {
      return [
        'h-16 relative',
        props.collapsed ? 'w-16' : ''
      ].join(' ').trim();
    }
  }, [isConnected, props.collapsed]);

  const onContainerClick = useCallback(() => {
    if (!ownUser) {
      if (setUserOnboardingVisibility) {
        setStep('start');
        setUserOnboardingVisibility(true);
      }
    } else if (isConnected && !isOpen) {
      setIsClosed(isOpen);
    }
  }, [isOpen, isConnected, ownUser, setIsClosed, setStep, setUserOnboardingVisibility])

  return <div className={containerClassname} onClick={onContainerClick}>
    {isConnected && <AudioManagerButtons />}
    <div className={portalContainerClassName} ref={selfRef}>
      {createPortal(<div className='absolute' style={style} ref={modalRef}>
        <UserSettingsModalContent
          collapsed={props.collapsed}
          closed={!isOpen}
          setIsClosed={setIsClosed}
          closedWidth={closedWidth}
          lockModal={lockModal}
          callMode={isConnected}
        />
      </div>, portalRoot)}
    </div>
  </div>;
}

export const UserWidgetContent = React.memo((props: {
  collapsed: boolean,
  onClick?: () => void;
  callMode?: boolean;
  showProfileButton?: boolean;
  standalone?: boolean;
}) => {
  const ownUser = useOwnUser();
  const imageUrl = useSignedUrl(ownUser?.accounts.find(acc => acc.type === ownUser.displayAccount)?.imageId);

  const className = [
    'flex relative w-full items-center justify-center',
    props.callMode ? 'user-widget-call-mode' : '',
    props.onClick ? 'cursor-pointer' : '',
    props.standalone ? 'standalone-widget' : ''
  ].join(' ').trim();

  return <div className={className} onClick={props.onClick}>
    {!props.callMode && <div className="user-widget-content-bg" style={{ backgroundImage: `url(${imageUrl})` }} />}
    <div className={`user-widget-content${props.standalone ? ' standalone-widget' : ''}`}>
      <Jdenticon userId={ownUser?.id || ''} predefinedSize='40' onlineStatus={ownUser?.onlineStatus} hideStatus />
      {!props.collapsed && <div className='flex-1 cg-text-lg-500 flex flex-wrap justify-between items-center overflow-hidden'>
        <span>{ownUser ? getDisplayName(ownUser) : 'Hello!'}</span>
        {/* {!props.collapsed && props.showProfileButton && <div className='flex items-center gap-1 py-2 cg-text-main' onClick={() => navigate('/profile')}>
          <span className='cg-text-lg-400'>View Profile</span>
          <ChevronRightIcon className='w-5 h-5' />
        </div>} */}
        <div className='flex cg-bg-subtle p-1 gap-1 cg-border-l self-start'>
          <SparkIcon className='w-4 h-4' />
          <span className='cg-text-md-500'>{(ownUser?.pointBalance || 0).toLocaleString()}</span>
        </div>
      </div>}
    </div>
  </div>;
});

export default React.memo(UserWidget);
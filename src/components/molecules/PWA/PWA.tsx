// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import './PWA.css';
import { useNotificationContext } from 'context/NotificationProvider';
import IosInstallIcon from '../../atoms/icons/28/IosInstall.svg?react';
import Button from 'components/atoms/Button/Button';
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import CircleLogo from "components/atoms/icons/misc/Logo/logo.svg?react";
import { CheckCircleIcon } from '@heroicons/react/20/solid';
import { XMarkIcon } from '@heroicons/react/24/solid';
import { useUserOnboardingContext } from 'context/UserOnboarding';

// Used code from: https://github.com/adueck/pwa-install-demo/blob/main/src/App.js

export const PWAStatus: React.FC = () => {
  const { pwaStatus } = useNotificationContext();

  const content = useMemo(() => {
    switch (pwaStatus) {
      case 'iOS_InSafari_InstallPWA':
      case 'Android_InChrome_InstallPWA':
      case 'InMobilePWA':
        return <div className='flex flex-col self-stretch gap-6'>
          <span className='cg-heading-2'>Install CG for the best experience & push notifications</span>
          <span className='cg-heading-3'>Install the app on Safari by tapping <IosInstallIcon /> and then “Add to Home Screen”</span>
        </div>;
      case 'iOS_OpenWithSafari':
        return <div className='flex flex-col self-stretch gap-6'>
          <span className='cg-heading-2'>Install CG for the best experience & push notifications</span>
          <span className='cg-heading-3'>To continue, please open this website in Safari</span>
        </div>;
      case 'Android_OpenWithChrome':
        return <div className='flex flex-col self-stretch gap-6'>
          <span className='cg-heading-2'>Install CG for the best experience & push notifications</span>
          <span className='cg-heading-3'>To continue, please open this website in Chrome Browser</span>
        </div>;
      case 'iOS_UpdateRequired':
        return <div className='flex flex-col self-stretch gap-6'>
          <span className='cg-heading-2'>Install CG for the best experience & push notifications</span>
          <span className='cg-heading-3'>Please update iOS</span>
          <span className='cg-heading-3'>Common Ground requires iOS 16.4 or later to send push notifications. </span>
          <span className='cg-heading-3'>Visit your iPhone Settings to update your iOS version (xx.x) to 16.4 or newer then come back here!</span>
        </div>;
      case 'Android_InChrome_PWAInstallSuccess':
        return <>
          <span className='cg-heading-2'>You have successfully installed the Common Ground PWA</span>
          <span className='cg-heading-3'>Open it now from your home screen or app menu</span>
        </>;
      default:
        return <div className='flex flex-col self-stretch gap-6'>
          <span className='cg-heading-2'>Add CG to your Home Screen for the best experience</span>
        </div>;
    }
  }, [pwaStatus]);

  return (
    <div className='flex flex-col items-center gap-6 cg-text-main px-4 text-center'>
      {content}
    </div>
  );
}

export const PWAInstallButton: React.FC = () => {
  const { pwaStatus } = useNotificationContext();
  const [deferredPrompt, setDeferredPrompt] = useState<Event | null>(null);

  useEffect(() => {
    const deferredPwaPrompt = (window as any).__deferredPwaPrompt as {
      prompt: null | Event;
      onchange: (e: Event) => void;
    } | undefined;
    if (deferredPwaPrompt !== undefined) {
      setDeferredPrompt(deferredPwaPrompt.prompt);
      deferredPwaPrompt.onchange = (e) => {
        setDeferredPrompt(e);
      }

      return () => {
        deferredPwaPrompt.onchange = () => undefined;
      }
    }
  }, []);

  const handleInstallClick = useCallback(() => {
    // Show the install prompt
    if (!!deferredPrompt && 'prompt' in deferredPrompt && typeof (deferredPrompt as any).prompt === 'function') {
      (deferredPrompt as any).prompt();
    }
  }, [deferredPrompt]);

  if (!deferredPrompt || pwaStatus !== "Android_InChrome_InstallPWA") return null;

  return <Button
    role='primary'
    key='splash-primary-button'
    className='splash-button'
    text='Add to Home Screen'
    onClick={handleInstallClick}
  />
}
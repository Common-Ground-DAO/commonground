// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Button from 'components/atoms/Button/Button';
import './LoginBanner.css';
import React from 'react'
import { useUserOnboardingContext } from 'context/UserOnboarding';
import { useOwnUser } from 'context/OwnDataProvider';
import bannerBg from './bannerbg.webp';

type Props = {
};

const MiniLoginBanner: React.FC<Props> = () => {
  const ownUser = useOwnUser();
  const { setUserOnboardingVisibility, setStep } = useUserOnboardingContext();

  const onJoin = () => {
    setStep('start');
    setUserOnboardingVisibility(true);
  }

  const className = [
    'mini-login-banner cg-text-main',
  ].join(' ').trim();

  const getButtonText = () => {
    return 'Join Common Ground';
  }

  if (ownUser) return null;

  return (<div className={className}>
    <div className='absolute inset-0 bg-center bg-cover bg-no-repeat opacity-50' style={{ backgroundImage: `url(${bannerBg})` }} />
    <div className='flex flex-row items-center gap-4 w-full z-10'>
      <span className='cg-heading-5'>Enjoying the post? There’s a whole world to discover 🥳</span>
    </div>
    <Button className='w-full' role='primary' text={getButtonText()} onClick={onJoin} />
  </div>);
}

export default React.memo(MiniLoginBanner);
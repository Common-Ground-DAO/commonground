// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useMemo, useState } from 'react'
import './OnboardingPostOnX.css';
import OnboardingLogo from '../OnboardingLogo';
import ToggleText from 'components/molecules/ToggleText/ToggleText';
import XIcon from '../../../atoms/icons/24/X.svg?react';
import Button from 'components/atoms/Button/Button';
import VerifiedIcon from "../../../atoms/icons/16/Verified.svg?react";
import CircleLogo from "components/atoms/icons/misc/Logo/logo.svg?react";
import twitterApi from 'data/api/twitter';

type Props = {
  onProceed: () => void;
  twitterData?: API.Twitter.finishLogin.Response;
};

const OnboardingPostOnX: React.FC<Props> = (props) => {
  const { onProceed, twitterData } = props;
  const [shareToggled, setShareToggled] = useState(true);
  // const [genericError, setGenericError] = useState('');
  const [loading, setLoading] = React.useState(false);

  if (!twitterData) {
    onProceed();
  }

  const onClickSubmit = async () => {
    setLoading(true);
    if (shareToggled) {
      try {
        await twitterApi.shareJoined();
      } catch (e) {
        console.error('Failed to send tweet');
        console.error(e);
      }
    }
    setLoading(false);
    onProceed();
  }

  const previewTweet = useMemo(() => <div className='cg-twitter-tweet flex cg-border-l gap-3 py-3 px-4 overflow-hidden'>
    <img src={twitterData?.profileImageUrl} alt='profile img' className='cg-twitter-img' />
    <div className='flex flex-col gap-3 flex-1'>
      <div className='flex flex-col gap-1'>
        <div className='flex gap-1 items-center'>
          <span className='cg-text-lg-500 cg-text-white'>{twitterData?.username}</span>
          <VerifiedIcon className='cg-text-twitter-white' />
          <span className='cg-text-lg-400 cg-text-twitter-grey' >@{twitterData?.username}</span>
          <span className='cg-text-lg-400 cg-text-twitter-grey'>7m</span>
        </div>
        <span className='cg-text-lg-400 cg-text-white'>I'm on Common Ground. Will you join me?</span>
      </div>
      <div className='cg-twitter-preview relative flex items-center justify-center w-full h-44'>
        <CircleLogo className='w-16 h-16 cg-text-white' />
        <span className='cg-twitter-preview-span absolute bottom-3 left-3 cg-text-sm-400 cg-text-white'>https://app.cg</span>
      </div>
    </div>
  </div>, [twitterData?.profileImageUrl, twitterData?.username]);

  return (<div className='flex flex-col py-8 px-4 items-center justify-between min-h-full gap-8'>
    <div className='flex flex-col items-center justify-center gap-2'>
      <OnboardingLogo />
      <span className='cg-heading-3'>Welcome to Common Ground!</span>
      <span className='cg-text-lg-400'>It’s more fun with friends. Post about it on X?</span>
    </div>
    <div className='flex flex-col flex-1 items-center justify-start w-full gap-2'>
      <ToggleText
        title='Share on X'
        description='Get future rewards for your CG profile (coming soon)'
        active={shareToggled}
        onToggle={() => setShareToggled(true)}
        icon={<XIcon className='w-6 h-6' />}
        extraBottomElement={shareToggled ? previewTweet : undefined}
      />
      <ToggleText
        title="Don't share on X"
        description='No rewards'
        active={!shareToggled}
        onToggle={() => setShareToggled(false)}
        icon={<XIcon className='w-6 h-6 cg-text-secondary' />}
      />
    </div>
    <div className='flex flex-col gap-2 items-center max-w-xs w-full'>
      {/* {genericError && <span className='cg-text-lg-500 text-center cg-text-error'>{genericError}</span>} */}
      <Button
        loading={loading}
        className='w-full cg-text-lg-500'
        role="primary"
        text={shareToggled ? "Post on X" : 'Finish'}
        onClick={onClickSubmit}
      />
    </div>
  </div>);
}

export default OnboardingPostOnX;
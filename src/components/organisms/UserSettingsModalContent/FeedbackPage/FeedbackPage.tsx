// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import PaddedIcon from 'components/atoms/PaddedIcon/PaddedIcon';
import { ChatBubbleOvalLeftEllipsisIcon } from '@heroicons/react/20/solid';
import { isLocalUrl } from 'components/atoms/SimpleLink/SimpleLink';
import { useNavigate } from 'react-router';
import { useWindowSizeContext } from 'context/WindowSizeProvider';

type Props = {
};

const feedbackChannel = 'https://app.cg/c/commonground/channel/~1KVhCmhzZYdShkRa3vnEoi/';

const FeedbackPage: React.FC<Props> = (props) => {
  const navigate = useNavigate();
  const { isMobile } = useWindowSizeContext();
  const localExtract = isLocalUrl(feedbackChannel);

  const goToFeedbackChannel = () => {
    if (localExtract) {
      navigate(localExtract);
    } else {
      if (isMobile) {
        window.open(feedbackChannel, 'infoTab', 'noopener');
      } else {
        window.open(feedbackChannel, '_blank', 'noopener');
      }
    }
  }

  return (<div className='flex px-4 flex-col gap-2 cg-text-main'>
    <div className='flex flex-col gap-4'>
      <div className='flex items-start user-settings-card-bg p-4 gap-2 cg-border-xxl cursor-pointer' onClick={goToFeedbackChannel}>
        <PaddedIcon defaultClassName='info' icon={<ChatBubbleOvalLeftEllipsisIcon className='w-5 h-5' />} />
        <div className='flex flex-col'>
          <span className='cg-heading-4'>Help & Feedback Channel</span>
          <span className='cg-text-lg-400'>Are you having any issues or want to give us feedback?</span>
        </div>
      </div>
    </div>
  </div>);
}

export default React.memo(FeedbackPage);
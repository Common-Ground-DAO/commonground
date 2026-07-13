// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect, useState } from 'react';
import config from 'common/config';
import { ChevronDownIcon } from '@heroicons/react/20/solid';
import { useNavigationContext } from 'components/SuspenseRouter/SuspenseRouter';
import Button from 'components/atoms/Button/Button';
import ManagementHeader2 from 'components/molecules/ManagementHeader2/ManagementHeader2';
import Scrollable from 'components/molecules/Scrollable/Scrollable';
import ToggleInputField from 'components/molecules/inputs/ToggleInputField/ToggleInputField';
import { useWindowSizeContext } from 'context/WindowSizeProvider'
import { useNavigate } from 'react-router-dom';
import { useLoadedCommunityContext } from 'context/CommunityProvider';
import Tag from 'components/atoms/Tag/Tag';
import SimpleLink from 'components/atoms/SimpleLink/SimpleLink';
import communityApi from 'data/api/community';
import { useAsyncMemo } from 'hooks/useAsyncMemo';
import { PredefinedRole } from 'common/enums';
import dayjs from 'dayjs';
import UserTag from 'components/atoms/UserTag/UserTag';
import { useMultipleUserData } from 'context/UserDataProvider';
import ScreenAwareDropdown from 'components/atoms/ScreenAwareDropdown/ScreenAwareDropdown';
import ListItem from 'components/atoms/ListItem/ListItem';

const NewslettersManagement = () => {
  const { isMobile } = useWindowSizeContext();
  const { isDirty } = useNavigationContext();
  const { community, roles } = useLoadedCommunityContext();
  const [newsletterEnabled, setNewsletterEnabled] = useState(false);
  const [timeframe, setTimeframe] = useState<API.Community.getNewsletterHistory.Request['timeframe']>('30days');
  const navigate = useNavigate();

  const audienceCount = useAsyncMemo(async () => {
    if (!config.EMAIL_ENABLED) {
      return undefined;
    }
    const memberRole = roles.find(r => r.title === PredefinedRole.Member);

    if (memberRole) {
      return communityApi.getMemberNewsletterCount({
        communityId: community.id,
        roleIds: [memberRole?.id]
      });
    }
  }, [community.id]);

  const newsletterHistory = useAsyncMemo(async () => {
    if (!config.EMAIL_ENABLED) {
      return undefined;
    }
    return communityApi.getNewsletterHistory({
      communityId: community.id,
      timeframe
    })
  }, [community.id, timeframe]);

  const users = useMultipleUserData(newsletterHistory?.entries.map(entry => entry.creatorId) || []);

  useEffect(() => {
    setNewsletterEnabled(community.enablePersonalNewsletter);
  }, [community.enablePersonalNewsletter]);

  const header = <ManagementHeader2
    title='Newsletters'
    help={<>
      <span>Whitelisted communities can enable newsletters. Anyone with the “Manage posts” permission will be able to send posts as newsletters, meaning members who have a valid email and an active newsletter subscription to your community will receive any post you choose to send as an email. For now, newsletters are limited to 1 per 6 days to prevent spam. Additionally, if your community is whitelisted and has newsletters enabled, your posts may be featured in the CG Weekly Newsletter that goes out to everyone on Common Ground. Your members will see new posts from your community listed first in this weekly newsletter. For more info, please <SimpleLink href='https://app.cg/c/commonground/article/community-email-newsletters-5Z1WCYM3ZAJheDkbbp1hty/' inlineLink className='underline'>read this post</SimpleLink>.</span>
    </>}
    goBack={isMobile ? () => navigate(-1) : undefined}
  />;

  const content = <div className={`grid grid-flow-row gap-6 cg-text-main ${isMobile ? ` px-4 ${isDirty ? 'pb-28' : 'pb-4'}` : ''}`}>
    <div className='cg-content-stack grid grid-flow-row gap-4 p-4 cg-border-xxl'>
      <div className='flex items-center justify-between gap-2'>
        <h3>Enable newsletters</h3>
        <ToggleInputField toggled={newsletterEnabled} disabled={!newsletterEnabled} />
      </div>
      <Tag
        variant='info'
        largeFont
        className='gap-2'
        label={`This feature is in beta.${!newsletterEnabled ? ' To use Newsletters, please request a Whitelist by sending an email to ola@dao.cg or messaging us in the Common Ground community' : ''}`}
      />
      <span className='cg-text-secondary'>This will allow anyone with the permission to manage posts to also send posts as newsletters. </span>
    </div>

    <ScreenAwareDropdown
      triggerClassname='w-fit'
      triggerContent={<Button
        role='chip'
        text={timeframe === '30days' ? '30 days' : timeframe === '90days' ? '90 days' : '1 year'}
        iconRight={<ChevronDownIcon className='w-4 h-4' />}
        className='w-fit'
      />}
      placement='bottom-start'
      items={[
        <ListItem
          key='30days'
          title='30 days'
          onClick={() => setTimeframe('30days')}
        />,
        <ListItem
          key='90days'
          title='90 days'
          onClick={() => setTimeframe('90days')}
        />,
        <ListItem
          key='1year'
          title='1 year'
          onClick={() => setTimeframe('1year')}
        />
      ]}
    />

    <div className='flex flex-wrap gap-2'>
      <div className='flex gap-2 p-2 cg-bg-subtle cg-border-xxl'>
        <span className='cg-text-md-400 cg-text-secondary'>Emails</span>
        <span className='cg-text-md-500'>{newsletterHistory?.entries.length ?? '...'}</span>
      </div>

      <div className='flex gap-2 p-2 cg-bg-subtle cg-border-xxl'>
        <span className='cg-text-md-400 cg-text-secondary'>Subscribers</span>
        <span className='cg-text-md-500'>{audienceCount?.count ?? '...'}</span>
      </div>
    </div>

    <div className='grid grid-flow-row gap-4'>
      <h3>Newsletter History</h3>
      <div className='flex flex-col gap-2'>
        <div className='cg-simple-container w-item-borders cg-border-xxl'>
          {newsletterHistory?.entries.map(history => <div className='grid grid-flow-row gap-2 p-4' key={history.id}>
            <div className='flex justify-between'>
              <span className='cg-text-lg-500'>{history.title}</span>
              <span className='cg-text-md-400'>{!!history.sentAsNewsletter ? dayjs(history.sentAsNewsletter).format('MMM DD, YYYY') : 'Processing...'}</span>
            </div>
            <div className='flex flex-wrap gap-2'>
              <div className='flex gap-2 p-2 cg-bg-subtle cg-border-xxl'>
                <span className='cg-text-md-400'>Sent by</span>
                {!!users[history.creatorId] ? <UserTag
                  userData={users[history.creatorId]}
                  hideStatus
                  jdenticonSize='20'
                  noOfflineDimming
                  noBg
                /> : 'Loading...'}
              </div>
              {/* <div className='flex gap-2 p-2 cg-bg-subtle cg-border-xxl'>
                <span className='cg-text-md-400'>Open Rate</span>
                <span className='cg-text-md-500'>35%</span>
              </div> */}
            </div>
          </div>)}
        </div>

        <Button
          role='chip'
          text='Show more'
          className='w-fit'
        />
      </div>
    </div>
  </div>;

  // email delivery is a per-instance capability; without it newsletters
  // cannot be sent at all
  if (!config.EMAIL_ENABLED) {
    return <div className={`flex flex-col gap-4 cg-text-main${isMobile ? ' px-4' : ''}`}>
      {header}
      <span>Email delivery is not configured on this instance, so community newsletters are unavailable.</span>
    </div>
  }

  if (isMobile) {
    return <div className={`flex flex-col h-full cg-text-main`}>
      {header}
      <Scrollable>
        {content}
      </Scrollable>
    </div>
  } else {
    return <div>
      <div className={`flex flex-col gap-6 cg-text-main${isDirty ? ' pb-28' : ''}`}>
        {header}
        {content}
      </div>
    </div>
  }

}

export default NewslettersManagement
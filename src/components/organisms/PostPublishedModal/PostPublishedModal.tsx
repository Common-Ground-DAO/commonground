// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './PostPublishedModal.css';
import { PredefinedRole } from 'common/enums';
import Button from 'components/atoms/Button/Button';
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import Tag from 'components/atoms/Tag/Tag';
import ToggleInputField from 'components/molecules/inputs/ToggleInputField/ToggleInputField';
import React, { useEffect, useMemo, useState } from 'react'
import newsletter1 from '../UserOnboarding/Splash/imgs/newsletter1.webp';
import communityApi from 'data/api/community';
import { useSafeCommunityContext } from 'context/CommunityProvider';
import dayjs from 'dayjs';
import config from 'common/config';
import { isPredefinedRole, isPredefinedRolePermission } from "util/predefinedRoles";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  roles: Models.Community.CommunityArticlePermission[];
  onSendNewsletter?: () => Promise<void>;
  sentAsNewsletter: boolean;
};

const PostPublishedModal: React.FC<Props> = (props) => {
  const { isOpen, onClose, roles, onSendNewsletter, sentAsNewsletter } = props;
  const commContext = useSafeCommunityContext();
  const [sendNewsletterEnabled, setSendNewsletterEnabled] = useState(false);
  const [loadedRoleMemberCount, setLoadedRoleMemberCount] = useState(false);
  const [canSendNewsletter, setCanSendNewsletter] = useState(false);
  const [nextSendDate, setNextSendDate] = useState<dayjs.Dayjs | null>(null);
  const [userCount, setUserCount] = useState<number | null>(null);

  const relevantRoles = useMemo(() => {
    if (commContext.state !== 'loaded') return [];

    const publicRole = roles.find(r => isPredefinedRolePermission(r, PredefinedRole.Public));
    const memberRole = roles.find(r => isPredefinedRolePermission(r, PredefinedRole.Member));
    if (publicRole?.permissions.includes('ARTICLE_READ') || memberRole?.permissions.includes('ARTICLE_READ')) {
      const fullMemberRole = commContext.roles.find(role => isPredefinedRole(role, PredefinedRole.Member));
      if (fullMemberRole) return [{ roleId: fullMemberRole.id, roleTitle: PredefinedRole.Member }];
    }

    return roles.filter(r => r.permissions.includes('ARTICLE_READ'));
  }, [commContext, roles]);

  const onPrimaryClick = async () => {
    if (sendNewsletterEnabled && !!onSendNewsletter) {
      await onSendNewsletter();
    }
    onClose();
  };

  const isInsideCommunity = commContext.state === 'loaded';
  const communityId = commContext.state === 'loaded' ? commContext.community.id : '';
  const personalNewsletterEnabled = commContext.state === 'loaded' && commContext.community.enablePersonalNewsletter;

  useEffect(() => {
    const canSend = async () => {
      if (!personalNewsletterEnabled) return;

      const latestCommunityNewsletterSentDate = await communityApi.getLatestArticleSentAsNewsletterDate({communityId});
      if (latestCommunityNewsletterSentDate === null) {
        setCanSendNewsletter(true);
        return;
      } else {
        const latestDate = dayjs(latestCommunityNewsletterSentDate);
        const nextValidDate = latestDate.add(config.EMAIL_WAIT_INTERVAL_MINUTES, 'minutes');
        const canSend = dayjs().isAfter(nextValidDate);
        setNextSendDate(nextValidDate);
        setCanSendNewsletter(canSend);
      } 
    }
    canSend();     
  }, [communityId, personalNewsletterEnabled]);

  useEffect(() => {
    if (sendNewsletterEnabled) {
      setUserCount(0);
      communityApi.getMemberNewsletterCount({
        communityId,
        roleIds: relevantRoles.map(r => r.roleId)
      }).then(result => {
        setUserCount(result.count);
        setLoadedRoleMemberCount(true);
      }).catch(error => {
        console.error(error);
      });
    }
  }, [communityId, relevantRoles, sendNewsletterEnabled]);

  return (<ScreenAwareModal
    isOpen={isOpen}
    onClose={onClose}
    hideHeader
  >
    <div className='flex flex-col gap-2 cg-text-lg-400'>
      <div className='flex flex-col gap-2 items-center'>
        <img src={newsletter1} alt='newsletter' className="post-published-image" />
        <h2>Your post was published!</h2>
        <span className='text-center'>
          {isInsideCommunity ?
            'It is now on your community’s frontpage, and on your member’s personal feeds.' : 
            'It is now on your personal feed, and on the feed of your followers.'
          }
        </span>

        {commContext.state === 'loaded' && commContext.community.enablePersonalNewsletter && !sentAsNewsletter && <div className='flex flex-col gap-2 cg-text-main cg-text-lg-400'>
          <div className='cg-content-stack-subtle grid grid-flow-row p-4 gap-4 cg-border-l'>
            <div className='grid grid-flow-row gap-2'>
              <div className='flex justify-between gap-2'>
                <span className='cg-text-lg-500'>Also send as Newsletter</span>
                <ToggleInputField
                  toggled={canSendNewsletter && sendNewsletterEnabled}
                  onChange={setSendNewsletterEnabled}
                  disabled={!canSendNewsletter}
                />
              </div>
              <span className='cg-text-md-400 cg-text-secondary'>Increase the reach of this post by sending it as an email. It will be sent to Roles to the visibility setting of the post.</span>
              <div className='flex flex-wrap gap-0.5'>
                {relevantRoles.map(rr => <div className='py-0.5 px-2 cg-circular cg-bg-subtle cg-text-sm-400' key={rr.roleTitle}>
                  {rr.roleTitle}
                </div>)}
              </div>
            </div>
            {sendNewsletterEnabled && <>
              <div className='flex gap-1 cg-text-lg-500'>
                <span>Will be sent to {loadedRoleMemberCount ? userCount : '...'} people</span>
              </div>
            </>}
            <Tag 
              variant='info'
              label={canSendNewsletter ? 'You can only send 1 newsletter per week' : `You can send your next newsletter in ${nextSendDate}`}
              largeFont
            />
          </div>
        </div>}
      </div>
      <div className='flex flex-col gap-2 pt-4 px-4'>
        <Button
          role='primary'
          text={sendNewsletterEnabled ? 'Send Newsletter' : 'Done'}
          className='flex-1'
          onClick={onPrimaryClick}
        />
        {sendNewsletterEnabled && <Button
          role='secondary'
          text='Not now'
          className='flex-1'
          onClick={onClose}
        />}
      </div>
    </div>
  </ScreenAwareModal>)
}

export default React.memo(PostPublishedModal);
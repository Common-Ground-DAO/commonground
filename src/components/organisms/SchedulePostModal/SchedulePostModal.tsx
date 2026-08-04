// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import config from 'common/config';
import './SchedulePostModal.css';
import { PredefinedRole } from 'common/enums';
import Button from 'components/atoms/Button/Button';
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import Tag from 'components/atoms/Tag/Tag';
import DateTimeField from 'components/molecules/inputs/DateTimeField/DateTimeField';
import ToggleInputField from 'components/molecules/inputs/ToggleInputField/ToggleInputField';
import { useSafeCommunityContext } from 'context/CommunityProvider';
import communityApi from 'data/api/community';
import dayjs from 'dayjs';
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ItemArticleType } from '../GenericArticleManagement/GenericArticleManagement';

type Props = {
  isOpen: boolean;
  onClose: () => void;
  roles: Models.Community.CommunityArticlePermission[];
  scheduleArticle: (scheduleDate: dayjs.Dayjs | null, markAsNewsletter: boolean) => Promise<void>;
  itemArticleRef: React.RefObject<ItemArticleType | null>;
  sentAsNewsletter: boolean;
};

const SchedulePostModal: React.FC<Props> = (props) => {
  const { isOpen, onClose, roles, scheduleArticle, itemArticleRef, sentAsNewsletter } = props;
  const isCurrentlyScheduled = useMemo(() => {
    return !!itemArticleRef.current?.published && dayjs(itemArticleRef.current?.published).isAfter(dayjs())
  }, [itemArticleRef]);

  const commContext = useSafeCommunityContext();
  const [schedulePostEnabled, setSchedulePostEnabled] = useState(isCurrentlyScheduled);
  const [sendNewsletterEnabled, setSendNewsletterEnabled] = useState(false);
  const [canSendNewsletter, setCanSendNewsletter] = useState(false);
  const [nextSendDate, setNextSendDate] = useState<dayjs.Dayjs | null>(null);
  const [scheduleDate, setScheduleDate] = useState<dayjs.Dayjs>(isCurrentlyScheduled ? dayjs(itemArticleRef.current?.published) : dayjs());
  const [loadedRoleMemberCount, setLoadedRoleMemberCount] = useState(false);
  const [userCount, setUserCount] = useState<number | null>(null);

  const relevantRoles = useMemo(() => {
    if (commContext.state !== 'loaded') return [];

    const publicRole = roles.find(r => r.roleTitle === PredefinedRole.Public);
    const memberRole = roles.find(r => r.roleTitle === PredefinedRole.Member);
    if (publicRole?.permissions.includes('ARTICLE_READ') || memberRole?.permissions.includes('ARTICLE_READ')) {
      const fullMemberRole = commContext.roles.find(role => role.title === PredefinedRole.Member);
      if (fullMemberRole) return [{ roleId: fullMemberRole.id, roleTitle: PredefinedRole.Member }];
    }

    return roles.filter(r => r.permissions.includes('ARTICLE_READ'));
  }, [commContext, roles]);

  const onSubmit = useCallback(async () => {
    if (isCurrentlyScheduled !== schedulePostEnabled) {
      await scheduleArticle(schedulePostEnabled ? scheduleDate : null, sendNewsletterEnabled);
    }
    onClose();
  }, [isCurrentlyScheduled, onClose, scheduleArticle, scheduleDate, schedulePostEnabled, sendNewsletterEnabled]);

  const communityId = commContext.state === 'loaded' ? commContext.community.id : '';
  const personalNewsletterEnabled = commContext.state === 'loaded' && commContext.community.enablePersonalNewsletter;

  useEffect(() => {
    if (sendNewsletterEnabled) {
      setUserCount(0);
      communityApi.getMemberNewsletterCount({
        communityId: communityId || '',
        roleIds: relevantRoles.map(role => role.roleId)
      }).then(result => {
        setUserCount(result.count);
        setLoadedRoleMemberCount(true);
      }).catch(error => {
        console.error(error);
      });
    }
  }, [communityId, relevantRoles, sendNewsletterEnabled]);
  
  useEffect(() => {
    const canSend = async () => {
      if (!personalNewsletterEnabled) return;
      if (!communityId) return;

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

  return (<ScreenAwareModal
    isOpen={isOpen}
    onClose={onClose}
    title='Schedule Post'
    customClassname='schedule-post-modal'
  >
    <div className='flex flex-col gap-2 cg-text-main cg-text-lg-400'>
      <div className='cg-content-stack-subtle grid grid-flow-row p-4 gap-2 cg-border-l'>
        <div className='flex justify-between gap-2'>
          <span className='cg-text-lg-500'>Schedule this post for later</span>
          <ToggleInputField
            toggled={schedulePostEnabled}
            onChange={setSchedulePostEnabled}
          />
        </div>
        <span className='cg-text-md-400 cg-text-secondary'>Pick a time and date when this post should be published.</span>
        <DateTimeField
          value={scheduleDate}
          onChange={setScheduleDate}
          minValueNow
          step={60 * 15} // 15 minutes
        />
      </div>

      {personalNewsletterEnabled && schedulePostEnabled && !sentAsNewsletter && <div className='cg-content-stack-subtle grid grid-flow-row p-4 gap-4 cg-border-l'>
        <div className='grid grid-flow-row gap-2'>
          <div className='flex justify-between gap-2'>
            <span className='cg-text-lg-500'>Also send as Newsletter</span>
            <ToggleInputField
              toggled={sendNewsletterEnabled}
              onChange={setSendNewsletterEnabled}
            />
          </div>
          <span className='cg-text-md-400 cg-text-secondary'>Increase the reach of this post by sending it as an email. It will be sent to Roles to the visibility setting of the post.</span>
          <div className='flex flex-wrap gap-0.5'>
            {relevantRoles.map(rr => <div className='py-0.5 px-2 cg-circular cg-bg-subtle cg-text-sm-400' key={rr.roleId}>
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
      </div>}
    </div>
    <div className='flex gap-2'>
      <Button
        role='secondary'
        text='Cancel'
        className='flex-1'
        onClick={onClose}
      />
      <Button
        role='primary'
        text='Done'
        className='flex-1'
        onClick={onSubmit}
      />
    </div>
  </ScreenAwareModal>)
}

export default React.memo(SchedulePostModal);
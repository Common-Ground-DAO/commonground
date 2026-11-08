// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import config from 'common/config';
import { ChevronRightIcon } from '@heroicons/react/20/solid';
import ToggleInputField from 'components/molecules/inputs/ToggleInputField/ToggleInputField';
import UserSettingsButton from '../../../molecules/UserSettingsButton/UserSettingsButton';
import { PageType } from '../UserSettingsModalContent';
import { useOwnCommunities, useOwnUser } from 'context/OwnDataProvider';
import CheckboxBase from 'components/atoms/CheckboxBase/CheckboxBase';
import { getCommunityDisplayName } from '../../../../util';
import { ArrowBendUpLeft, At, Calendar, ChatsTeardrop, EnvelopeSimple, Note, Phone } from '@phosphor-icons/react';
import CommunityPhoto from 'components/atoms/CommunityPhoto/CommunityPhoto';
import { useSnackbarContext } from 'context/SnackbarContext';
import communityApi from 'data/api/community';
import userApi from 'data/api/user';
import { useEmailConfirmationContext } from 'context/EmailConfirmationProvider';

type Props = {
  setCurrentPage: (pageType: PageType) => void;
};

const emptyNotificationState: Models.Community.DetailView['notificationState'] = {
  notifyCalls: true,
  notifyEvents: true,
  notifyMentions: true,
  notifyPosts: true,
  notifyReplies: true,
}

function isNotificationStateNotifiesEqual(comm1: Models.Community.DetailView, comm2: Models.Community.DetailView) {
  return comm1.notificationState?.notifyCalls === comm2.notificationState?.notifyCalls &&
    comm1.notificationState?.notifyEvents === comm2.notificationState?.notifyEvents &&
    comm1.notificationState?.notifyMentions === comm2.notificationState?.notifyMentions &&
    comm1.notificationState?.notifyPosts === comm2.notificationState?.notifyPosts &&
    comm1.notificationState?.notifyReplies === comm2.notificationState?.notifyReplies;
}

function calculateCheckedState(community: Models.Community.DetailView) {
  if (!community.notificationState) return 'unchecked';
  if (
    community.notificationState.notifyCalls &&
    community.notificationState.notifyEvents &&
    community.notificationState.notifyMentions &&
    community.notificationState.notifyPosts &&
    community.notificationState.notifyReplies &&
    (community.myNewsletterEnabled || !community.enablePersonalNewsletter)
  ) return 'checked';

  if (
    community.notificationState.notifyCalls ||
    community.notificationState.notifyEvents ||
    community.notificationState.notifyMentions ||
    community.notificationState.notifyPosts ||
    community.notificationState.notifyReplies ||
    (community.myNewsletterEnabled && community.enablePersonalNewsletter)
  ) return 'partial';
  return 'unchecked';
}

const NotificationsPage: React.FC<Props> = (props) => {
  const _communities = useOwnCommunities();
  const ownUser = useOwnUser();
  const { showSnackbar } = useSnackbarContext();
  const { openModal } = useEmailConfirmationContext();
  const [expandedCommunities, setExpandedCommunities] = useState<string[]>([]);
  const [currentCommunities, setCurrentCommunities] = useState(_communities);
  const [allExpanded, setAllExpanded] = useState(false);

  const [dmNotifications, setDmNotifications] = useState<boolean>(ownUser?.dmNotifications || true);
  const [newsletter, setNewsletter] = useState(ownUser?.newsletter || false);
  const [weeklyNewsletter, setWeeklyNewsletter] = useState(ownUser?.weeklyNewsletter || false);

  useEffect(() => {
    setCurrentCommunities(_communities);
  }, [_communities])

  const initialBooleansRef = useRef({
    dmNotifications,
    newsletter,
    weeklyNewsletter
  });
  const booleansRef = useRef(initialBooleansRef.current);

  const initialCommunityRef = useRef(_communities);
  const communityRef = useRef(currentCommunities);

  useEffect(() => {
    communityRef.current = currentCommunities;
  }, [currentCommunities]);

  useEffect(() => {
    booleansRef.current = {
      dmNotifications,
      newsletter,
      weeklyNewsletter
    };
  }, [dmNotifications, newsletter, weeklyNewsletter]);

  useEffect(() => {
    // Actually send the data 
    const sendChanges = async () => {
      let hasChanges = false;
      try {
        const notificationStateRequest: API.Community.updateNotificationState.Request = {
          data: []
        }
        const subscribeToCommunityNewsletterIds: string[] = [];
        const unsubscribeToCommunityNewsletterIds: string[] = [];

        for (const community of initialCommunityRef.current) {
          const currentCommunity = communityRef.current.find(currComm => currComm.id === community.id);
          if (!!currentCommunity && !isNotificationStateNotifiesEqual(community, currentCommunity)) {
            hasChanges ||= true;
            notificationStateRequest.data.push({
              communityId: community.id,
              ...currentCommunity.notificationState!
            });
          }

          if (currentCommunity?.myNewsletterEnabled !== community.myNewsletterEnabled) {
            if (currentCommunity?.myNewsletterEnabled) {
              subscribeToCommunityNewsletterIds.push(community.id);
            } else {
              unsubscribeToCommunityNewsletterIds.push(community.id);
            }

            hasChanges ||= true;
          }
        }

        if (notificationStateRequest.data.length > 0) {
          await communityApi.updateNotificationState(notificationStateRequest);
        }
        if (subscribeToCommunityNewsletterIds.length > 0) {
          await communityApi.subscribeToCommunityNewsletter({ communityIds: subscribeToCommunityNewsletterIds });
        }
        if (unsubscribeToCommunityNewsletterIds.length > 0) {
          await communityApi.unsubscribeFromCommunityNewsletter({ communityIds: unsubscribeToCommunityNewsletterIds });
        }

        if (!!ownUser?.email && initialBooleansRef.current.newsletter !== booleansRef.current.newsletter) {
          if (booleansRef.current.newsletter) {
            await userApi.subscribeNewsletter({ email: ownUser.email });
          } else {
            await userApi.unsubscribeNewsletter({ email: ownUser.email });
          }
          hasChanges ||= true;
        }

        if (
          initialBooleansRef.current.dmNotifications !== booleansRef.current.dmNotifications ||
          initialBooleansRef.current.weeklyNewsletter !== booleansRef.current.weeklyNewsletter
        ) {
          await userApi.updateOwnData({ weeklyNewsletter: booleansRef.current.weeklyNewsletter });
          hasChanges ||= true;

          if (!ownUser?.emailVerified && !!ownUser?.email && initialBooleansRef.current.weeklyNewsletter) {
            await userApi.requestEmailVerification({ email: ownUser?.email });
            openModal('pending');
          }
        }
      } catch (err) {
        console.error(err);
        showSnackbar({ type: 'warning', text: 'Failed to save notification settings, please try again later.' });
      }

      if (hasChanges) {
        showSnackbar({ type: 'success', text: 'Notifications settings saved succesfully.' });
      }
    }

    return () => {
      sendChanges();
    };
  }, [openModal, ownUser?.email, ownUser?.emailVerified, showSnackbar]);

  const allData: Record<'myNewsletterEnabled' | keyof NonNullable<Models.Community.DetailView['notificationState']>, null | 'checked' | 'partial' | 'unchecked'> = useMemo(() => {
    const calculateValueForKey = (key: keyof NonNullable<Models.Community.DetailView['notificationState']>) => {
      if (!currentCommunities[0]?.notificationState) return null;
      const firstCommunityValue = currentCommunities[0].notificationState[key];
      for (const community of currentCommunities) {
        if (community.notificationState?.[key] !== firstCommunityValue) return 'partial';
      }
      if (firstCommunityValue) return 'checked';
      else return 'unchecked';
    }

    let newsletterState: null | 'checked' | 'partial' | 'unchecked' = null;
    const firstValidCommunity = currentCommunities.find(comm => comm.enablePersonalNewsletter);
    const firstCommunityValue = firstValidCommunity?.myNewsletterEnabled && firstValidCommunity?.enablePersonalNewsletter;
    for (const community of currentCommunities) {
      if (community.enablePersonalNewsletter && community.myNewsletterEnabled !== firstCommunityValue) {
        newsletterState = 'partial';
        break;
      }
    }

    if (newsletterState === null) {
      if (firstCommunityValue) newsletterState = 'checked';
      else newsletterState = 'unchecked';
    }

    return {
      notifyCalls: calculateValueForKey('notifyCalls'),
      notifyEvents: calculateValueForKey('notifyEvents'),
      notifyMentions: calculateValueForKey('notifyMentions'),
      notifyPosts: calculateValueForKey('notifyPosts'),
      notifyReplies: calculateValueForKey('notifyReplies'),
      myNewsletterEnabled: newsletterState
    }
  }, [currentCommunities]);

  const allDataChecked = Object.values(allData).every(entry => entry === 'checked') ? 'checked' :
    Object.values(allData).some(entry => entry === 'checked' || entry === 'partial') ? 'partial' : 'unchecked';


  const toggleCommunity = (communityId: string) => {
    setExpandedCommunities(old => {
      if (old.includes(communityId)) return old.filter(cId => cId !== communityId);
      else return [...old, communityId];
    });
  }

  const toggleOption = useCallback((communityId: string, option: keyof NonNullable<Models.Community.DetailView['notificationState']> | 'newsletter') => {
    setCurrentCommunities(communities => communities.map(community => {
      if (community.id !== communityId) return community;

      if (option === 'newsletter') {
        return { ...community, myNewsletterEnabled: !community.myNewsletterEnabled };
      } else {
        const newNotificationState = {
          ...(community.notificationState || emptyNotificationState),
          [option]: !community.notificationState?.[option]
        };

        return {
          ...community,
          notificationState: newNotificationState
        }
      }
    }));
  }, []);

  const toggleAllCommunityOptions = useCallback((communityId: string, newValue: boolean) => {
    setCurrentCommunities(communities => communities.map(community => {
      if (community.id !== communityId) return community;

      const newCommunity = {
        ...community,
        myNewsletterEnabled: newValue,
        notificationState: {
          notifyCalls: newValue,
          notifyEvents: newValue,
          notifyMentions: newValue,
          notifyPosts: newValue,
          notifyReplies: newValue,
        }
      };
      
      if (community.enablePersonalNewsletter) {
        newCommunity.enablePersonalNewsletter = newValue;
      }

      return newCommunity;
    }));
  }, []);

  const toggleAllOption = useCallback((option: keyof NonNullable<Models.Community.DetailView['notificationState']> | 'myNewsletterEnabled', checked: boolean) => {
    if (option === 'myNewsletterEnabled') {
      setCurrentCommunities(communities => communities.map(community => ({ ...community, myNewsletterEnabled: community.enablePersonalNewsletter ? checked : false })));
    } else {
      setCurrentCommunities(communities => communities.map(community => ({
        ...community, notificationState: {
          ...community.notificationState || emptyNotificationState,
          [option]: checked
        }
      })));
    }
  }, []);

  const toggleAllOptions = useCallback((checked: boolean) => {
    setCurrentCommunities(communities => communities.map(community => {
      const newCommunity = {
        ...community,
        notificationState: {
          notifyCalls: checked,
          notifyEvents: checked,
          notifyMentions: checked,
          notifyPosts: checked,
          notifyReplies: checked,
        }
      }

      if (community.enablePersonalNewsletter) {
        newCommunity.myNewsletterEnabled = checked;
      }

      return newCommunity;
    }));
  }, []);

  const onToggleNewsletter = useCallback(async () => {
    if (!ownUser?.email) {
      openModal('signup');
    } else if (!ownUser.emailVerified) {
      await userApi.requestEmailVerification({ email: ownUser.email });
      openModal('pending');
    } else {
      setNewsletter(old => !old);
    }
  }, [openModal, ownUser?.email, ownUser?.emailVerified]);

  const onToggleWeeklyNewsletter = useCallback(async () => {
    if (!ownUser?.email) {
      openModal('signup');
    } else if (!ownUser.emailVerified) {
      await userApi.requestEmailVerification({ email: ownUser.email });
      openModal('pending');
    } else {
      setWeeklyNewsletter(old => !old);
    }
  }, [openModal, ownUser?.email, ownUser?.emailVerified]);

  return (<div className='flex flex-col px-4 gap-4 cg-text-main'>
    <div className='flex flex-col gap-2'>
      <UserSettingsButton
        leftElement={<ChatsTeardrop weight='duotone' className='w-5 h-5' />}
        text='Direct Messages'
        rightElement={<ToggleInputField toggled={dmNotifications} />}
        onClick={() => setDmNotifications(old => !old)}
      />
      {config.EMAIL_ENABLED && <UserSettingsButton
        leftElement={<EnvelopeSimple weight='duotone' className='w-5 h-5' />}
        text='CG Updates Newsletter'
        rightElement={<ToggleInputField toggled={newsletter} />}
        onClick={onToggleNewsletter}
      />}
      {config.EMAIL_ENABLED && <UserSettingsButton
        leftElement={<EnvelopeSimple weight='duotone' className='w-5 h-5' />}
        text='Weekly Summaries'
        rightElement={<ToggleInputField toggled={weeklyNewsletter} />}
        onClick={onToggleWeeklyNewsletter}
      />}
    </div>
    <div className='cg-separator' />

    {currentCommunities.length > 0 && <div className='flex flex-col cg-border-l cg-bg-subtle'>
      <div className='flex p-4 justify-between cursor-pointer' onClick={() => setAllExpanded(old => !old)}>
        <div className='flex gap-2 flex-1 items-center overflow-hidden'>
          <ChevronRightIcon className={`w-5 h-5 transition-all${allExpanded ? ' rotate-90' : ''}`} />
          <span>All communities</span>
        </div>
        <div onClick={(ev) => ev.stopPropagation()}>
          <CheckboxBase
            size='small-20'
            type={allDataChecked === 'partial' ? 'checkminus' : 'checkbox'}
            checked={allDataChecked !== 'unchecked'}
            setChecked={toggleAllOptions}
          />
        </div>
      </div>
      {allExpanded && <div className='flex flex-col gap-1 py-2'>
        <div className='flex py-2 px-4 gap-2 w-full items-center cursor-pointer' onClick={() => toggleAllOption('notifyMentions', allData.notifyMentions === 'unchecked')}>
          <At weight='duotone' className='w-5 h-5 cg-text-brand' />
          <span className='flex-1 cg-text-md-500 cg-text-main'>Mentions</span>
          <CheckboxBase type={allData.notifyMentions === 'partial' ? 'checkminus' : 'checkbox'} size='small-20' checked={allData.notifyMentions !== 'unchecked'} />
        </div>
        <div className='flex py-2 px-4 gap-2 w-full items-center cursor-pointer' onClick={() => toggleAllOption('notifyReplies', allData.notifyReplies === 'unchecked')}>
          <ArrowBendUpLeft weight='duotone' className='w-5 h-5 cg-text-brand' />
          <span className='flex-1 cg-text-md-500 cg-text-main'>Replies</span>
          <CheckboxBase type={allData.notifyReplies === 'partial' ? 'checkminus' : 'checkbox'} size='small-20' checked={allData.notifyReplies !== 'unchecked'} />
        </div>
        <div className='flex py-2 px-4 gap-2 w-full items-center cursor-pointer' onClick={() => toggleAllOption('notifyPosts', allData.notifyPosts === 'unchecked')}>
          <Note weight='duotone' className='w-5 h-5 cg-text-brand' />
          <span className='flex-1 cg-text-md-500 cg-text-main'>Posts</span>
          <CheckboxBase type={allData.notifyPosts === 'partial' ? 'checkminus' : 'checkbox'} size='small-20' checked={allData.notifyPosts !== 'unchecked'} />
        </div>
        <div className='flex py-2 px-4 gap-2 w-full items-center cursor-pointer' onClick={() => toggleAllOption('notifyEvents', allData.notifyEvents === 'unchecked')}>
          <Calendar weight='duotone' className='w-5 h-5 cg-text-brand' />
          <span className='flex-1 cg-text-md-500 cg-text-main'>Events</span>
          <CheckboxBase type={allData.notifyEvents === 'partial' ? 'checkminus' : 'checkbox'} size='small-20' checked={allData.notifyEvents !== 'unchecked'} />
        </div>
        <div className='flex py-2 px-4 gap-2 w-full items-center cursor-pointer' onClick={() => toggleAllOption('notifyCalls', allData.notifyCalls === 'unchecked')}>
          <Phone weight='duotone' className='w-5 h-5 cg-text-brand' />
          <span className='flex-1 cg-text-md-500 cg-text-main'>Calls</span>
          <CheckboxBase type={allData.notifyCalls === 'partial' ? 'checkminus' : 'checkbox'} size='small-20' checked={allData.notifyCalls !== 'unchecked'} />
        </div>
        <div className='cg-separator' />
        <div className='flex py-2 px-4 gap-2 w-full items-center cursor-pointer' onClick={() => toggleAllOption('myNewsletterEnabled', allData.myNewsletterEnabled === 'unchecked')}>
          <EnvelopeSimple weight='duotone' className='w-5 h-5 cg-text-brand' />
          <span className='flex-1 cg-text-md-500 cg-text-main'>Email Newsletters</span>
          <CheckboxBase type={allData.myNewsletterEnabled === 'partial' ? 'checkminus' : 'checkbox'} size='small-20' checked={allData.myNewsletterEnabled !== 'unchecked'} />
        </div>
      </div>}
    </div>}

    {currentCommunities.map(community => {
      const checkedState = calculateCheckedState(community);

      return <div className='flex flex-col cg-border-l cg-bg-subtle' key={community.id}>
        <div className='flex p-4 justify-between cursor-pointer' onClick={() => toggleCommunity(community.id)}>
          <div className='flex gap-2 flex-1 items-center overflow-hidden'>
            <ChevronRightIcon className={`w-5 h-5 transition-all${expandedCommunities.includes(community.id) ? ' rotate-90' : ''}`} />
            <CommunityPhoto size='tiny-20' community={community} noHover />
            <div className='flex-1 overflow-hidden'>{getCommunityDisplayName(community)}</div>
          </div>
          <div onClick={(ev) => ev.stopPropagation()}>
            <CheckboxBase
              size='small-20'
              type={checkedState === 'partial' ? 'checkminus' : 'checkbox'}
              checked={checkedState !== 'unchecked'}
              setChecked={(checked) => toggleAllCommunityOptions(community.id, checked)}
            />
          </div>
        </div>
        {expandedCommunities.includes(community.id) && <div className='flex flex-col gap-1 py-2'>
          <div className='flex py-2 px-4 gap-2 w-full items-center cursor-pointer' onClick={() => toggleOption(community.id, 'notifyMentions')}>
            <At weight='duotone' className='w-5 h-5 cg-text-brand' />
            <span className='flex-1 cg-text-md-500 cg-text-main'>Mentions</span>
            <CheckboxBase type='checkbox' size='small-20' checked={community.notificationState?.notifyMentions} />
          </div>
          <div className='flex py-2 px-4 gap-2 w-full items-center cursor-pointer' onClick={() => toggleOption(community.id, 'notifyReplies')}>
            <ArrowBendUpLeft weight='duotone' className='w-5 h-5 cg-text-brand' />
            <span className='flex-1 cg-text-md-500 cg-text-main'>Replies</span>
            <CheckboxBase type='checkbox' size='small-20' checked={community.notificationState?.notifyReplies} />
          </div>
          <div className='flex py-2 px-4 gap-2 w-full items-center cursor-pointer' onClick={() => toggleOption(community.id, 'notifyPosts')}>
            <Note weight='duotone' className='w-5 h-5 cg-text-brand' />
            <span className='flex-1 cg-text-md-500 cg-text-main'>Posts</span>
            <CheckboxBase type='checkbox' size='small-20' checked={community.notificationState?.notifyPosts} />
          </div>
          <div className='flex py-2 px-4 gap-2 w-full items-center cursor-pointer' onClick={() => toggleOption(community.id, 'notifyEvents')}>
            <Calendar weight='duotone' className='w-5 h-5 cg-text-brand' />
            <span className='flex-1 cg-text-md-500 cg-text-main'>Events</span>
            <CheckboxBase type='checkbox' size='small-20' checked={community.notificationState?.notifyEvents} />
          </div>
          <div className='flex py-2 px-4 gap-2 w-full items-center cursor-pointer' onClick={() => toggleOption(community.id, 'notifyCalls')}>
            <Phone weight='duotone' className='w-5 h-5 cg-text-brand' />
            <span className='flex-1 cg-text-md-500 cg-text-main'>Calls</span>
            <CheckboxBase type='checkbox' size='small-20' checked={community.notificationState?.notifyCalls} />
          </div>
          {community.enablePersonalNewsletter && config.EMAIL_ENABLED && <>
            <div className='cg-separator' />
            <div className='flex py-2 px-4 gap-2 w-full items-center cursor-pointer' onClick={() => toggleOption(community.id, 'newsletter')}>
              <EnvelopeSimple weight='duotone' className='w-5 h-5 cg-text-brand' />
              <span className='flex-1 cg-text-md-500 cg-text-main'>Email Newsletters</span>
              <CheckboxBase type='checkbox' size='small-20' checked={community.myNewsletterEnabled} />
            </div>
          </>}
        </div>}
      </div>;
    })}
  </div>);
}

export default React.memo(NotificationsPage);
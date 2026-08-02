// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './CommunityJoinedModal.css';
import RoleIcon from '../../atoms/icons/20/Role.svg?react';
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import confetti from 'canvas-confetti';
import Button from 'components/atoms/Button/Button';
import { XMarkIcon } from '@heroicons/react/24/solid';
import CommunityPhoto from 'components/atoms/CommunityPhoto/CommunityPhoto';
import communityApi from 'data/api/community';
import { useLiveQuery } from 'dexie-react-hooks';
import data from 'data';
import RoleCard from 'components/molecules/RoleCard/RoleCard';
import Tag from 'components/atoms/Tag/Tag';
import Scrollable from 'components/molecules/Scrollable/Scrollable';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import { PredefinedRole } from 'common/enums';
import ToggleInputField from 'components/molecules/inputs/ToggleInputField/ToggleInputField';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import { useOwnUser } from 'context/OwnDataProvider';
import { validateEmailInput } from 'common/validators';

type Props = {
  community: Models.Community.DetailView;
  onClose: () => void;
};

const CommunityJoinedModal: React.FC<Props> = ({ community, onClose }) => {
  const { isMobile, isTablet } = useWindowSizeContext();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [roleClaimability, setRoleClaimability] = useState<Record<string, boolean>>({});
  const [email, setEmail] = useState('');
  const [newsletterEnabled, setNewsletterEnabled] = useState(community.enablePersonalNewsletter);
  const ownUser = useOwnUser();
  const isDesktop = !isMobile && !isTablet;

  const roles = useLiveQuery(async () => {
    const allRoles = await data.community.getRoles(community.id);
    return allRoles.filter(role => ![PredefinedRole.Admin, PredefinedRole.Member, PredefinedRole.Public].includes(role.title as any));
  }, [community.id]) || [];

  useEffect(() => {
    const fetchClaimability = async () => {
      const result = await communityApi.checkCommunityRoleClaimability({
        communityId: community.id
      });
      setRoleClaimability(result.reduce((acc, role) => {
        return { ...acc, [role.roleId]: role.claimable };
      }, {}));
    }
    fetchClaimability();
  }, [community.id]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      const createdConfetti = confetti.create(canvas, { resize: true });
      createdConfetti({
        spread: 180,
        origin: { y: 0.1 },
        startVelocity: 20,
      });
    }
  }, []);

  const welcomeString = useMemo(() => {
    if (community.onboardingOptions?.customWelcome?.enabled) {
      const welcomeLines = community.onboardingOptions?.customWelcome?.welcomeString?.split('\n');
      return <div className='flex flex-col'>
        {welcomeLines?.map((line, index) => {
          const lineSplit = line.split('{community}');
          const lineClassname = `${index === 0 ? 'cg-heading-2 text-center' : 'cg-text-lg-400'} cg-text-secondary`;
          return (<span key={index} className={lineClassname}>
            {lineSplit.map((value, index) => (<>
              {index !== 0 && <span className='cg-text-main' key={'title' + index}>{community.title}</span>}
              {value}
            </>))}
          </span>);
        })}
      </div>
    }
    return <span className='cg-heading-2 cg-text-secondary text-center'>Welcome to <span className='cg-text-main'>{community.title}</span></span>;
  }, [community.onboardingOptions?.customWelcome?.enabled, community.onboardingOptions?.customWelcome?.welcomeString, community.title]);

  const rules = useMemo(() => {
    if (!community.onboardingOptions?.customWelcome?.enabled || !community.onboardingOptions.customWelcome.rules?.length) return null;

    return <>
      <span className='cg-text-lg-400 cg-text-main w-full'>Rules</span>
      <div className='flex flex-col cg-text-main rule-container w-full'>
        {community.onboardingOptions.customWelcome.rules.map(rule => <span key={rule} className='cg-text-md-400 p-4 text-center'>
          {rule}
        </span>)}
      </div>
    </>
  }, [community.onboardingOptions?.customWelcome?.enabled, community.onboardingOptions?.customWelcome?.rules]);

  const onFinish = useCallback(() => {
    const finalEmail = email || ownUser?.email;
    if (newsletterEnabled && !validateEmailInput(finalEmail || '')) {
      communityApi.subscribeToCommunityNewsletter({ communityIds: [community.id] });
    }
    onClose();
  }, [community.id, email, newsletterEnabled, onClose, ownUser?.email]);

  const newsletterContent = <div className='flex flex-col gap-2 w-full pt-2'>
    {community.enablePersonalNewsletter && <div className='flex gap-2 items-center self-center'>
      <span className='cg-text-lg-500 cg-text-secondary'>Get emails from this community</span>
      <ToggleInputField
        toggled={newsletterEnabled}
        onChange={setNewsletterEnabled}
        small
      />
    </div>}
    {!ownUser?.email && <>
      <TextInputField
        label='Email'
        value={email}
        onChange={setEmail}
        placeholder='your@email.com'
      />
      {newsletterEnabled && !!validateEmailInput(email) && <span className='cg-text-lg-500 cg-text-warning text-center'>Please add your email to continue, or disable community emails above</span>}
    </>}
  </div>;

  const content = <>
    <div className='joined-community-container flex flex-col justify-center items-center gap-2 flex-1 self-stretch relative'>
      <Scrollable>
        <div className={`flex flex-col py-5 px-6 items-center justify-center gap-2 flex-1 self-stretch${isDesktop ? ' pb-32' : ''}`}>
          <CommunityPhoto community={community} size='large' noHover />
          {welcomeString}
          {community.shortDescription && <span className='cg-text-lg-400 cg-text-main'>{community.shortDescription}</span>}
          {rules}
        </div>
      </Scrollable>
      {isDesktop && <div className='absolute left-0 right-0 bottom-0 flex flex-col gap-4 justify-center py-8 px-4 w-full'>
        {newsletterContent}
        <Button
          className='w-full'
          text='Done'
          role='primary'
          onClick={onFinish}
          disabled={!(!!ownUser?.email || !newsletterEnabled || !validateEmailInput(email))}
        />
      </div>}
    </div>

    {roles.length > 0 && <div className='flex flex-col joined-community-role-container'>
      <Scrollable>
        <div className='joined-community-role-content'>
          <div className='flex gap-2 p-2 items-center cg-text-main'>
            <RoleIcon className='w-5 h-5' />
            <span className='cg-heading-3'>{roles.length} Roles</span>
            <Tag
              label='Roles'
              tooltipPlacement='top'
              variant='help'
              tooltipContent={'Roles may unlock additional chats and content, or may be only cosmetic'}
            />
          </div>
          <div className='roles-list'>
            {roles.map(role => <RoleCard
              key={role.id}
              role={role}
              ownRole={community.myRoleIds.includes(role.id)}
              noClaimedModal
              simpleClaimedDetails
              locked={role.assignmentRules?.type !== 'free' && !roleClaimability[role.id]}
              onJoined={() => {
                const canvas = canvasRef.current;
                if (canvas) {
                  const createdConfetti = confetti.create(canvas, { resize: true });
                  createdConfetti({
                    spread: 180,
                    origin: { y: 0.1 },
                    startVelocity: 20,
                  });
                }
              }}
            />)}
          </div>
        </div>
      </Scrollable>
    </div>}
  </>;

  return (<ScreenAwareModal
    customClassname={`relative community-joined-modal${isDesktop ? '' : ' mobile-modal'}${roles.length === 0 ? ' no-roles' : ''}`}
    isOpen={true}
    onClose={onClose}
    hideHeader
    noDefaultScrollable
    modalRootStyle={{ zIndex: 10101 }}
  >
    <canvas ref={canvasRef} className='absolute w-full h-full top-0 left-0 cg-border-xxl pointer-events-none z-10' />
    {!isMobile && <Button
      className='absolute top-4 right-4 cg-circular z-10'
      role='secondary'
      iconLeft={<XMarkIcon className='w-6 h-6' />}
      onClick={onClose}
    />}
    <div className={`community-joined-modal-content${isDesktop ? '' : ' mobile-modal'}`}>
      {isDesktop && content}
      {!isDesktop && <>
        <Scrollable>
          {content}
        </Scrollable>
        <div className='flex flex-col gap-4 py-8 px-4 w-full'>
          {newsletterContent}
          <Button
            disabled={!(!!ownUser?.email || !newsletterEnabled || !validateEmailInput(email))}
            className='w-full'
            text='Done'
            role='primary'
            onClick={onFinish}
          />
        </div>
      </>}
    </div>
  </ScreenAwareModal>);
}

export default CommunityJoinedModal
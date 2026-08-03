// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { PredefinedRole } from 'common/enums';
import Button from '../../../../components/atoms/Button/Button';
import { useLoadedCommunityContext } from 'context/CommunityProvider';
import React, { useCallback, useMemo } from 'react'

import RoleIcon from '../../../atoms/icons/20/Role.svg?react';
import { HandArrowDown, Info } from '@phosphor-icons/react';
import { createSearchParams, useNavigate } from 'react-router-dom';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import { getUrl } from 'common/util';
import { useManagementContentModalContext } from 'components/organisms/ManagementContentModal/ManagementContentModalContext';
import SettingsButton from 'components/molecules/SettingsButton/SettingsButton';
import RolePhoto from 'components/molecules/RolePhoto/RolePhoto';
import { useCommunityPremiumTier } from 'hooks/usePremiumTier';

type Props = {
  selectedId: string;
  isCreating: boolean;
  onCreateRole: () => void;
  onSelectRole: (roleId: string) => void;
};

const RolesManagementList: React.FC<Props> = (props) => {
  const { selectedId, isCreating, onCreateRole, onSelectRole } = props;
  const { community } = useLoadedCommunityContext();
  const { roles } = useLoadedCommunityContext();
  const { isMobile } = useWindowSizeContext();
  const { modalSearchParameter } = useManagementContentModalContext();
  const navigate = useNavigate();

  const { tierData, canUpgradeTier } = useCommunityPremiumTier(community.premium);
  const roleLimit = tierData.ROLE_LIMIT;

  const [adminRole, guestRole, memberRole] = useMemo(() => {
    return [
      roles.find(role => role.title === PredefinedRole.Admin),
      roles.find(role => role.title === PredefinedRole.Public),
      roles.find(role => role.title === PredefinedRole.Member)
    ]
  }, [roles]);
  const customRoles = roles.filter(role => ![PredefinedRole.Admin, PredefinedRole.Member, PredefinedRole.Public].includes(role.title as PredefinedRole));
  const assignableRoles = customRoles.filter(role => !role.assignmentRules?.type);
  const claimableRoles = customRoles.filter(role => !!role.assignmentRules?.type);

  const navigatePremium = useCallback(() => {
    if (isMobile) {
      navigate(getUrl({ type: 'community-settings-upgrades', community }));
    } else {
      navigate({
        search: createSearchParams({
          [modalSearchParameter]: 'premium-management'
        }).toString()
      });
    }
  }, [community, isMobile, modalSearchParameter, navigate]);

  return (
    <div className='roles-management-list'>
      <div className='roles-management-roles-container'>
        <span className='roles-management-title'>Fixed roles</span>
        <div className='roles-management-roles'>
          <SettingsButton
            text="Admin"
            onClick={() => onSelectRole(adminRole?.id || '')}
            className='px-4'
            textClassName='cg-text-lg-400'
            active={selectedId === adminRole?.id}
            leftElement={<RolePhoto
              communityId={community.id}
              roleId={adminRole?.id || ''}
              imageId={adminRole?.imageId || null}
              tiny
            />}
          />
          <SettingsButton
            text="Guests"
            onClick={() => onSelectRole(guestRole?.id || '')}
            className='px-4'
            textClassName='cg-text-lg-400'
            active={selectedId === guestRole?.id}
            leftElement={<RolePhoto
              communityId={community.id}
              roleId={guestRole?.id || ''}
              imageId={guestRole?.imageId || null}
              tiny
            />}
          />
          <SettingsButton
            text="Members"
            onClick={() => onSelectRole(memberRole?.id || '')}
            className='px-4'
            textClassName='cg-text-lg-400'
            active={selectedId === memberRole?.id}
            leftElement={<RolePhoto
              communityId={community.id}
              roleId={memberRole?.id || ''}
              imageId={memberRole?.imageId || null}
              tiny
            />}
          />
        </div>
      </div>

      <div className='cg-separator' />
      <span className='cg-text-secondary cg-text-md-400'>{customRoles.length} of {roleLimit} custom roles</span>
      
      <div className='roles-management-roles-container'>
        <span className='roles-management-title'>Roles</span>
        <div className='roles-management-roles'>
          {assignableRoles.map(role => <SettingsButton
            key={role.id}
            text={role.title}
            onClick={() => onSelectRole(role.id)}
            className='px-4'
            textClassName='cg-text-lg-400'
            active={selectedId === role?.id}
            leftElement={<RolePhoto
              communityId={community.id}
              roleId={role?.id || ''}
              imageId={role?.imageId || null}
              tiny
            />}
          />)}
        </div>
      </div>

      <div className='cg-separator' />

      <div className='roles-management-roles-container'>
        <div className='flex items-center cg-text-secondary gap-2'>
          <HandArrowDown className='w-5 h-5'/> 
          <span className='roles-management-title'>Claimable Roles</span>
        </div>
        <div className='roles-management-roles'>
          {claimableRoles.map(role => <SettingsButton
            key={role.id}
            text={role.title}
            onClick={() => onSelectRole(role.id)}
            className='px-4'
            textClassName='cg-text-lg-400'
            active={selectedId === role?.id}
            leftElement={<RolePhoto
              communityId={community.id}
              roleId={role?.id || ''}
              imageId={role?.imageId || null}
              tiny
            />}
          />)}
        </div>
      </div>

      {roleLimit > customRoles.length && <Button
        className={'w-full'}
        iconLeft={<RoleIcon />}
        role={isCreating ? 'secondary' : 'primary'}
        text="Create role"
        active={isCreating}
        onClick={onCreateRole}
      />}

      {roleLimit <= customRoles.length && <div className='role-management-limit-tip'>
        <div className='flex gap-1'>
          <Info className='w-5 h-5' weight='duotone' />
          {canUpgradeTier && <span className='flex-1'>You’ve used up {customRoles.length}/{roleLimit} community roles. Please upgrade for more.</span>}
          {!canUpgradeTier && <span className='flex-1'>You’ve reached the maximum amount of roles! Please reach out to the CG team if you really need more 😊</span>}
        </div>
        {canUpgradeTier && <Button
          role='chip'
          className='max-w-full w-full'
          text='Upgrade'
          onClick={navigatePremium}
        />}
      </div>}
    </div>
  );
}

export default React.memo(RolesManagementList);
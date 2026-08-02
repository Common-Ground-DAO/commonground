// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect, useMemo, useState } from 'react'
import './RoleAssignmentList.css';
import { useLoadedCommunityContext } from 'context/CommunityProvider';
import RoleCard from 'components/molecules/RoleCard/RoleCard';
import Button from 'components/atoms/Button/Button';
import { InformationCircleIcon, WalletIcon } from '@heroicons/react/20/solid';
import { useLiveQuery } from 'dexie-react-hooks';
import data from 'data';
import communityApi from 'data/api/community';
import { useOwnUser, useOwnWallets } from 'context/OwnDataProvider';
import RoleIcon from '../../atoms/icons/20/Role.svg?react';
import { PredefinedRole } from 'common/enums';
import { useUserSettingsContext } from 'context/UserSettingsProvider';

const RoleAssignmentList = () => {
  const { community, ownRoles } = useLoadedCommunityContext();
  const { setIsOpen, setCurrentPage } = useUserSettingsContext();
  const [roleClaimability, setRoleClaimability] = useState<Record<string, boolean>>({});
  const [availableFilter, setAvailableFilter] = useState<'all' | 'claimable' | 'locked'>('all');
  const wallets = useOwnWallets();
  const ownUser = useOwnUser();
  const hasLuksoAcc = useMemo(() => ownUser?.accounts.find(acc => acc.type === 'lukso'), [ownUser?.accounts]);

  const roles = useLiveQuery(() => {
    return data.community.getRoles(community.id);
  }, [community.id]);

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

  const { allAvailableRoles, availableRoles, privateRoles } = useMemo(() => {
    if (!roles) return {
      allAvailableRoles: [],
      availableRoles: [],
      privateRoles: []
    };

    const ownRoleIds = ownRoles.map(role => role.id);
    const remainingRoles = roles.filter(role => !ownRoleIds.includes(role.id));

    const allAvailableRoles = remainingRoles.filter(role => role.assignmentRules?.type === 'free' || role.assignmentRules?.type === 'token');
    const availableRoles = remainingRoles.filter(role => {
      if (availableFilter === 'claimable') return role.assignmentRules?.type === 'free' || roleClaimability[role.id];
      else if (availableFilter === 'locked') return role.assignmentRules?.type === 'token' && !roleClaimability[role.id];
      else return role.assignmentRules?.type === 'free' || role.assignmentRules?.type === 'token';
    });
    const privateRoles = remainingRoles.filter(role => role.assignmentRules === null && role.title !== PredefinedRole.Public);
    return {allAvailableRoles, availableRoles, privateRoles};
  }, [availableFilter, ownRoles, roleClaimability, roles]);

  const hasLockedRole = availableRoles.some(role => role.assignmentRules?.type === 'token' && !roleClaimability[role.id]);

  return (<div className='role-assignment-list'>
    {ownRoles.length > 0 && <div className='role-assignment-list-section'>
      <div className='flex p-2 items-center gap-2 self-stretch cg-text-main cg-heading-3'>
        <RoleIcon className='w-5 h-5' />
        <span>Your roles</span>
      </div>
      <div className='role-assignment-list-section-container'>
        {ownRoles.map(role => <RoleCard key={role.id} role={role} ownRole />)}
      </div>
    </div>}

    {allAvailableRoles.length > 0 && <div className='role-assignment-list-section'>
      <div className='flex p-2 items-center gap-2 self-stretch cg-text-main cg-heading-3'>
        <RoleIcon className='w-5 h-5' />
        <span>Available roles</span>
      </div>
      <div className='flex items-center gap-1 cg-text-md-400 cg-text-secondary'>
        <InformationCircleIcon className='w-5 h-5' />
        <span className='flex-1'>Roles may unlock additional chats and content, or may be only cosmetic</span>
      </div>
      {!wallets?.length && !hasLuksoAcc && hasLockedRole && <div className='role-assigment-gated-actions-container'>
        <span className='cg-text-lg-500'>You need a wallet to unlock some of the roles below</span>
        <div className='role-assigment-gated-actions'>
          <Button
            role='primary'
            text='Connect a wallet'
            iconLeft={<WalletIcon className='w-5 h-5' />}
            onClick={() => {
              setCurrentPage('available-providers');
              setIsOpen(true);
            }}
          />
          <Button
            role='secondary'
            text='Get a wallet'
            onClick={() => {
              window.open('https://rainbow.me/', '_blank', 'noreferrer');
            }}
          />
        </div>
      </div>}
      <div className='flex gap-2'>
        <Button 
          className={availableFilter === 'all' ? 'active cg-text-md-500' : 'cg-text-md-500'}
          role='chip'
          text='All'
          onClick={() => setAvailableFilter('all')}
        />
        <Button 
          className={availableFilter === 'claimable' ? 'active cg-text-md-500' : 'cg-text-md-500'}
          role='chip'
          text='Claimable'
          onClick={() => setAvailableFilter('claimable')}
        />
        <Button 
          className={availableFilter === 'locked' ? 'active cg-text-md-500' : 'cg-text-md-500'}
          role='chip'
          text='Locked'
          onClick={() => setAvailableFilter('locked')}
        />
      </div>
      {availableRoles.length === 0 && <span className='cg-heading-3 cg-text-secondary'>Nothing to show here</span>}
      {availableRoles.length > 0 && <div className='role-assignment-list-section-container'>
        {availableRoles.map(role => <RoleCard
          key={role.id}
          role={role}
          locked={role.assignmentRules?.type === 'token' && !roleClaimability[role.id]}
        />)}
      </div>}
    </div>}

    {privateRoles.length > 0 && <div className='role-assignment-list-section'>
      <div className='flex p-2 items-center gap-2 self-stretch cg-text-main cg-heading-3'>
        <RoleIcon className='w-5 h-5' />
        <span>Private roles</span>
      </div>
      <div className='flex items-center gap-1 cg-text-md-400 cg-text-secondary'>
        <InformationCircleIcon className='w-5 h-5' />
        <span className='flex-1'>These roles cannot be claimed, and may only be assigned to you by an Admin or Plugin</span>
      </div>
      <div className='role-assignment-list-section-container'>
        {privateRoles.map(role => <RoleCard key={role.id} role={role} locked={!roleClaimability[role.id]} />)}
      </div>
    </div>}
  </div>)
}

export default React.memo(RoleAssignmentList);
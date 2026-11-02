// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { LockClosedIcon, XMarkIcon } from '@heroicons/react/24/solid';
import './GatedDialogModal.css';
import { PredefinedRole } from 'common/enums';
import Button from 'components/atoms/Button/Button';
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import RoleCard from 'components/molecules/RoleCard/RoleCard';
import data from 'data';
import communityApi from 'data/api/community';
import { useLiveQuery } from 'dexie-react-hooks';
import React, { useCallback, useEffect, useState } from 'react'
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import { useAsyncMemo } from 'hooks/useAsyncMemo';
import Jdenticon from 'components/atoms/Jdenticon/Jdenticon';
import { useNavigate } from 'react-router';
import { getUrl } from 'common/util';
import JoinCommunityButton from 'components/atoms/JoinCommunityButton/JoinCommunityButton';

export type CalculatedPermission = null | {
  type: 'community',
  communityId: string
} | {
  type: 'roles',
  communityId: string;
  rolePermissions: (
    Models.Community.CommunityArticlePermission |
    Models.Community.CommunityChannelPermission |
    Models.Community.EventPermission
  )[];
}

export async function calculatePermissions(article: API.Community.getArticleList.Response[0]): Promise<CalculatedPermission> {
  const { rolePermissions } = article.communityArticle;
  const publicPermission = rolePermissions.find(permission => permission.roleTitle === PredefinedRole.Public);
  const publicCanRead = publicPermission?.permissions.find(permission => permission === 'ARTICLE_READ');
  if (publicCanRead) return null;

  const myCommunities = await data.community.getOwnCommunities();
  const community = myCommunities.find(comm => comm.id === article.communityArticle.communityId);
  // If any of my roles has access, don't need to check further
  if (community?.myRoleIds.some(roleId => rolePermissions.some(rolePermission => rolePermission.roleId === roleId && rolePermission.permissions.includes('ARTICLE_READ')))) {
    return null;
  }

  const memberPermission = rolePermissions.find(permission => permission.roleTitle === PredefinedRole.Member);
  const memberCanRead = memberPermission?.permissions.find(permission => permission === 'ARTICLE_READ');
  // Also ask for community join if not part of the community
  if (!community || memberCanRead) return {
    type: 'community',
    communityId: article.communityArticle.communityId
  };

  return {
    type: 'roles',
    communityId: article.communityArticle.communityId,
    rolePermissions: rolePermissions.filter(role => role.permissions.includes('ARTICLE_READ')),
  };
}

type Props = {
  requiredPermissions: CalculatedPermission;
  isOpen: boolean;
  onClose: (redirect: boolean) => void;
};

const GatedDialogModal: React.FC<Props> = (props) => {
  const { isOpen, onClose, requiredPermissions } = props;
  const navigate = useNavigate();
  const [roleClaimability, setRoleClaimability] = useState<Record<string, boolean> | null>(null);
  const { isMobile } = useWindowSizeContext();

  const community = useLiveQuery(() => {
    if (requiredPermissions?.communityId && isOpen) return data.community.getCommunityDetailView(requiredPermissions?.communityId);
    return null;
  }, [requiredPermissions?.communityId, isOpen]);

  const communityUsers = useAsyncMemo(async () => {
    if (isOpen && requiredPermissions?.type === 'community' && requiredPermissions?.communityId) {
      const result = await communityApi.getMemberList({ communityId: requiredPermissions?.communityId, limit: 6, offset: 0 });
      const memberIds = [...result.online.map(u => u[0]), ...result.offline.map(u => u[0])];
      return {
        memberIds,
        totalCount: result.totalCount
      }
    }
  }, [isOpen, requiredPermissions?.type, requiredPermissions?.communityId]);

  useEffect(() => {
    const fetchClaimability = async () => {
      if (!roleClaimability && community?.id && requiredPermissions?.type === 'roles') {
        const result = await communityApi.checkCommunityRoleClaimability({
          communityId: community.id
        });
        setRoleClaimability(result.reduce((acc, role) => {
          return { ...acc, [role.roleId]: role.claimable };
        }, {}));
      }
    }
    fetchClaimability();
  }, [requiredPermissions?.type, community?.id, roleClaimability]);

  const communityRoles = useLiveQuery(() => {
    if (requiredPermissions?.communityId && requiredPermissions?.type === 'roles') return data.community.getRoles(requiredPermissions?.communityId);
    return null;
  }, [requiredPermissions?.communityId, requiredPermissions?.type]);

  const relevantRoles = useLiveQuery(() => {
    if (!communityRoles || requiredPermissions?.type !== 'roles') return null;
    return communityRoles.filter(role => role.type !== 'PREDEFINED' && requiredPermissions.rolePermissions.some(rolePermission => rolePermission.roleId === role.id));
  }, [communityRoles, requiredPermissions]);

  const lockedMessage = requiredPermissions?.type === 'community' ?
    'Join the community to check this out' : (relevantRoles?.length || 0) > 0 ?
    'You need a role to check this out' : 'There are no roles you can claim to unlock this';

  const visitCommunity = useCallback(async (ev: React.MouseEvent) => {
    ev.stopPropagation();
    if (community) {
      navigate(getUrl({type: 'community-lobby', community}));
      onClose(false);
    }
  }, [community, navigate, onClose]);

  return <ScreenAwareModal
    isOpen={isOpen}
    onClose={() => onClose(false)}
    hideHeader
    customClassname='relative'
  >
    <div className={`cg-text-main${isMobile ? ' px-4' : ''}`}>
      <div className='flex flex-col items-center gap-2 py-5 px-6'>
        <div className='gated-icon'>
          <LockClosedIcon className='w-12 h-12' />
        </div>
        <span className='cg-heading-2'>Locked</span>
        <span className='cg-text-lg-400'>{lockedMessage}</span>
      </div>
      {requiredPermissions?.type === 'community' && <>
        {communityUsers && <div className='flex flex-col gap-2 justify-center items-center'>
          <div className='flex gap-0.5'>
            {communityUsers.memberIds.map(memberId => <Jdenticon
              key={memberId}
              userId={memberId}
              predefinedSize='32'
            />)}
          </div>
          {communityUsers.totalCount > communityUsers.memberIds.length && <span className='cg-text-md-400 cg-text-secondary'>
            and {communityUsers.totalCount - communityUsers.memberIds.length} others are in this community
          </span>}
        </div>}

        <div className='py-8 px-4 gap-2 flex flex-col items-center justify-center'>
          <JoinCommunityButton
            community={community || undefined}
            className='w-full max-w-xs'
            onStartUserOnboarding={() => onClose(false)}
            onSuccess={() => onClose(true)}
          />
          <Button
            className='w-full max-w-xs'
            role='secondary'
            text='Visit community'
            onClick={visitCommunity}
          />
        </div>
      </>}
      {requiredPermissions?.type === 'roles' && relevantRoles?.length !== 0 && <div className='gated-dialog-roles'>
        {relevantRoles?.map(role => <RoleCard
          key={role.id}
          role={role}
          locked={role.assignmentRules === null || (role.assignmentRules?.type === 'token' && !roleClaimability?.[role.id])}
          onJoined={() => onClose(true)}
        />)}
      </div>}
    </div>
    <div className="gated-close"><XMarkIcon className="w-6 h-6" onClick={() => onClose(false)} /></div>
  </ScreenAwareModal>
}

export default GatedDialogModal
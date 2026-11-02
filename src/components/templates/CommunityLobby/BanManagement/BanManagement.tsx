// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import "./BanManagement.css";
import React, { useMemo, useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router";

import { useLoadedCommunityContext } from "../../../../context/CommunityProvider";
import { useCommunitySidebarContext } from "../../../organisms/CommunityViewSidebar/CommunityViewSidebarContext";
import { useWindowSizeContext } from "../../../../context/WindowSizeProvider";

import LeaveCommunityModal from "../../../organisms/LeaveCommunityModal/LeaveCommunityModal";
import Scrollable from "components/molecules/Scrollable/Scrollable";
import { useUserData } from "context/UserDataProvider";

import Button from "components/atoms/Button/Button";
import communityApi from "data/api/community";
import { Asterisk, Warning } from "@phosphor-icons/react";
import { UserBlockState } from "common/enums";
import { ChevronDownIcon } from "@heroicons/react/20/solid";
import ScreenAwarePopover from "components/atoms/ScreenAwarePopover/ScreenAwarePopover";
import { useSnackbarContext } from "context/SnackbarContext";
import { PopoverHandle } from "components/atoms/Tooltip/Tooltip";
import ManagementHeader2 from "components/molecules/ManagementHeader2/ManagementHeader2";
import UserTag from "components/atoms/UserTag/UserTag";

export default function BanManagement() {
  const navigate = useNavigate();
  const { isMobile } = useWindowSizeContext();
  const { showLeaveGroupModal, setShowLeaveGroupModal } = useCommunitySidebarContext();
  const { community, communityPermissions } = useLoadedCommunityContext();
  const { showSnackbar } = useSnackbarContext();
  const [bannedUsers, setBannedUsers] = useState<Models.Community.UserBanState[] | null>(null);
  const hasModeratePermission = communityPermissions.has('COMMUNITY_MODERATE');

  useEffect(() => {
    let active = true;
    const fetch = async () => {
      if (hasModeratePermission) {
        const result = await communityApi.getBannedUsers({ communityId: community.id });
        if (active) setBannedUsers(result);
      }
    }

    fetch();

    return () => { active = false; }
  }, [community.id, hasModeratePermission]);

  const updateBanState = useCallback(async (userId: string, blockState: Models.Community.UserBlockState | null, blockStateUntil: string | null) => {
    try {
      await communityApi.setUserBlockState({ communityId: community.id, userId, blockState, until: blockStateUntil });
      if (blockState === null) {
        setBannedUsers(oldBannedUsers => oldBannedUsers ? oldBannedUsers.filter(bannedUser => bannedUser.userId !== userId) : null);
      }
      else {
        setBannedUsers(oldBannedUsers => oldBannedUsers ? oldBannedUsers.map(bannedUser => bannedUser.userId === userId ? { ...bannedUser, blockState, blockStateUntil } : bannedUser) : null);
      }
      showSnackbar({ type: 'success', text: 'Ban state updated' });
    } catch (e) {
      showSnackbar({ type: 'warning', text: 'Something went wrong, please try again later' });
    }
  }, [community.id, showSnackbar]);

  const className = [
    "ban-management cg-text-main",
    isMobile ? 'mobile-ban-management' : 'desktop-ban-management'
  ].join(' ');

  const bannedUsersContent = useMemo(() => {return <div className="flex flex-col gap-2">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div className={`flex gap-2 items-center ${isMobile ? 'px-4' : ''}`}>
          <span>{bannedUsers ? `${bannedUsers.length} banned users` : `Loading banned users...`}</span>
          <div className="flex gap-1 items-center">
            <Asterisk weight='duotone' className="w-4 h-4 cg-text-warning" />
            <span className="cg-text-secondary cg-text-md-400 flex-1">Only visible to Admins</span>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {bannedUsers?.map(bannedUser => <BannedUserItem
          key={bannedUser.userId}
          banState={bannedUser}
          communityId={community.id}
          updateBanState={updateBanState}
        />)}
      </div>
      {bannedUsers && bannedUsers.length === 0 && <div className="flex justify-center items-center h-full">
        <span className="cg-text-secondary cg-text-md-400">No banned users</span>
      </div>}
    </div>
  }, [bannedUsers, community.id, updateBanState]);

  if (isMobile) {
    return (
      <>
        <div className={className}>
          <ManagementHeader2
            title="Banned users"
            goBack={() => navigate(-1)}
          />
          <Scrollable>
            {bannedUsersContent}
          </Scrollable>
        </div>
        <LeaveCommunityModal open={showLeaveGroupModal} onClose={() => setShowLeaveGroupModal(false)} />
      </>
    );
  }
  else {
    return (
      <Scrollable>
        <div className="ban-management-view-inner">
          <div className={className}>
            <ManagementHeader2
              title="Manage banned users"
              goBack={() => navigate(-1)}
            />
            {bannedUsersContent}

          </div>
          <LeaveCommunityModal open={showLeaveGroupModal} onClose={() => setShowLeaveGroupModal(false)} />
        </div>
      </Scrollable>
    );
  }
}

type BannedUserProps = {
  banState: Models.Community.UserBanState;
  communityId: string;
  updateBanState: (userId: string, blockState: Models.Community.UserBlockState | null, blockStateUntil: string | null) => void;
}

const BannedUserItem: React.FC<BannedUserProps> = (props) => {
  const { banState, updateBanState } = props;
  const user = useUserData(banState.userId);
  const unbanRef = useRef<PopoverHandle>(null);

  return <div className="ban-management-item">
    <div className="flex flex-col px-2 pt-2">
      <div className="ban-management-user-item">
        {user && <UserTag
          userData={user}
          jdenticonSize="40"
          noOfflineDimming
          hideStatus
          largeNameFont
        />}
        <div className="flex items-center gap-4">
          <ScreenAwarePopover
            ref={unbanRef}
            triggerContent={<Button
              iconLeft={<Warning className="w-4 h-4 cg-text-warning" />}
              text='Manage'
              iconRight={<ChevronDownIcon className="w-4 h-4" />}
              role="textual"
            />}
            triggerType="click"
            closeOn="toggle"
            placement="bottom"
            tooltipContent={<div className="flex flex-col gap-2 p-3">
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-2">
                  <div className="flex flex-col gap-2">
                    <span className="cg-text-secondary cg-text-md-400">User is {banState.blockState === UserBlockState.BANNED ? 'banned' : 'muted'} {banState.blockStateUntil ? `until ${new Date(banState.blockStateUntil).toLocaleDateString()} at ${new Date(banState.blockStateUntil).toLocaleTimeString()}` : 'permanently'}</span>
                  </div>
                </div>
              </div>
              <Button
                className="w-full"
                role="chip"
                text={banState.blockState === UserBlockState.BANNED ? 'Unban' : 'Unmute'}
                onClick={() => updateBanState(banState.userId, null, null)}
              />
            </div>}
          />
        </div>
      </div>
    </div>
  </div>;
}

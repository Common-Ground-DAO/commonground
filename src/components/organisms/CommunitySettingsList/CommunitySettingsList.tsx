// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useNavigate } from "react-router-dom";

import DropdownItem from "../../atoms/ListItem/ListItem";
import { useCommunitySidebarContext } from "../CommunityViewSidebar/CommunityViewSidebarContext";
import { useLoadedCommunityContext } from "../../../context/CommunityProvider";
import { getUrl } from 'common/util';
import { ShareListItem } from "components/atoms/ShareButton/ShareButton";

import './CommunitySettingsList.css';

export type CommunitySettingsListItem = 'community' | 'areas' | 'members' | 'roles' | 'upgrades' | 'token' | 'onboarding' | 'plugins' | 'bots' | 'ban-management';

type Props = {
  onClick?: () => void;
};

export default function CommunitySettingsList(props: Props) {
  const navigate = useNavigate();
  const { setShowLeaveGroupModal } = useCommunitySidebarContext();
  const { community, communityPermissions } = useLoadedCommunityContext();

  const canManage = communityPermissions.has('COMMUNITY_MANAGE_INFO') ||
    communityPermissions.has('COMMUNITY_MANAGE_CHANNELS') ||
    communityPermissions.has('COMMUNITY_MANAGE_ROLES') ||
    communityPermissions.has('COMMUNITY_MANAGE_ROLES');

  return (
    <div className="community-settings-list">
      {canManage &&
        <DropdownItem title="Community settings" onClick={() => {
          navigate(getUrl({ type: 'community-settings', community }));
          props.onClick?.();
        }} />
      }
      {/* {communityPermissions.has('COMMUNITY_MANAGE_ARTICLES') && 
        <DropdownItem title="Content" description="Manage content, visibility, in bulk!" disabled />
      }
      {Array.from(ownRolesById.values()).some(role => role.title === PredefinedRole.Admin) && // only for admins
        <DropdownItem title="Analytics" description="Track community and content performance" disabled />
      } */}
      <ShareListItem
        key='Invite friends'
        title="Invite friends"
        contentText={`Join "${community.title}" on Common Ground`}
        contentTitle={community.title}
        relativeUrl={getUrl({ type: 'community-lobby', community })}
        onClick={props.onClick}
      />
      <DropdownItem className="cg-text-error" key="leave" title="Leave community" onClick={() => {
        setShowLeaveGroupModal(true)
        props.onClick?.();
      }}/>
    </div>
  )
}

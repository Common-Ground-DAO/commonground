// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md


import { useWindowSizeContext } from "../../context/WindowSizeProvider";

import Scrollable from "../../components/molecules/Scrollable/Scrollable";
import { useNavigate } from "react-router-dom";
import { useLoadedCommunityContext } from "context/CommunityProvider";
import { getUrl } from 'common/util';
import CommunityHeaderSimple from "components/organisms/CommunityHeader/CommunityHeaderSimple";
import { useCallback, useEffect } from "react";
import { CommunitySettingsListItem } from "components/organisms/CommunitySettingsList/CommunitySettingsList";
import SparkIcon from 'components/atoms/icons/misc/spark.svg?react';

import "./CommunitySettingsView.css";
import { PredefinedRole, RoleType } from "common/enums";
import { ChatsTeardrop, HandWaving, HouseSimple, Plug, PokerChip, Robot, UserCircle, Users, Prohibit } from "@phosphor-icons/react";
import ManagementHeader2 from "components/molecules/ManagementHeader2/ManagementHeader2";
import SettingsButton from "components/molecules/SettingsButton/SettingsButton";

type Props = {

}

export default function CommunitySettingsView(props: Props) {
  const { isMobile } = useWindowSizeContext();
  const { community, communityPermissions, ownRoles } = useLoadedCommunityContext();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isMobile) {
      navigate(getUrl({ type: 'community-lobby', community: { url: community.url } }));
    }
  }, [isMobile, community.url, navigate]);

  const navigateToManagementPage = useCallback((activeSettingItem: CommunitySettingsListItem) => {
    switch (activeSettingItem) {
      case 'community': {
        navigate(getUrl({ type: 'community-settings-info', community }));
        break;
      }
      case 'areas': {
        navigate(getUrl({ type: 'community-settings-areas-and-channels', community }));
        break;
      }
      case 'members': {
        navigate(getUrl({ type: 'community-settings-members', community }));
        break;
      }
      case 'ban-management': {
        navigate(getUrl({ type: 'community-settings-bans', community }));
        break;
      }
      case 'roles': {
        navigate(getUrl({ type: 'community-settings-roles', community }));
        break;
      }
      case 'upgrades': {
        navigate(getUrl({ type: 'community-settings-upgrades', community }));
        break;
      }
      case 'token': {
        navigate(getUrl({ type: 'community-settings-token', community }));
        break;
      }
      case 'onboarding': {
        navigate(getUrl({ type: 'community-settings-onboarding', community }));
        break;
      }
      case 'plugins': {
        navigate(getUrl({ type: 'community-settings-plugins', community }));
        break;
      }
      case 'bots': {
        navigate(getUrl({ type: 'community-settings-bots', community }));
        break;
      }
    }
  }, [community, navigate]);

  return (
    <div className="community-settings-view">
      <ManagementHeader2
        title="Admin settings"
        goBack={() => navigate(getUrl({ type: 'community-lobby', community }))}
      />
      <Scrollable>
        <div className="flex flex-col gap-4">
          <CommunityHeaderSimple />
          <div className="flex flex-col px-4 gap-1">
            {communityPermissions.has('COMMUNITY_MANAGE_INFO') && <SettingsButton
              className="max-w-full w-full justify-between"
              text="General"
              leftElement={<HouseSimple weight="duotone" className="w-5 h-5"/>}
              onClick={() => navigateToManagementPage('community')}
            />}
            {ownRoles.some(role => role.title === PredefinedRole.Admin && role.type === RoleType.PREDEFINED) && <SettingsButton
              className="max-w-full w-full justify-between"
              text="Premium"
              leftElement={<SparkIcon className="w-5 h-5" />}
              onClick={() => navigateToManagementPage('upgrades')}
            />}
            {communityPermissions.has('COMMUNITY_MANAGE_ROLES') && <SettingsButton
              className="max-w-full w-full justify-between"
              text="Onboarding"
              leftElement={<HandWaving weight="duotone" className="w-5 h-5" />}
              onClick={() => navigateToManagementPage('onboarding')}
            />}
            {(
              communityPermissions.has('COMMUNITY_MANAGE_ROLES') ||
              communityPermissions.has('COMMUNITY_MODERATE')
            ) && <SettingsButton
              className="max-w-full w-full justify-between"
              text="Members"
              leftElement={<Users weight="duotone" className="w-5 h-5" />}
              onClick={() => navigateToManagementPage('members')}
            />}
            {(
              communityPermissions.has('COMMUNITY_MODERATE')
            ) && <SettingsButton
              className="max-w-full w-full justify-between"
              text="Manage Bans"
              leftElement={<Prohibit weight="duotone" className="w-5 h-5" />}
              onClick={() => navigateToManagementPage('ban-management')}
            />}
            {communityPermissions.has('COMMUNITY_MANAGE_CHANNELS') && <SettingsButton
              className="max-w-full w-full justify-between"
              text="Channels"
              leftElement={<ChatsTeardrop weight="duotone" className="w-5 h-5" />}
              onClick={() => navigateToManagementPage('areas')}
            />}
            {communityPermissions.has('COMMUNITY_MANAGE_ROLES') && <SettingsButton
              className="max-w-full w-full justify-between"
              text="Roles"
              leftElement={<UserCircle weight="duotone" className="w-5 h-5" />}
              onClick={() => navigateToManagementPage('roles')}
            />}
            {communityPermissions.has('COMMUNITY_MANAGE_ROLES') && <SettingsButton
              className="max-w-full w-full justify-between"
              text="Token"
              leftElement={<PokerChip weight="duotone" className="w-5 h-5"/>}
              onClick={() => navigateToManagementPage('token')}
            />}
            {communityPermissions.has('COMMUNITY_MANAGE_ROLES') && <SettingsButton
              className="max-w-full w-full justify-between"
              text="Bots"
              leftElement={<Robot weight="duotone" className="w-5 h-5"/>}
              onClick={() => navigateToManagementPage('bots')}
            />}
            {ownRoles.some(role => role.title === PredefinedRole.Admin && role.type === RoleType.PREDEFINED) && <SettingsButton
              className="max-w-full w-full justify-between"
              text="Plugins"
              leftElement={<Plug weight="duotone" className="w-5 h-5"/>}
              onClick={() => navigateToManagementPage('plugins')}
            />}
          </div>
        </div>
      </Scrollable>
    </div>
  );

}

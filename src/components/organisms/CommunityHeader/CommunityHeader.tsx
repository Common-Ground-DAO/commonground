// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useMemo } from "react";
import { createSearchParams, useLocation, useNavigate } from "react-router-dom";
import { useSignedUrl } from '../../../hooks/useSignedUrl';

import CommunitySettings from "../CommunitySettings/CommunitySettings";
import CommunitySettingsList from "../CommunitySettingsList/CommunitySettingsList";
import LeaveCommunityModal from "../LeaveCommunityModal/LeaveCommunityModal";
import ManagementContentModal from "../ManagementContentModal/ManagementContentModal";
import ManagementContentModalInnerWrapper from "../ManagementContentModal/ManagementContentModalWrappers/ManagementContentModalInnerWrapper";
// import ManagementContentModalFooterButton from "../ManagementContentModal/ManagementContentModalFooterButton/ManagementContentModalFooterButton";
import ManagementContentModalMenu, { ManagementContentModalMenuItem } from "../ManagementContentModal/ManagementContentModalMenu/ManagementContentModalMenu";
import ManagementContentModalMenuWrapper from "../ManagementContentModal/ManagementContentModalWrappers/ManagementContentModalMenuWrapper";
import Dropdown from "../../../components/molecules/Dropdown/Dropdown";
import DropdownItem from "../../atoms/ListItem/ListItem";

import { useLoadedCommunityContext } from "context/CommunityProvider";
import { useCommunitySidebarContext } from "../CommunityViewSidebar/CommunityViewSidebarContext";
import { useWindowSizeContext } from "../../../context/WindowSizeProvider";

import { ReactComponent as NotAllowedIcon } from '../../../components/atoms/icons/16/NotAllowed.svg';
import { ReactComponent as ChevronDownIcon } from '../../../components/atoms/icons/16/ChevronDown.svg';
import { ReactComponent as SparkIcon } from '../../../components/atoms/icons/misc/spark.svg';
import { PredefinedRole, RoleType } from "common/enums";
import { getUrl } from 'common/util';

import './CommunityHeader.css';
import BottomSliderModal from "components/atoms/BottomSliderModal/BottomSliderModal";
import { ShareListItem } from "components/atoms/ShareButton/ShareButton";
import { getCommunityDisplayName } from "../../../util";
import { Asterisk, ChatsTeardrop, DoorOpen, Envelope, EnvelopeSimple, HandWaving, HouseSimple, Plug, PokerChip, Prohibit, Robot, UserCircle, UserCirclePlus, Users } from "@phosphor-icons/react";
import { useOwnUser } from "context/OwnDataProvider";
import communityApi from "data/api/community";
import { useEmailConfirmationContext } from "context/EmailConfirmationProvider";

type Props = {
  onHeaderClick?: () => void;
  banned?: string;
  collapsed?: boolean;
};

const CommunityHeader: React.FC<Props> = ({ onHeaderClick, banned, collapsed }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const ownUser = useOwnUser();
  const { community, communityPermissions, ownRoles } = useLoadedCommunityContext();
  const { showLeaveGroupModal, setShowLeaveGroupModal } = useCommunitySidebarContext();
  const { openModal: openEmailConfirmationModal } = useEmailConfirmationContext();
  const { isMobile } = useWindowSizeContext();
  const imageUrl = useSignedUrl(community.logoLargeId || community.logoSmallId);

  const hasSettings = communityPermissions.has('COMMUNITY_MANAGE_INFO')
    || communityPermissions.has('COMMUNITY_MANAGE_CHANNELS')
    || communityPermissions.has('COMMUNITY_MANAGE_ROLES');

  const [isMobileModalOpen, setIsMobileModalOpen] = React.useState(false);

  const handleLeaveCommunityClick = React.useCallback(() => {
    setShowLeaveGroupModal(true);
  }, [setShowLeaveGroupModal]);

  const onClickJoinNewsletter = useCallback(async () => {
    try {
      if (!ownUser?.email) {
        openEmailConfirmationModal("signup");
        return;
      }
      await communityApi.subscribeToCommunityNewsletter({ communityIds: [community.id] });
    } catch (error) {
      console.error(error);
    }
  }, [community.id, openEmailConfirmationModal, ownUser?.email]);

  const joined = community.myRoleIds.length > 0;

  const openSettings = useCallback(() => {
    if (isMobile) {
      setIsMobileModalOpen(true);
    } else {
      navigate({
        pathname: location.pathname,
        search: createSearchParams({
          modal: 'manage-community'
        }).toString()
      });
    }
  }, [isMobile, location.pathname, navigate]);

  const communityHeader = React.useMemo(() => {
    const title = <div className="group-caption">
      {getCommunityDisplayName(community)}
      {joined && <ChevronDownIcon key="chevronDown" />}
    </div>

    if (!joined) {
      return <div className="group-caption-container">
        {title}
      </div>;
    } else {
      const items = [
        // <DropdownItem title="Notifications" key='Notifications' />,
        <ShareListItem
          key='Invite friends'
          title="Invite friends"
          contentText={`Join "${community.title}" on Common Ground`}
          contentTitle={community.title}
          relativeUrl={getUrl({ type: 'community-lobby', community })}
          icon={<UserCirclePlus weight="duotone" className="w-5 h-5" />}
        />,
        <DropdownItem
          onClick={handleLeaveCommunityClick}
          title="Leave Community"
          key='Leave Community'
          className="cg-text-warning font-medium"
          iconRight={<DoorOpen weight="duotone" className="w-5 h-5 cg-text-warning" />}
        />
      ];

      if (community.enablePersonalNewsletter && !community.myNewsletterEnabled) {
        items.splice(1,0,<DropdownItem
          onClick={onClickJoinNewsletter}
          title="Join Newsletter"
          key='Join Newsletter'
          className="font-medium"
          iconRight={<Envelope weight="duotone" className="w-5 h-5" />}
        />);
      }

      if (hasSettings) items.unshift(<DropdownItem
        onClick={openSettings}
        title="Community Settings"
        key='Community Settings'
        className="cg-text-brand font-medium"
        iconRight={<Asterisk weight="duotone" className="w-5 h-5 cg-text-brand"/>}
      />);

      if (isMobile) {
        return <div className="group-caption-container" onClick={(ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openSettings();
        }}>
          {title}
        </div>;
      } else {
        return (
          <Dropdown
            items={items}
            triggerClassname="group-caption-container"
            triggerContent={title}
            className="group-options-dropdown"
          />
        );
      }
    }
  }, [community, joined, handleLeaveCommunityClick, hasSettings, openSettings, isMobile, onClickJoinNewsletter]);

  const closeMobileModal = useCallback(() => {
    setIsMobileModalOpen(false);
  }, []);

  const bottomSliderModalComponent = useMemo(() => {
    if (isMobile) {
      return <BottomSliderModal
        isOpen={isMobileModalOpen}
        onClose={closeMobileModal}
      >
        <CommunitySettingsList onClick={closeMobileModal} />
      </BottomSliderModal>
    }
    return null;
  }, [isMobile, isMobileModalOpen]);

  const menuItems = useMemo(() => {
    if (!isMobile) {
      const menuItems: JSX.Element[] = [];
      if (communityPermissions.has('COMMUNITY_MANAGE_INFO')) {
        menuItems.push(<ManagementContentModalMenuItem leftElement={<HouseSimple weight="duotone" className="w-5 h-5"/>} key="General" text="General" url="manage-community" />);
      }
      if (ownRoles.some(role => role.title === PredefinedRole.Admin && role.type === RoleType.PREDEFINED)) {
        menuItems.push(<ManagementContentModalMenuItem key="Premium" leftElement={<SparkIcon className="w-5 h-5" />} text="Premium" url="premium-management" />);
      }
      if (communityPermissions.has('COMMUNITY_MANAGE_ROLES')) {
        menuItems.push(<ManagementContentModalMenuItem key="Onboarding" leftElement={<HandWaving weight="duotone" className="w-5 h-5" />} text="Onboarding" url="onboarding-management" />);
      }
      if (communityPermissions.has('COMMUNITY_MANAGE_INFO')) {
        menuItems.push(<ManagementContentModalMenuItem key="newsletters" leftElement={<EnvelopeSimple weight="duotone" className="w-5 h-5" />} text="Newsletters" url="newsletters" />);
      }
      if (communityPermissions.has('COMMUNITY_MANAGE_ROLES')) {
        menuItems.push(<ManagementContentModalMenuItem key="Members" leftElement={<Users weight="duotone" className="w-5 h-5" />} text="Members" url="members" />);
      }
      if (communityPermissions.has('COMMUNITY_MODERATE')) {
        menuItems.push(<ManagementContentModalMenuItem key="Manage Bans" leftElement={<Prohibit weight="duotone" className="w-5 h-5" />} text="Manage Bans" url="ban-management" />);
      }
      if (communityPermissions.has('COMMUNITY_MANAGE_CHANNELS')) {
        menuItems.push(<ManagementContentModalMenuItem key="Channels" leftElement={<ChatsTeardrop weight="duotone" className="w-5 h-5" />} text="Channels" url="areas-channels" />);
      }
      if (communityPermissions.has('COMMUNITY_MANAGE_ROLES')) {
        menuItems.push(<ManagementContentModalMenuItem key="Roles" leftElement={<UserCircle weight="duotone" className="w-5 h-5" />} text="Roles &amp; Permissions" url="roles-management" />);
      }
      if (communityPermissions.has('COMMUNITY_MANAGE_ROLES')) {
        menuItems.push(<ManagementContentModalMenuItem key="Token" leftElement={<PokerChip weight="duotone" className="w-5 h-5"/>} text="Token" url="token-management" />);
      }
      if (communityPermissions.has('COMMUNITY_MANAGE_ROLES')) {
        menuItems.push(<ManagementContentModalMenuItem key="Bots" leftElement={<Robot weight="duotone" className="w-5 h-5"/>} text="Bots" url="bot-management" />);
      }
      if (ownRoles.some(role => role.title === PredefinedRole.Admin && role.type === RoleType.PREDEFINED)) {
        menuItems.push(<ManagementContentModalMenuItem key="Plugins" leftElement={<Plug weight="duotone" className="w-5 h-5" />} text="Plugins" url="plugins" />);
      }
      return menuItems;
    }
    return null;
  }, [communityPermissions, ownRoles, isMobile]);

  const managementModalContent = useMemo(() => {
    if (!isMobile && hasSettings && !!menuItems) {
      return <ManagementContentModal
        title="Community settings"
      >
        <ManagementContentModalMenuWrapper>
          {menuItems.length > 0 && <ManagementContentModalMenu
            items={menuItems}
          />}
          {/* <ManagementContentModalMenu
            title="User"
            items={[
              <ManagementContentModalMenuItem text="Notifications" url="notifications" />,
            ]}
          /> */}
          {/* <ManagementContentModalMenu
            title="Coming soon"
            items={[
              <ManagementContentModalMenuItem key="Notifications" text="Notifications" url="notifications" disabled />,
              <ManagementContentModalMenuItem key="Roles &amp; Permissions" text="Roles &amp; Permissions" url="roles-permissions" disabled />,
              <ManagementContentModalMenuItem key="Content" text="Content" url="content" disabled />,
              <ManagementContentModalMenuItem key="Ban list" text="Ban list" url="ban-list" disabled />,
              <ManagementContentModalMenuItem key="Analytics" text="Analytics" url="analytics" disabled />,
            ]}
          /> */}
        </ManagementContentModalMenuWrapper>
        <ManagementContentModalInnerWrapper>
          <CommunitySettings />
        </ManagementContentModalInnerWrapper>
        {/* <ManagementContentModalFooterButton text="Leave community" onClick={handleLeaveCommunityClick} /> */}
      </ManagementContentModal>;
    }
    return null;
  }, [isMobile, hasSettings, menuItems]);

  const settingsModal = React.useMemo(() => {
    if (!joined) return null;

    if (isMobile) {
      return bottomSliderModalComponent;
    }
    else {
      return managementModalContent;
    }
  }, [joined, hasSettings, isMobile ? bottomSliderModalComponent : managementModalContent]);

  const handleHeaderClick = useCallback(() => {
    onHeaderClick && onHeaderClick();
    navigate(getUrl({ type: 'community-lobby', community }));
  }, [community, navigate, onHeaderClick]);

  return (
    <div
      className={`community-header${location.pathname === `/community/${community.id}` ? " community-header-active" : ""}${collapsed ? ' collapsed' : ''}`}
      onClick={handleHeaderClick}
    >
      {collapsed && <div style={{ backgroundImage: `url(${imageUrl})` }} className='community-header-background-blurred' />}
      <div className={`community-container`}>
        {settingsModal}
        <div style={imageUrl ? { backgroundImage: `url(${imageUrl})` } : undefined} className='community-header-group-image' />
        <div className="lobby-title-container">
          {!!banned ? (
            <div className="you-are-banned">
              <div>
                <NotAllowedIcon />
                <div className="ml-2">
                  {banned}
                </div>
              </div>
            </div>
          ) : (
            <>
              {communityHeader}
            </>
          )}
        </div>
      </div>
      <LeaveCommunityModal open={showLeaveGroupModal} onClose={() => setShowLeaveGroupModal(false)} />
    </div>
  )
}

export default CommunityHeader;
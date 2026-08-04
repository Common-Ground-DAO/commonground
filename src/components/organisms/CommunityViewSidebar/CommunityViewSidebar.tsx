// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./CommunityViewSidebar.css";
import { useNavigate } from "react-router-dom";

import { useCommunitySidebarContext } from "./CommunityViewSidebarContext";
import { useWindowSizeContext } from "../../../context/WindowSizeProvider";
import { useLoadedCommunityContext, useSafeCommunityContext } from "context/CommunityProvider";

import { AreaList } from "../../../components/molecules/AreaList/AreaList";
import Button from "../../../components/atoms/Button/Button";
import CommunityHeader from "../CommunityHeader/CommunityHeader";
import OwnCommunitiesBrowser from "../../../views/OwnCommunitiesBrowser/OwnCommunitiesBrowser";
import Scrollable, { PositionData } from "../../molecules/Scrollable/Scrollable";
// import { NewspaperIcon, BookOpenIcon, LightBulbIcon, PencilIcon } from '@heroicons/react/20/solid';

import SidebarCollapseIcon from '../../../components/atoms/icons/20/SidebarCollapse.svg?react';
import SidebarExpandIcon from '../../../components/atoms/icons/20/SidebarExpand.svg?react';
import { getUrl } from 'common/util';
import { StartCallModal } from "../StartCallModal/StartCallModal";
import config from "common/config";
import { CallList } from "components/molecules/CallList/CallList";
import JoinCommunityButton from "components/atoms/JoinCommunityButton/JoinCommunityButton";
import { Calendar, HouseSimple, IdentificationBadge, Users, Plug, CoinVertical, Gear, ArrowsOut, X, Storefront, Graph, ShareNetwork, Warning, Spinner } from "@phosphor-icons/react";
import NotificationDot from "components/atoms/NotificationDot/NotificationDot";
import JoinNewsletterBanner from "components/molecules/JoinNewsletterBanner/JoinNewsletterBanner";
import ScreenAwarePopover from "components/atoms/ScreenAwarePopover/ScreenAwarePopover";
import PluginViewSettings from "views/PluginView/PluginViewSettings";
import { usePluginIframeContext } from "context/PluginIframeProvider";
import pluginsApi from "data/api/plugins";
import { useSnackbarContext } from "context/SnackbarContext";
import { useSignedUrl } from "hooks/useSignedUrl";
import { usePluginDetailsModalContext } from "context/PluginDetailsModalProvider";
import { PopoverHandle } from "components/atoms/Tooltip/Tooltip";
import ScreenAwareModal from "components/atoms/ScreenAwareModal/ScreenAwareModal";
import { useAsyncMemo } from "hooks/useAsyncMemo";
import reportApi from "data/api/report";
import { ReportType } from "common/enums";
import SimpleLink from "components/atoms/SimpleLink/SimpleLink";
import { reasonCodeToText } from "context/ReportModalProvider";

export type MainSidebarContentName = 'lobby' | 'settings' | 'areas';

type CommunityViewSidebarProps = {
}

// Current threshold is original size (276) - 1.5 * final size(1.5*70 = 105)
const SCROLL_THRESHOLD_FOR_COLLAPSING_HEADER = 276 - 105;

const lobbyPathRegex = new RegExp(`^/${config.URL_COMMUNITY}/[^/]+/?$`);
const memberApplicationsPathRegex = new RegExp(`^/${config.URL_COMMUNITY}/[^/]+/member-applications/?$`);
const membersPathRegex = new RegExp(`^/${config.URL_COMMUNITY}/[^/]+/members/?$`);
const rolesPathRegex = new RegExp(`^/${config.URL_COMMUNITY}/[^/]+/roles/?$`);
const eventsPathRegex = new RegExp(`^/${config.URL_COMMUNITY}/[^/]+/events/?$`);
const pluginPathRegex = new RegExp(`^/${config.URL_COMMUNITY}/[^/]+/plugin/([^/]+)/?$`);
const tokenPathRegex = new RegExp(`^/${config.URL_COMMUNITY}/[^/]+/token/?$`);

export default function CommunityViewSidebar(props: CommunityViewSidebarProps) {
  const {
    communitySidebarIsOpen,
    setCommunitySidebarIsOpen,
    isSidebarLockOpen,
    sliderTriggerRef,
    communityListIsExpanded,
    setCommunityListIsExpanded,
    communityListManualState,
    setCommunityListManualState,
    // visibleButtons
  } = useCommunitySidebarContext();
  const { isMobile } = useWindowSizeContext();
  const communityContext = useSafeCommunityContext();
  const community = communityContext.state === 'loaded' ? communityContext.community : null;
  const ownRolesById = communityContext.state === 'loaded' ? communityContext.ownRolesById : null;

  const navigate = useNavigate();
  const sidebarContainerRef = useRef<HTMLDivElement>(null);
  const communitiesListRef = useRef<HTMLDivElement>(null);
  const sidebarFooterRef = useRef<HTMLDivElement>(null);

  const [banned, setBanned] = React.useState<string | undefined>();
  const [isHeaderCollapsed, _setHeaderCollapsed] = React.useState(false);
  const isHeaderCollapsedRef = useRef(isHeaderCollapsed);
  const [isStartCallMobileOpen, setIsStartCallMobileOpen] = React.useState<boolean>(false);
  const isJoinedCommunity = !!ownRolesById && ownRolesById.size !== 0;

  const setHeaderCollapsed = useCallback((collapsed: boolean) => {
    if (isHeaderCollapsedRef.current !== collapsed) {
      isHeaderCollapsedRef.current = collapsed;
      _setHeaderCollapsed(collapsed);
    }
  }, []);

  useEffect(() => {
    if (!community) return;

    let interval: any;
    const { blockState } = community;
    if (blockState && blockState.state === "BANNED") {
      if (blockState.until !== null) {
        const until = (new Date(blockState.until)).getTime();
        if (until > Date.now()) {
          const getHowLong = () => {
            const now = Date.now();
            const d = Math.floor((until - now) / 86400000);
            const h = Math.floor(((until - now) % 86400000) / 3600000);
            const m = Math.floor(((until - now) % 3600000) / 60000);
            const s = Math.floor(((until - now) % 60000) / 1000);
            return `${d > 0 ? `${d}d ` : ''}${h > 0 ? `${h}h ` : ''}${m > 0 ? `${m}m` : ''}${m > 0 || h > 0 || d > 0 ? '' : `${s}s`}`;
          }
          setBanned(`You are banned for ${getHowLong()}`);
          interval = setInterval(() => {
            if (until > Date.now()) {
              setBanned(`You are banned for ${getHowLong()}`);
            } else {
              setBanned(undefined);
              clearInterval(interval);
            }
          }, 1000);
        }
      } else {
        setBanned("You are permanently banned from this community");
      }
    } else {
      setBanned(undefined);
    }
    return () => {
      if (!!interval) {
        clearInterval(interval);
      }
    }
  }, [community?.blockState]);

  const outsideCommunityContext = !community;

  const closeSideBar = useCallback(() => {
    setCommunitySidebarIsOpen(false);
  }, []);

  const handleChannelListClick = useCallback(() => {
    setCommunityListIsExpanded(false);
  }, []);

  useEffect(() => {
    const handleClickOutside = (ev: MouseEvent) => {
      const target = ev.target as Element;
      if (communitySidebarIsOpen && !isSidebarLockOpen && target && (!sidebarContainerRef?.current?.contains(target) && !sliderTriggerRef?.current?.contains(target))) {
        if (communityListIsExpanded && !outsideCommunityContext) {
          setCommunityListIsExpanded(false);
        } else {
          closeSideBar();
        }
      }
    };
    document.addEventListener('click', handleClickOutside, true);
    return () => {
      document.removeEventListener('click', handleClickOutside, true);
    };
  }, [communitySidebarIsOpen, communityListIsExpanded, outsideCommunityContext, closeSideBar, isSidebarLockOpen]);

  useLayoutEffect(() => {
    const sidebarFooter = sidebarFooterRef.current;
    const communitiesList = communitiesListRef.current;
    if (sidebarFooter && communitiesList && communitiesList.scrollHeight > communitiesList.clientHeight) {
      if (sidebarFooter.style.boxShadow !== "0px -8px 20px -5px rgba(0,0,0,0.35)") {
        sidebarFooter.style.boxShadow = "0px -8px 20px -5px rgba(0,0,0,0.35)";
      }
    }
  });

  useEffect(() => {
    if (!!community?.id) {
      setCommunityListIsExpanded(false);
    }
  }, [community?.id]);

  const calculatedCommunityListIsExpanded = useMemo(() => {
    if (!!community?.id) {
      return communityListIsExpanded;
    } else {
      return communityListManualState;
    }
  }, [community?.id, communityListIsExpanded, communityListManualState]);

  const handleExpandCollapseBtnClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setCommunityListIsExpanded(old => !old);
    setCommunityListManualState(!calculatedCommunityListIsExpanded);
  }, [calculatedCommunityListIsExpanded]);

  const CommunitiesList = useMemo(() => (
    <div className={`own-communities-container${calculatedCommunityListIsExpanded ? '' : ' own-communities-container-collapsed'}`}>
      {isMobile && (
        <>
          <OwnCommunitiesBrowser isExpanded={calculatedCommunityListIsExpanded} contentRef={communitiesListRef} />
          <div className='floating-left-bar-footer' onClick={handleExpandCollapseBtnClick} ref={sidebarFooterRef}>
            <Button role='borderless' iconLeft={calculatedCommunityListIsExpanded ? <SidebarCollapseIcon /> : <SidebarExpandIcon />} />
          </div>
        </>
      )}
    </div>
  ), [calculatedCommunityListIsExpanded, handleExpandCollapseBtnClick, isMobile]);

  const positionCallback = useCallback((data: PositionData) => {
    if (data.scrollTop < SCROLL_THRESHOLD_FOR_COLLAPSING_HEADER) {
      setHeaderCollapsed(false);
    } else {
      setHeaderCollapsed(true);
    }
  }, []);

  const navigateToFeed = useCallback(() => {
    if (!!community?.url) {
      closeSideBar?.();
      navigate(getUrl({ type: 'community-lobby', community }));
    }
  }, [community?.url]);

  const navigateToEvents = useCallback(() => {
    if (!!community?.url) {
      closeSideBar?.();
      navigate(getUrl({ type: 'community-events', community }));
    }
  }, [community?.url]);

  const navigateToMemberApplications = useCallback(() => {
    if (!!community?.url) {
      closeSideBar?.();
      navigate(getUrl({ type: 'community-member-applications', community }));
    }
  }, [community?.url]);

  const navigateToMembers = useCallback(() => {
    if (!!community?.url) {
      closeSideBar?.();
      navigate(getUrl({ type: 'community-members', community }));
    }
  }, [community?.url]);

  const navigateToRoles = useCallback(() => {
    if (!!community?.url) {
      closeSideBar?.();
      navigate(getUrl({ type: 'community-roles', community }));
    }
  }, [community?.url]);

  const navigateToPlugin = useCallback((plugin: Models.Plugin.Plugin) => {
    if (!!community?.url) {
      closeSideBar?.();
      navigate(getUrl({ type: 'community-plugin', community, plugin }));
    }
  }, [community?.url]);

  const navigateToToken = useCallback(() => {
    if (!!community?.url) {
      closeSideBar?.();
      navigate(getUrl({ type: 'community-token', community }));
    }
  }, [community?.url]);

  const { pathname } = window.location;
  const {
    isLobbyActive,
    isMemberApplicationsActive,
    isMembersActive,
    isRolesActive,
    isEventsActive,
    isPluginsActive,
    activePluginId,
    isTokenActive,
  } = useMemo(() => {
    const pluginMatchResult = pathname.match(pluginPathRegex);
    const isPluginsActive = !!pluginMatchResult;
    const activePluginId = pluginMatchResult?.[1];

    return {
      isLobbyActive: !!pathname.match(lobbyPathRegex),
      isMemberApplicationsActive: !!pathname.match(memberApplicationsPathRegex),
      isMembersActive: !!pathname.match(membersPathRegex),
      isRolesActive: !!pathname.match(rolesPathRegex),
      isEventsActive: !!pathname.match(eventsPathRegex),
      isPluginsActive,
      activePluginId,
      isTokenActive: !!pathname.match(tokenPathRegex),
    };
  }, [pathname]);

  const innerJoinedContent = useMemo(() => {
    if (isJoinedCommunity && !!community?.id) {
      return (
        <>
          {!!community.membersPendingApproval && <div className="relative w-full">
            <Button
              role="chip"
              iconLeft={<Users weight="duotone" className="w-5 h-5" />}
              text={`${community.membersPendingApproval} Pending applicants`}
              onClick={navigateToMemberApplications}
              active={isMemberApplicationsActive}
              className="w-full"
            />
            <NotificationDot className="absolute top-0 right-0" />
          </div>}
          <div className="flex flex-wrap gap-2">
            <SidebarButton icon={<HouseSimple weight="duotone" className="w-5 h-5" />} onClick={navigateToFeed} text="Home" className={isLobbyActive ? ' active' : ''} />
            <SidebarButton icon={<Calendar weight="duotone" className="w-5 h-5" />} onClick={navigateToEvents} text="Events" className={isEventsActive ? ' active' : ''} />
            <SidebarButton
              icon={<Users weight="duotone" className="w-5 h-5" />}
              onClick={navigateToMembers}
              text="Members"
              className={isMembersActive ? ' active' : ''}
              rightElement={!!community.membersPendingApproval ? <div className="absolute top-0 bottom-0 right-2 flex items-center"></div> : undefined}
            />
            <SidebarButton icon={<IdentificationBadge weight="duotone" className="w-5 h-5" />} onClick={navigateToRoles} text="Roles" className={isRolesActive ? ' active' : ''} />
            {(config.TOKEN_CREATION_ENABLED || config.DEPLOYMENT !== 'prod') && (
              <SidebarButton
                icon={<div className="flex">
                  <CoinVertical weight="duotone" className="w-5 h-5" />
                  <div className="text-xs flex items-center justify-center bg-blue-600 text-white rounded-md px-1 py-0.5 ml-1">NEW</div>
                </div>}
                onClick={navigateToToken}
                text="Stake"
                className={isTokenActive ? ' active' : ''}
              />
            )}
            {/* {visibleButtons.announcements && <SidebarButton icon={<NewspaperIcon className="h-5 w-5" />} onClick={navigateToAnnouncements} text="Announcements" className={isAnnouncementsActive ? ' active' : ''} />}
            {visibleButtons.articles && <SidebarButton icon={<BookOpenIcon className="h-5 w-5" />} onClick={navigateToArticles} text="Articles" className={isArticlesActive ? ' active' : ''} />}
            {visibleButtons.guides && <SidebarButton icon={<LightBulbIcon className="h-5 w-5" />} onClick={navigateToGuides} text="Guides" className={isGuidesActive ? ' active' : ''} />}
            {visibleButtons.drafts && <SidebarButton icon={<PencilIcon className="h-5 w-5" />} onClick={navigateToDrafts} text="Drafts" className={isDraftsActive ? ' active' : ''} />} */}
            {community?.plugins?.map(plugin => <PluginSidebarButton
              key={plugin.id}
              plugin={plugin}
              onClick={() => navigateToPlugin(plugin)}
              text={plugin.name}
              active={isPluginsActive && activePluginId === plugin.id}
            />)}
          </div>
        </>
      );
    }
    return null;
  }, [isJoinedCommunity, community?.id, community?.membersPendingApproval, community?.plugins, isMemberApplicationsActive, isMembersActive, isRolesActive, isEventsActive, isLobbyActive, isPluginsActive, activePluginId, navigateToEvents, navigateToFeed, navigateToMemberApplications, navigateToMembers, navigateToRoles, navigateToPlugin]);

  const innerUnjoinedContent = useMemo(() => {
    if (!isJoinedCommunity && !!community) {
      return <>
        <div className="w-full px-2">
          {banned === undefined && <JoinCommunityButton
            community={community}
            iconLeft={<span className="flex w-4 justify-center">+</span>}
            className="w-full"
          />}
          {banned !== undefined &&
            <div style={{
              color: 'red',
              textAlign: 'center',
              fontSize: '1rem',
              fontWeight: 'bold',
              marginTop: '0.5rem'
            }}>
              {banned}
            </div>
          }
        </div>
        <div className="flex flex-wrap gap-2">
          <SidebarButton icon={<HouseSimple weight="duotone" className="w-5 h-5" />} onClick={navigateToFeed} text="Home" className={isLobbyActive ? ' active' : ''} />
          {/* <SidebarButton icon={<UserGroupIcon className="w-5 h-5" />} onClick={navigateToMembers} text="Members" className={isMembersActive ? ' active' : ''} /> */}
          {/* {visibleButtons.announcements && <SidebarButton icon={<NewspaperIcon className="h-5 w-5" />} onClick={navigateToAnnouncements} text="Announcements" className={isAnnouncementsActive ? ' active' : ''} />}
          {visibleButtons.articles && <SidebarButton icon={<BookOpenIcon className="h-5 w-5" />} onClick={navigateToArticles} text="Articles" className={isArticlesActive ? ' active' : ''} />}
          {visibleButtons.guides && <SidebarButton icon={<LightBulbIcon className="h-5 w-5" />} onClick={navigateToGuides} text="Guides" className={isGuidesActive ? ' active' : ''} />}
          {visibleButtons.drafts && <SidebarButton icon={<PencilIcon className="h-5 w-5" />} onClick={navigateToDrafts} text="Drafts" className={isDraftsActive ? ' active' : ''} />} */}
          {community?.plugins?.map(plugin => <PluginSidebarButton
            key={plugin.id}
            plugin={plugin}
            onClick={() => navigateToPlugin(plugin)}
            text={plugin.name}
            active={isPluginsActive && activePluginId === plugin.id}
          />)}
        </div>
      </>;
    }
    return null;
  }, [isJoinedCommunity, community, isLobbyActive, navigateToFeed, banned]);

  const communityHeader = useMemo(() => {
    if (!!community?.id) {
      return <CommunityHeader onHeaderClick={closeSideBar} collapsed={isHeaderCollapsed} />;
    }
    return null;
  }, [isHeaderCollapsed, community?.id]);

  const areaListAndBanner = useMemo(() => {
    if (!!community?.id) {
      return <>
        {!isMobile && <JoinNewsletterBanner />}
        <AreaList handleCloseSidebar={closeSideBar} />
      </>;
    }
    return null;
  }, [isMobile, community?.id]);

  const callList = useMemo(() => {
    if (!!community?.id) {
      return <CallList />;
    }
    return null;
  }, [community?.id]);

  const content = useMemo(() => {
    let inner: React.JSX.Element | null;
    if (isJoinedCommunity) {
      inner = innerJoinedContent;
    } else {
      inner = innerUnjoinedContent;
    }
    return (
      <div className={`channel-browser-container${(isMobile && calculatedCommunityListIsExpanded) ? ' channel-browser-container-no-pointer' : ' channel-browser-container-expanded'}${isHeaderCollapsed ? ' header-collapsed' : ''}`}>
        <Scrollable innerClassName="channel-browser-content" positionCallback={positionCallback}>
          {communityHeader}
          <div className="channel-browser-content-bottom">
            {inner}
            {areaListAndBanner}
          </div>
          {callList}
        </Scrollable>
      </div>
    );
  }, [isJoinedCommunity ? innerJoinedContent : innerUnjoinedContent, community?.id, isMobile, calculatedCommunityListIsExpanded, isHeaderCollapsed, positionCallback, areaListAndBanner]);

  const classNames = [
    "floating-left-bar cg-content-stack",
    communitySidebarIsOpen ? 'active' : '',
    outsideCommunityContext ? calculatedCommunityListIsExpanded ? 'transparent' : 'collapsed-communities-only' : ''
  ].join(" ").trim();

  const closeStartCall = useCallback(() => {
    setIsStartCallMobileOpen(false)
  }, []);

  return <>
    {communitySidebarIsOpen && isMobile && <div className="floating-left-bar-overlay" />}
    <div className={classNames} ref={sidebarContainerRef} onClick={handleChannelListClick}>
      {content}
      {CommunitiesList}
      {community && <StartCallModal onClose={closeStartCall} open={isStartCallMobileOpen} title="Start a call" />}
    </div>
  </>;
}

type SidebarButtonProps = {
  onClick: () => void;
  className?: string;
  icon: React.JSX.Element;
  text: string;
  rightElement?: React.JSX.Element;
};

const SidebarButton = React.memo((props: SidebarButtonProps) => {
  return <Button
    role="chip"
    onClick={props.onClick}
    iconLeft={props.icon}
    text={props.text}
    className={`w-fit ${props.className}`}
  />;
});

type PluginSidebarButtonProps = {
  plugin: Models.Plugin.Plugin;
  onClick: () => void;
  text: string;
  active: boolean;
};

const PluginSidebarButton = React.memo((props: PluginSidebarButtonProps) => {
  const navigate = useNavigate();
  const { community } = useLoadedCommunityContext();
  const { iframeRef, pluginData, unloadIframe } = usePluginIframeContext();
  const { showSnackbar } = useSnackbarContext();
  const { showModal } = usePluginDetailsModalContext();
  const settingsRef = useRef<PopoverHandle>(null);

  const [__checkedPermissionsChanged, __setCheckedPermissionsChanged] = useState(false);
  const [checkedOptionals, setCheckedOptionals] = useState<Models.Plugin.PluginPermission[]>([]);

  const handleToggleOptional = useCallback((permission: Models.Plugin.PluginPermission) => {
    setCheckedOptionals(prev => prev.includes(permission) ? prev.filter(p => p !== permission) : [...prev, permission]);
    __setCheckedPermissionsChanged(true);
  }, []);

  useEffect(() => {
    if (!pluginData?.permissions?.optional || !pluginData.acceptedPermissions) return;

    setCheckedOptionals(pluginData.permissions.optional.filter(permission => pluginData.acceptedPermissions?.includes(permission)));
  }, [pluginData?.permissions?.optional, pluginData?.acceptedPermissions]);

  const isLoaded = pluginData?.id === props.plugin.id;
  const pluginImg = useSignedUrl(props.plugin?.imageId);

  return <div className={`btnChip${props.active ? ' active' : ''}${isLoaded ? ' w-full px-2' : ''} flex-col items-start gap-2 relative`} onClick={props.onClick} role="button">
    <div className="flex gap-2 items-center">
      {!props.plugin?.imageId && <div className={isLoaded ? "w-16 h-16 cg-border-l overflow-hidden flex items-center justify-center cg-bg-subtle" : "flex items-center justify-center overflow-hidden"}>
        <Plug weight="duotone" className={isLoaded ? "w-12 h-12" : "w-5 h-5"} />
      </div>}
      {!!props.plugin?.imageId && <div
        className={`${isLoaded ? 'w-16 h-16' : 'w-5 h-5'} cg-border-l overflow-hidden bg-no-repeat bg-cover bg-center flex items-center justify-center ${!pluginImg && !!pluginData?.imageId ? 'animate-pulse' : ''}`}
        style={{ backgroundImage: `url(${pluginImg})` }}
      />}

      <div className="flex flex-col gap-2">
        <span className="btnText flex flex-row gap-2">{props.text} {props.plugin.reportFlagged && <PluginReportReasonModal plugin={props.plugin} />}</span>
        {isLoaded && <div className="flex gap-2">
          <div>
            <ScreenAwarePopover
              ref={settingsRef}
              triggerType='click'
              closeOn='toggle'
              placement='right'
              offset={8}
              tooltipClassName="cg-box-shadow-xl"
              triggerContent={<Button role='secondary' iconLeft={<Gear weight='duotone' className='w-5 h-5' />} />}
              tooltipContent={<PluginViewSettings
                plugin={pluginData}
                checkedOptionals={checkedOptionals}
                handleToggleOptional={handleToggleOptional}
                close={() => settingsRef.current?.close()}
              />}
              onClose={async () => {
                if (!__checkedPermissionsChanged) {
                  return;
                }

                await pluginsApi.acceptPluginPermissions({
                  pluginId: pluginData?.id || '',
                  permissions: [...(pluginData?.permissions?.mandatory || []), ...checkedOptionals],
                });
                __setCheckedPermissionsChanged(false);
                showSnackbar({
                  text: 'Permissions updated',
                  type: 'info',
                });
              }}
            />
          </div>
          <Button role='secondary' iconLeft={<ArrowsOut weight='duotone' className='w-5 h-5' />} onClick={async () => {
            iframeRef?.current?.requestFullscreen()
            if ('keyboard' in navigator && 'lock' in (navigator as any).keyboard) {
              await (navigator as any).keyboard.lock(['Escape']);
            }
          }} />
          {(props.plugin.clonable || props.plugin.appstoreEnabled) && <Button role='secondary' iconLeft={<Storefront weight="duotone" className="w-5 h-5" />} onClick={() => {
            showModal({
              plugin: {
                ...props.plugin,
                description: props.plugin.description || '',
                imageId: props.plugin.imageId || '',
                permissions: props.plugin.permissions || { mandatory: [], optional: [] },
              }
            });
          }} />}
          <Button
            role="secondary"
            iconLeft={<ShareNetwork weight="duotone" className="w-5 h-5" />}
            onClick={() => {
              navigator.clipboard.writeText(window.location.href);
              showSnackbar({
                type: 'info',
                text: 'Plugin URL copied to clipboard',
              });
            }}
          />
          <div className="cg-bg-subtle cg-circular cursor-pointer absolute -top-2 -right-2 p-1 cg-text-main" onClick={(ev) => {
            ev.stopPropagation();
            unloadIframe();
            navigate(getUrl({ type: 'community-lobby', community }));
          }}>
            <X className='w-5 h-5' />
          </div>
        </div>}
      </div>
    </div>
  </div>
});

type PluginReportReasonModalProps = {
  plugin: Models.Plugin.Plugin;
}

const PluginReportReasonModal: React.FC<PluginReportReasonModalProps> = (props) => {
  const { isMobile } = useWindowSizeContext();
  const [isOpen, setIsOpen] = useState(false);
  const reportReasons = useAsyncMemo(() => {
    return reportApi.getReportReasons({
      type: ReportType.PLUGIN,
      targetId: props.plugin.pluginId
    });
  }, []);

  return <div onClick={e => e.stopPropagation()}>
    <Warning weight="duotone" className="cg-text-warning w-5 h-5" onClick={e => {
      e.stopPropagation();
      e.preventDefault();
      setIsOpen(true);
    }} />
    <ScreenAwareModal
      hideHeader
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}>
      <div className={`flex flex-col gap-4 ${isMobile ? 'p-4' : ''}`}>
        <h2>Why was this plugin flagged?</h2>
        {reportReasons === undefined && <Spinner className="spinner" />}
        {reportReasons && reportReasons.length === 0 && (
          <div>No specific reasons were provided for this report.</div>
        )}
        <div className="flex flex-col gap-2"> 
        {reportReasons && reportReasons.length > 0 && reportReasons.map(reason => (
          <div key={reason} className="p-2 cg-bg-subtle w-full cg-border-l">
            <h4>{reasonCodeToText(reason)}</h4>
          </div>
        ))}
        </div>
        <div className="cg-text-md-400 cg-text-secondary">
          Are you the owner of this plugin? <br />
          <span className="cg-text-md-500"><SimpleLink className="underline cg-text-brand" inlineLink href="https://app.cg/c/commonground/channel/help/">Contact our support team</SimpleLink> to resolve these reports and restore your plugin's reputation.</span>
        </div>

        <Button
          role="primary"
          text={'Understood'}
          onClick={() => setIsOpen(false)}
          className="w-full"
        />
      </div>
    </ScreenAwareModal>
  </div>
}
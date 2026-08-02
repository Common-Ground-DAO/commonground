// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect, useMemo } from "react";
import { Route, Routes, useParams } from "react-router-dom";

import { ReactComponent as SpinnerIcon } from '../../components/atoms/icons/16/Spinner.svg';

import CommunityManagementView from "views/CommunityManagementView/CommunityManagementView";
import AreaChannelManagementView from "views/AreaChannelManagementView/AreaChannelManagementView";
import config from "common/config";
import MemberManagementView from "views/MemberManagementView/MemberManagementView";
import CreateArticleView from "views/CreateArticleView/CreateArticleView";
import ArticleView from "views/ArticleView/ArticleView";
import EditArticleView from "views/EditArticleView/EditArticleView";
import CommunityView from "views/CommunityView/CommunityView";
import RoleManagementView from "views/RoleManagementView/RoleManagementView";
import RolesView from "views/RolesView/RolesView";
import { useSafeCommunityContext } from "context/CommunityProvider";
import { CommunityChannelIdProvider } from "context/CommunityChannelProvider";
import CallPageView from "views/CallPageView/CallPageView";
import { parseIdOrUrl } from "../../util";
import { useWindowSizeContext } from "context/WindowSizeProvider";
import CommunityViewSidebar from "components/organisms/CommunityViewSidebar/CommunityViewSidebar";
import CommunitySettingsView from "views/CommunitySettingsView/CommunitySettingsView";
import EventsView from "views/EventsView/EventsView";

import './CommunityRouter.css';
import { MemberListProvider } from "components/organisms/MemberList/MemberListContext";
import EventView from "views/EventView/EventView";
import SafeAndUpgradesView from "views/SafeAndUpgradesView/SafeAndUpgradesView";
import TokenSettingsView from "views/TokenSettingsView/TokenSettingsView";
import OnboardingManagementView from "views/OnboardingManagementView/OnboardingManagementView";
import MemberApplicationView from "views/MemberApplicationView/MemberApplicationView";
import { CommunityWizardProvider } from "context/CommunityWizardProvider";
import AssistantView from "views/AssistantView/AssistantView";
import { CommunityPluginProvider } from "context/CommunityPluginProvider";
import PluginView from "views/PluginView/PluginView";
import CommunityTokenView from "views/CommunityTokenView/CommunityToken";
import PluginSettingsView from "views/PluginSettingsView/PluginSettingsView";
import BanManagementView from "views/BanManagementView/BanManagementView";
import BotManagementView from "views/BotManagementView/BotManagementView";
type Props = {

}

function CommunityRouter(props: Props) {
  const { isMobile } = useWindowSizeContext();
  const { communityUrl } = useParams<'communityUrl'>();
  const safeCtx = useSafeCommunityContext();
  const { setCommunityIdOrUrl } = safeCtx;

  useEffect(() => {
    setCommunityIdOrUrl(communityUrl);
  }, [communityUrl, setCommunityIdOrUrl]);

  useEffect(() => {
    return () => {
      setCommunityIdOrUrl(undefined);
    };
  }, [])

  const differentCommLoaded = useMemo(() => {
    if (!communityUrl) return false;
    const whatIsIt = parseIdOrUrl(communityUrl);
    return (safeCtx.state === 'loaded' && (
      (whatIsIt.url && safeCtx.community.url !== whatIsIt.url) ||
      (whatIsIt.uuid && safeCtx.community.id !== whatIsIt.uuid)
    ));
  }, [communityUrl, safeCtx]);

  if (safeCtx.state === "loading" || safeCtx.state === "no-community" || differentCommLoaded) {
    return (
      <div className="content-full global-caption group-caption">
        <div className='flex justify-center w-full pt-12'>
          <div className='spinner'>
            <SpinnerIcon />
          </div>
        </div>
      </div>
    );
  } else if (safeCtx.state === "loaded") {
    return (
      <MemberListProvider>
        <div className="community-router">
        {!isMobile && <CommunityViewSidebar />}
        <Routes>
          <Route path='settings/*' element={
            <Routes>
              <Route path='/' element={<CommunitySettingsView />} />
              <Route path='info/' element={<CommunityManagementView />} />
              <Route path='areas-and-channels/' element={<AreaChannelManagementView />} />
              <Route path='members/' element={<MemberManagementView />} />
              <Route path='manage-bans/' element={<BanManagementView />} />
              <Route path='roles/' element={<RoleManagementView />} />
              <Route path='upgrades/' element={<SafeAndUpgradesView />} />
              <Route path='onboarding/' element={<OnboardingManagementView />} />
              <Route path='token/' element={<TokenSettingsView />} />
              <Route path='plugins/' element={<PluginSettingsView />} />
              <Route path='bots/' element={<BotManagementView />} />
            </Routes>
          } />
          <Route path={`create/${config.URL_ARTICLE}/`} element={<CreateArticleView />} />
          <Route path='roles/' element={<RolesView />} />
          <Route path='members/' element={<MemberManagementView />} />
          <Route path='member-applications/' element={<MemberApplicationView />} />
          <Route path='events/' element={<EventsView />} />
          <Route path='assistant/' element={<AssistantView community={safeCtx.community} />} />
          <Route path='token/' element={<CommunityTokenView />} />
          <Route path={`${config.URL_CALL}/:callId/`} element={<CallPageView />} />
          <Route path={`${config.URL_ARTICLE}/:articleUri/`} element={<ArticleView />} />
          <Route path={`${config.URL_ARTICLE}/:articleUri/edit/`} element={<EditArticleView />} />
          <Route path={`${config.URL_EVENT}/:eventIdOrUrl/`} element={<EventView />} />
          <Route path='plugin/:pluginId/' element={
            <CommunityPluginProvider>
              <PluginView />
            </CommunityPluginProvider>
          } />
          <Route path={`${config.URL_CHANNEL}/:channelIdOrUrl/*`} element={
            <CommunityChannelIdProvider>
              <CommunityView />
            </CommunityChannelIdProvider>
          } />
          <Route path={`${config.URL_WIZARD}/:wizardId/*`} element={
            <CommunityWizardProvider pageTitle={safeCtx.community.title}>
              <CommunityView />
            </CommunityWizardProvider>
          } />
          <Route path='*' element={<CommunityView />} />
        </Routes>
      </div>
    </MemberListProvider>
  );
  } else {
    console.error("Unknown state", safeCtx);
    throw new Error("Unknown state");
  }
}

export default React.memo(CommunityRouter);

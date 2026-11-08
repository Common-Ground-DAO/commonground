// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import "./ChannelManagement.css";
import React, { useCallback, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useWindowSizeContext } from "../../../../context/WindowSizeProvider";
import { useNavigationContext } from "components/SuspenseRouter/SuspenseRouter";

import EditAreaForm from "./EditAreaForm";
import { useLoadedCommunityContext } from "context/CommunityProvider";
import ChannelManagementAreaList from "./ChannelManagementAreaList";
import EditChannelForm from "./EditChannelForm";
import Scrollable from "components/molecules/Scrollable/Scrollable";
import { getUrl } from 'common/util';
import ManagementHeader2 from "components/molecules/ManagementHeader2/ManagementHeader2";

type ChannelManagementPage = 'areaList' | 'createArea' | 'createChannel' | 'editArea' | 'editChannel';

export default function ChannelManagement() {
  const { areas, channels } = useLoadedCommunityContext();
  const { isDirty, setDirty } = useNavigationContext();
  const [searchParams] = useSearchParams();
  const startingChannelId = searchParams.get('channel');
  const startingChannel = useMemo(() => channels.find(c => c.channelId === startingChannelId), [channels, startingChannelId]);

  const { isMobile } = useWindowSizeContext();
  const [selectedArea, setSelectedArea] = useState<Models.Community.Area | undefined>();
  const [selectedChannel, setSelectedChannel] = useState<Models.Community.Channel | undefined>(startingChannel);
  const [currentPage, setCurrentPage] = useState<ChannelManagementPage>(startingChannel ? 'editChannel' : 'areaList');

  const nextAreaOrder = useMemo(() => Math.max(...areas.map(area => area.order), 0) + 1, [areas]);
  const nextChannelOrder = useMemo(() => Math.max(...channels.map(channel => channel.order), 0) + 1, [channels]);

  const checkDirtyCanContinue = useCallback(() => {
    if (isDirty) {
      const res = window.confirm('You have unsaved changes, do you want to leave anyway?');
      if (res) {
        setDirty(false);
        return true;
      }
      return false;
    }
    return true;
  }, [isDirty, setDirty]);

  const handleAreaEditClick = useCallback((area: Models.Community.Area) => {
    if (!checkDirtyCanContinue()) return;

    setSelectedArea(area);
    setSelectedChannel(undefined);
    setCurrentPage('editArea');
  }, [checkDirtyCanContinue])

  const handleChannelEditClick = useCallback((channel: Models.Community.Channel) => {
    if (!checkDirtyCanContinue()) return;

    setSelectedChannel(channel);
    setSelectedArea(undefined);
    setCurrentPage('editChannel');
  }, [checkDirtyCanContinue]);

  const handleCreateAreaClick = useCallback(() => {
    if (!checkDirtyCanContinue()) return;

    setSelectedArea(undefined);
    setSelectedChannel(undefined);
    setCurrentPage('createArea');
  }, [checkDirtyCanContinue]);

  const handleCreateChannelClick = useCallback((area: Models.Community.Area) => {
    if (!checkDirtyCanContinue()) return;

    setSelectedArea(area);
    setSelectedChannel(undefined);
    setCurrentPage('createChannel');
  }, [checkDirtyCanContinue]);

  const subProps: SubProps = useMemo(() => ({
    currentPage,
    handleAreaEditClick,
    handleChannelEditClick,
    handleCreateAreaClick,
    handleCreateChannelClick,
    nextAreaOrder,
    nextChannelOrder,
    selectedArea,
    selectedChannel,
    setCurrentPage
  }), [
    currentPage,
    handleAreaEditClick,
    handleChannelEditClick,
    handleCreateAreaClick,
    handleCreateChannelClick,
    nextAreaOrder,
    nextChannelOrder,
    selectedArea,
    selectedChannel
  ]);

  if (isMobile) {
    return <ChannelManagementMobile {...subProps} />
  } else {
    return <ChannelManagementDesktop {...subProps} />
  }
}

type SubProps = {
  currentPage: ChannelManagementPage;
  setCurrentPage: (page: ChannelManagementPage) => void;
  selectedArea: Models.Community.Area | undefined;
  selectedChannel: Models.Community.Channel | undefined;
  nextAreaOrder: number;
  nextChannelOrder: number;
  handleAreaEditClick: (area: Models.Community.Area) => void;
  handleChannelEditClick: (channel: Models.Community.Channel) => void;
  handleCreateAreaClick: () => void;
  handleCreateChannelClick: (area: Models.Community.Area) => void;
};

const ChannelManagementMobile: React.FC<SubProps> = (props) => {
  const {
    currentPage,
    setCurrentPage,
    selectedArea,
    selectedChannel,
    nextAreaOrder,
    nextChannelOrder,
    handleAreaEditClick,
    handleChannelEditClick,
    handleCreateAreaClick,
    handleCreateChannelClick
  } = props;
  const navigate = useNavigate();
  const { community } = useLoadedCommunityContext();
  const { isDirty, setDirty } = useNavigationContext();

  const checkDirtyCanContinue = useCallback(() => {
    if (isDirty) {
      const res = window.confirm('You have unsaved changes, do you want to leave anyway?');
      if (res) {
        setDirty(false);
        return true;
      }
      return false;
    }
    return true;
  }, [isDirty, setDirty]);

  const goBack = useCallback(() => {
    if (currentPage !== 'areaList') {
      if (checkDirtyCanContinue()) {
        setCurrentPage('areaList');
      }
    } else {
      navigate(getUrl({ type: 'community-settings', community }));
    }
  }, [currentPage, checkDirtyCanContinue, setCurrentPage, navigate, community]);

  let title = 'Areas & Channels';
  if (currentPage === 'createArea') {
    title = 'Create area';
  } else if (currentPage === 'editArea') {
    title = 'Edit area';
  } else if (currentPage === 'createChannel') {
    title = 'Create channel';
  } else if (currentPage === 'editChannel') {
    title = 'Edit channel';
  }

  return <div className='channel-management channel-management-mobile'>
    <ManagementHeader2
      goBack={goBack}
      title={title}
    />
    <Scrollable>
      <div className='p-4'>
        {currentPage === 'areaList' && <ChannelManagementAreaList
          onAreaEditClick={handleAreaEditClick}
          onChannelEditClick={handleChannelEditClick}
          onCreateChannelClick={handleCreateChannelClick}
          onCreateNewArea={handleCreateAreaClick}
        />}

        {(currentPage === 'createArea' || currentPage === 'editArea') && <EditAreaForm
          area={selectedArea}
          communityId={community.id}
          onFinish={() => {
            setDirty(false);
            setCurrentPage('areaList');
          }}
          nextOrder={nextAreaOrder}
        />}

        {(currentPage === 'createChannel' || currentPage === 'editChannel') && <EditChannelForm
          channel={selectedChannel}
          areaId={selectedArea?.id}
          communityId={community.id}
          onFinish={() => {
            setDirty(false);
            setCurrentPage('areaList');
          }}
          nextOrder={nextChannelOrder}
        />}
      </div>
    </Scrollable>
  </div>;
}

const ChannelManagementDesktop: React.FC<SubProps> = (props) => {
  const {
    currentPage,
    setCurrentPage,
    selectedArea,
    selectedChannel,
    nextAreaOrder,
    nextChannelOrder,
    handleAreaEditClick,
    handleChannelEditClick,
    handleCreateAreaClick,
    handleCreateChannelClick
  } = props;
  const { community } = useLoadedCommunityContext();
  const { setDirty } = useNavigationContext();

  return <div className='channel-management channel-management-desktop'>
    <ManagementHeader2 title='Areas & Channels' />
    <div className='channel-management-desktop-content'>
      <ChannelManagementAreaList
        onAreaEditClick={handleAreaEditClick}
        onChannelEditClick={handleChannelEditClick}
        onCreateChannelClick={handleCreateChannelClick}
        onCreateNewArea={handleCreateAreaClick}
        selectedId={selectedChannel?.channelId || selectedArea?.id}
      />

      {(currentPage === 'createArea' || currentPage === 'editArea') && <EditAreaForm
        key={selectedArea?.id}
        area={selectedArea}
        communityId={community.id}
        onFinish={(close?: boolean) => {
          setDirty(false);
          if (close || currentPage === 'createArea') setCurrentPage('areaList');
        }}
        nextOrder={nextAreaOrder}
      />}

      {(currentPage === 'createChannel' || currentPage === 'editChannel') && <EditChannelForm
        key={selectedChannel?.channelId}
        channel={selectedChannel}
        areaId={selectedArea?.id}
        communityId={community.id}
        onFinish={(close?: boolean) => {
          setDirty(false);
          if (close || currentPage === 'createChannel') setCurrentPage('areaList');
        }}
        nextOrder={nextChannelOrder}
      />}
    </div>
  </div>;
} 
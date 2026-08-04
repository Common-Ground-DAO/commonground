// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { DndContext, DragEndEvent } from "@dnd-kit/core";
import { rectSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { dragAnnouncements, listCollisionDetection, useDragSensors } from "hooks/useDragSensors";
import { useLiveQuery } from "dexie-react-hooks";
import data from "data";

import CommunityPhoto from "../../../../components/atoms/CommunityPhoto/CommunityPhoto";
import NotificationDot from "components/atoms/NotificationDot/NotificationDot";
import { Tooltip } from "components/atoms/Tooltip/Tooltip";
import OfficialIcon from "../../../../components/atoms/icons/20/OfficialIcon.svg?react";

import './GroupsMenu.css';
import { getUrl } from 'common/util';
import { useOwnUser, useOwnCommunities } from "context/OwnDataProvider";
import { useSafeCommunityContext } from "context/CommunityProvider";
import PinnedChannel from "components/molecules/PinnedChannel/PinnedChannel";
import { useWindowSizeContext } from "context/WindowSizeProvider";
import dayjs from "dayjs";
import { getTierElementIcon, getTierElementTitle } from "util/index";

type Props = {
  collapsed: boolean;
}

export default function GroupsMenu(props: Props) {
  const delayedSaveTimeoutRef = useRef<any>(null);

  const ownUser = useOwnUser();
  const communities = useOwnCommunities();
  const communityCtx = useSafeCommunityContext();
  const currentCommunity = communityCtx.state === "loaded" ? communityCtx.community : undefined;

  const [sortedCommunities, setSortedCommunities] = useState(communities);
  const [draggingOver, setDraggingOver] = useState(false);
  const sensors = useDragSensors();

  const sortCommunities = useCallback((orderedCommunityIds: string[]) => {
    const sortedCommunities: Models.Community.DetailView[] = [];
    orderedCommunityIds.forEach(communityId => {
      const foundCommunity = communities?.find(community => community.id === communityId);
      if (foundCommunity) {
        sortedCommunities.push(foundCommunity);
      }
    });
    return sortedCommunities;
  }, [communities]);

  useEffect(() => {
    const orderedCommunityIds = ownUser?.communityOrder || [];
    const sortedCommunities = sortCommunities(orderedCommunityIds);
    setSortedCommunities(sortedCommunities);
  }, [ownUser?.communityOrder, sortCommunities]);

  const updateCommunityOrder = useCallback((draggedCommunity: Models.Community.DetailView, sourceIndex: number, destinationIndex: number) => {
    const delayDebouncedSave = (orderedCommunityIds: string[], timeout: number) => {
      if (delayedSaveTimeoutRef.current) {
        clearTimeout(delayedSaveTimeoutRef.current);
      }
      delayedSaveTimeoutRef.current = setTimeout(() => {
        (async () => {
          if (!!ownUser) {
            await data.user.updateOwnData({ communityOrder: orderedCommunityIds });
          }
        })();
        delayedSaveTimeoutRef.current = null;
      }, timeout);
    }

    const communityOrder = ownUser?.communityOrder || [];
    const index = communityOrder.findIndex(communityId => communityId === draggedCommunity.id);
    const orderedCommunityIds = [...communityOrder];
    orderedCommunityIds.splice(index, 1);
    orderedCommunityIds.splice(destinationIndex, 0, draggedCommunity.id);

    const sortedCommunities = sortCommunities(orderedCommunityIds);
    setSortedCommunities(sortedCommunities);
    delayDebouncedSave(orderedCommunityIds, 1500);
  }, [ownUser, sortCommunities]);

  const communityIds = useMemo(() => (sortedCommunities || []).map(community => community.id), [sortedCommunities]);

  const onDragEnd = useCallback((event: DragEndEvent) => {
    setDraggingOver(false);
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }
    const sourceIndex = communityIds.indexOf(String(active.id));
    const destinationIndex = communityIds.indexOf(String(over.id));
    if (sourceIndex < 0 || destinationIndex < 0 || sourceIndex === destinationIndex) {
      return;
    }
    const draggedCommunity = sortedCommunities?.find(community => community.id === active.id);
    if (draggedCommunity) {
      updateCommunityOrder(draggedCommunity, sourceIndex, destinationIndex);
    }
  }, [communityIds, sortedCommunities, updateCommunityOrder]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={listCollisionDetection}
      accessibility={{ announcements: dragAnnouncements }}
      onDragStart={() => setDraggingOver(true)}
      // rbd's isDraggingOver was on only while hovering the list, not for the
      // whole drag — with the cancel-outside collision rule, `over` tracks it.
      onDragOver={event => setDraggingOver(!!event.over)}
      onDragCancel={() => setDraggingOver(false)}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={communityIds} strategy={rectSortingStrategy}>
        <div className={`groups-menu${props.collapsed ? ' collapsed' : ''}${draggingOver ? ' dragging-over' : ''}`}>
          <div className="items">
            {sortedCommunities?.map(community => (
              <CommunityItem
                key={community.id}
                community={community}
                selected={community.id === currentCommunity?.id}
                collapsed={props.collapsed}
              />
            ))}
          </div>
        </div>
      </SortableContext>
    </DndContext>
  );
}

type CommunityItemProps = {
  community: Models.Community.DetailView;
  selected: boolean;
  collapsed: boolean;
}

function CommunityItem(props: CommunityItemProps) {
  const { community, selected, collapsed } = props;
  const { isMobile } = useWindowSizeContext();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: community.id, data: { label: `community ${community.title}` } });
  const channels = useLiveQuery(() => {
    return data.community.getChannels(community.id);
  }, [community.id]);

  const unread = useMemo(() => {
    return channels?.reduce((channelsUnread, channel) => channelsUnread + (channel.unread || 0), 0) || 0;
  }, [channels]);
  const showDot = unread > 0 || ((community.membersPendingApproval || 0) > 0);
  const ownPinnedChannels = useMemo(() => {
    return channels?.filter(channel => 
      channel.pinType === 'permapin' ||
      (channel.pinType === 'autopin' && !!channel.pinnedUntil && new Date(channel.pinnedUntil) > new Date())
    ) || [];
  }, [channels]);

  const communityIconContent = useMemo(() => {
    let premiumIcon: React.JSX.Element | undefined = undefined;
    if (!community.official && !!community.premium && dayjs(community.premium.activeUntil).isAfter(dayjs())) {
      const tier = community.premium.featureName;
      premiumIcon = <Tooltip
        offset={8}
        triggerContent={getTierElementIcon(tier, "group-icon-official w-4 h-4 absolute -right-1 -bottom-1")!}
        triggerClassName="flex items-center"
        tooltipContent={getTierElementTitle(tier)! + ' Community'}
        placement="top"
        allowPropagation
      />;
    }

    const navLink = (
      <NavLink to={getUrl({ type: 'community-lobby', community })} className={state => state.isActive ? 'link-active' : ''}>
        <div className={`group-item`}>
          <div className={`group-icon${selected ? ' active' : ''}`}>
            <CommunityPhoto community={community} size="small" />
            {showDot && <NotificationDot className="notification-icon" />}
            {community.official && <OfficialIcon className="group-icon-official w-4 h-4 absolute -right-1 -bottom-1"/>}
            {premiumIcon}
          </div>
          {!collapsed && <div className="group-title">
            <span>
              {community.title}
            </span>
          </div>}
        </div>
      </NavLink>
    );
    
    if (!isMobile) {
      return <Tooltip
        placement="right"
        triggerContent={navLink}
        tooltipContent={community.title}
        offset={6}
        dismissOnScroll={true}
        openDelay={200}
      />
    }
    else {
      return navLink;
    }
  }, [community.updatedAt, selected, showDot, collapsed, isMobile])

  const ownPinnedChannelsContent = useMemo(() => {
    if (ownPinnedChannels.length > 0) {
      return <div className="flex flex-col gap-0.5">
        {ownPinnedChannels.map(channel => <PinnedChannel
          key={channel.channelId}
          communityUrl={community.url}
          channel={channel}
          collapsed={collapsed}
        />)}
      </div>;
    }
    else {
      return null;
    }
  }, [ownPinnedChannels, community.url, collapsed]);

  // The whole item is the drag handle, as it was under react-beautiful-dnd.
  return useMemo(() => (
    <div
      // Node and keyboard activator in one: registering the activator restores
      // dnd-kit's `event.target` guard, so Space on the focused NavLink inside
      // the item activates the link instead of lifting the row.
      ref={element => { setNodeRef(element); setActivatorNodeRef(element); }}
      {...attributes}
      {...listeners}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        position: 'relative',
        zIndex: isDragging ? 5000 : undefined,
      }}
    >
      <div className={`group-item-container${isDragging ? ' dragging' : ''}${collapsed ? ' collapsed' : ''}`}>
        {communityIconContent}
        {ownPinnedChannelsContent}
      </div>
    </div>
  ), [attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging, collapsed, communityIconContent, ownPinnedChannelsContent]);
}
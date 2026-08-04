// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './OwnCommunitiesBrowser.css';
import { useNavigate } from "react-router-dom";
import EmptyState from "../../components/molecules/EmptyState/EmptyState";
import OwnCommunityCard from "./OwnCommunityCard";
import CreateCommunityCircleButton from "../../components/molecules/CreateCommunityButton/CreateCommunityCircleButton";
import { useWindowSizeContext } from "../../context/WindowSizeProvider";
import { useCreateCommunityModalContext } from "../../context/CreateCommunityModalProvider";
import { useCommunitySidebarContext } from "components/organisms/CommunityViewSidebar/CommunityViewSidebarContext";

import { UserGroupIcon } from '@heroicons/react/24/outline';

import { useOwnCommunities, useOwnUser } from "context/OwnDataProvider";
import { getUrl } from 'common/util';
import { DndContext, DragEndEvent } from "@dnd-kit/core";
import { rectSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { dragAnnouncements, listCollisionDetection, useDragSensors } from "hooks/useDragSensors";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import data from "data";
import Scrollable from 'components/molecules/Scrollable/Scrollable';
import { Bell, ChatsTeardrop, CoinVertical, Compass, HouseSimple, Plus, Storefront } from '@phosphor-icons/react';
import { isActiveButton } from 'components/organisms/Menu/ExpandedMenu/ExpandedMenu';

type Properties = {
  isExpanded: boolean;
  contentRef: React.RefObject<HTMLDivElement>;
}

export default function OwnCommunitiesBrowser(props: Properties) {
  const delayedSaveTimeoutRef = useRef<any>(null);
  const ownUser = useOwnUser();
  const ownCommunities = useOwnCommunities();
  const { isExpanded, contentRef } = props;
  const { isMobile } = useWindowSizeContext();
  const { setVisible } = useCreateCommunityModalContext();
  const { setCommunitySidebarIsOpen } = useCommunitySidebarContext();
  const [sortedCommunities, setSortedCommunities] = useState(ownCommunities);
  const [draggingOver, setDraggingOver] = useState(false);
  const sensors = useDragSensors();
  const navigate = useNavigate();

  const navigateToHome = useCallback(() => {
    setCommunitySidebarIsOpen(false);
    if (window.location.pathname !== '/') {
      navigate(getUrl({type: 'home'}));
    } else {
      document.getElementById('home-scrollable')?.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [navigate, setCommunitySidebarIsOpen]);

  const sortCommunities = useCallback((orderedCommunityIds: string[]) => {
    const sortedCommunities: Models.Community.DetailView[] = [];
    orderedCommunityIds.forEach(communityId => {
      const foundCommunity = ownCommunities?.find(community => community.id === communityId);
      if (foundCommunity) {
        sortedCommunities.push(foundCommunity);
      }
    });
    return sortedCommunities;
  }, [ownCommunities]);

  useEffect(() => {
    const orderedCommunityIds = ownUser?.communityOrder || [];
    const sortedCommunities = sortCommunities(orderedCommunityIds);
    setSortedCommunities(sortedCommunities);
  }, [ownUser?.communityOrder, sortCommunities]);

  const updateCommunityOrder = useCallback((draggedCommunityId: string, sourceIndex: number, destinationIndex: number) => {
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
    const index = communityOrder.findIndex(communityId => communityId === draggedCommunityId);
    const orderedCommunityIds = [...communityOrder];
    orderedCommunityIds.splice(index, 1);
    orderedCommunityIds.splice(destinationIndex, 0, draggedCommunityId);

    const sortedCommunities = sortCommunities(orderedCommunityIds);
    setSortedCommunities(sortedCommunities);
    delayDebouncedSave(orderedCommunityIds, 200);
  }, [ownUser?.communityOrder]);

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
    const draggedCommunity = ownCommunities.find(community => community.id === active.id);
    if (draggedCommunity) {
      updateCommunityOrder(draggedCommunity.id, sourceIndex, destinationIndex);
    }
  }, [communityIds, ownCommunities, updateCommunityOrder]);

  const communitiesMemo = useMemo(() => {
    if (!!sortedCommunities && sortedCommunities.length > 0) {
      return <SortableContext items={communityIds} strategy={rectSortingStrategy}>
        <div
          className={[
            'own-communities-content column-view',
            draggingOver ? 'dragging-over' : ''
          ].join(' ').trim()}
        >
          {sortedCommunities.map(community => {
            // FIXME: unread should reflect the real value
            return <SortableCommunityCard
              key={community.id}
              community={community}
              collapsed={!isExpanded}
            />
          })}
        </div>
      </SortableContext>;
    }
    else {
      return null;
    }
  }, [sortedCommunities, communityIds, draggingOver, isExpanded])

  if (isMobile) {
    return (
      <Scrollable className='community-icons' hideOnNoScroll>
        <div className='own-communities' ref={contentRef}>
          <DndContext
            sensors={sensors}
            collisionDetection={listCollisionDetection}
            accessibility={{ announcements: dragAnnouncements }}
            onDragStart={() => setDraggingOver(true)}
            // rbd's isDraggingOver was on only while hovering the list, not
            // for the whole drag — with the cancel-outside collision rule,
            // `over` tracks it.
            onDragOver={event => setDraggingOver(!!event.over)}
            onDragCancel={() => setDraggingOver(false)}
            onDragEnd={onDragEnd}
          >
            <div className='own-communities-content-container'>
              <MobileMenuOption
                icon={<Compass weight='duotone' className='h-6 w-6' />}
                text='Explore'
                active={isActiveButton(window.location.pathname, '/') || isActiveButton(window.location.pathname, '/e/')}
                onClick={navigateToHome}
              />
              <MobileMenuOption
                icon={<CoinVertical weight='duotone' className='h-6 w-6' />}
                text='Stake'
                active={isActiveButton(window.location.pathname, getUrl({type: 'token'}))}
                onClick={() => {
                  setCommunitySidebarIsOpen(false);
                  navigate(getUrl({type: 'token'}));
                }}
              />
              <MobileMenuOption
                icon={<ChatsTeardrop weight='duotone' className='h-6 w-6' />}
                text='Chats'
                active={isActiveButton(window.location.pathname, getUrl({type: 'chats'}))}
                onClick={() => {
                  setCommunitySidebarIsOpen(false);
                  navigate(getUrl({ type: 'chats' }));
                }}
              />
              <MobileMenuOption
                icon={<Bell weight='duotone' className='h-6 w-6' />}
                text='Notifications'
                active={isActiveButton(window.location.pathname, getUrl({type: 'notifications'}))}
                onClick={() => {
                  setCommunitySidebarIsOpen(false);
                  navigate(getUrl({ type: 'notifications' }));
                }}
              />
              <MobileMenuOption
                icon={<Storefront weight='duotone' className='h-6 w-6' />}
                text='Appstore'
                active={isActiveButton(window.location.pathname, getUrl({type: 'appstore'}))}
                onClick={() => {
                  setCommunitySidebarIsOpen(false);
                  navigate(getUrl({ type: 'appstore' }));
                }}
              />
              <div className='py-2'><div className='cg-separator'/></div>
              <MobileMenuOption
                icon={<Plus weight='duotone' className='h-6 w-6' />}
                text='Create a community'
                onClick={() => setVisible(true)}
              />
              <MobileMenuOption
                icon={<HouseSimple weight='duotone' className='h-6 w-6' />}
                text='Browse communities'
                onClick={() => {
                  navigate(getUrl({ type: 'browse-communities' }));
                  setCommunitySidebarIsOpen(false);
                }}
              />
              <div className='py-2'><div className='cg-separator'/></div>
              <div className="own-communities-bottom-content">
                {communitiesMemo}
                {!!sortedCommunities && sortedCommunities.length === 0 && isExpanded && (
                  <EmptyState title="You haven't joined any communities yet" />
                )}
              </div>
            </div>
          </DndContext>
        </div>
      </Scrollable>
    );
  } else {
    // no desktop view
    setTimeout(() => navigate(getUrl({ type: 'home' })), 0);
    return (<></>);
  }
}

type SortableCommunityCardProps = {
  community: Models.Community.DetailView;
  collapsed: boolean;
};

/** The whole card is the drag handle, as it was under react-beautiful-dnd. */
function SortableCommunityCard(props: SortableCommunityCardProps) {
  const { community, collapsed } = props;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: community.id, data: { label: `community ${community.title}` } });

  return (
    <div
      // Node and keyboard activator in one: registering the activator restores
      // dnd-kit's `event.target` guard, so Space on a focused descendant is
      // not hijacked into a drag lift.
      ref={element => { setNodeRef(element); setActivatorNodeRef(element); }}
      {...attributes}
      {...listeners}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        position: 'relative',
        zIndex: isDragging ? 5000 : undefined,
      }}
      className={isDragging ? 'draggable-container dragging' : 'draggable-container'}
    >
      <OwnCommunityCard
        community={community}
        size='small'
        hideNewTag
        collapsed={collapsed}
      />
    </div>
  );
}

type MobileMenuOptionProps = {
  icon: JSX.Element;
  text: string;
  active?: boolean;
  onClick: () => void;
};

const MobileMenuOption: React.FC<MobileMenuOptionProps> = (props) => {
  return <div className={`flex items-center gap-2 px-2 ${props.active ? 'cg-text-brand' : 'cg-text-main'}`} onClick={props.onClick}>
    <div className='flex items-center justify-center h-12 w-12'>
      {props.icon}
    </div>
    <span className='flex-1 cg-text-lg-500'>{props.text}</span>
  </div>;
};
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
import { DragDropContext, Draggable, DropResult, Droppable } from "react-beautiful-dnd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import data from "data";
import Scrollable from 'components/molecules/Scrollable/Scrollable';
import { Bell, Brain, ChatsTeardrop, CoinVertical, Compass, HouseSimple, Plus, Storefront } from '@phosphor-icons/react';
import { isActiveButton } from 'components/organisms/Menu/ExpandedMenu/ExpandedMenu';
import config from 'common/config';

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

  const onDragEnd = useCallback(async (result: DropResult) => {
    const { draggableId, type, destination, source } = result;
    if (type === 'communities') {
      const changedLocation = !!source && !!destination && destination.droppableId === source.droppableId && destination.index !== source.index;
      if (changedLocation) {
        const draggedCommunity = ownCommunities.find(community => community.id === draggableId);
        if (draggedCommunity) {
          updateCommunityOrder(draggedCommunity.id, source.index, destination.index);
        }
      }
    }
  }, [ownCommunities, updateCommunityOrder]);

  const communitiesMemo = useMemo(() => {
    if (!!sortedCommunities && sortedCommunities.length > 0) {
      return <Droppable
        droppableId="communities"
        type="communities"
      >
        {(provided, snapshot) => (
          <div
            {...provided.droppableProps}
            ref={provided.innerRef}
            className={[
              'own-communities-content column-view',
              snapshot.isDraggingOver ? 'dragging-over' : ''
            ].join(' ').trim()}
          >
            {sortedCommunities.map((community, index) => {
              // FIXME: unread should reflect the real value
              return <Draggable
                key={community.id}
                draggableId={community.id}
                index={index}
              >
                {(provided, snapshot) => (
                  <div
                    {...provided.draggableProps}
                    {...provided.dragHandleProps}
                    ref={provided.innerRef}
                    className={snapshot.isDragging ? 'draggable-container dragging' : 'draggable-container'}
                  >
                    <OwnCommunityCard
                      key={community.id}
                      community={community}
                      size='small'
                      hideNewTag
                      collapsed={!isExpanded}
                    />
                  </div>
                )}
              </Draggable>
            })}
            {provided.placeholder}
          </div>
        )}
      </Droppable>;
    }
    else {
      return null;
    }
  }, [sortedCommunities, isExpanded])

  if (isMobile) {
    return (
      <Scrollable className='community-icons' hideOnNoScroll>
        <div className='own-communities' ref={contentRef}>
          <DragDropContext onDragEnd={onDragEnd}>
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
              {config.PERSONAL_ASSISTANT_ENABLED && <MobileMenuOption
                icon={<Brain weight='duotone' className='h-6 w-6' />}
                text='Assistant'
                active={isActiveButton(window.location.pathname, getUrl({type: 'assistant'}))}
                onClick={() => {
                  setCommunitySidebarIsOpen(false);
                  navigate(getUrl({ type: 'assistant' }));
                }}
              />}
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
          </DragDropContext>
        </div>
      </Scrollable>
    );
  } else {
    // no desktop view
    setTimeout(() => navigate(getUrl({ type: 'home' })), 0);
    return (<></>);
  }
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
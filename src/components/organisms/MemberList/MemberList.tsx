// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo } from "react";
import './MemberList.css';

import { useLoadedCommunityContext } from "../../../context/CommunityProvider";
import { useMemberListContext } from "./MemberListContext";
import { useWindowSizeContext } from "../../../context/WindowSizeProvider";

import UserTag from "../../atoms/UserTag/UserTag";
import Scrollable, { type PositionData } from "../../molecules/Scrollable/Scrollable";
import { FloatingDelayGroup } from "@floating-ui/react";
import SidebarExpandIcon from '../../../components/atoms/icons/20/SidebarExpand.svg?react';
import SearchField from "../../../components/atoms/SearchField/SearchField";
import { useCommunityChannelIdContext } from "context/CommunityChannelProvider";
import { useMultipleUserData } from "context/UserDataProvider";
import communityApi from "data/api/community";

type Props = {
}

type MemberListData = {
  memberList: Models.Community.ChannelMemberList;
  offset: number;
};

const statusPrio: Models.User.OnlineStatus[] = ['online', 'away', 'dnd', 'offline'];

const WINDOW_SIZE = 80;
const MEMBER_ITEM_HEIGHT = 56;

export const sortByOnlineState = (a: Models.User.Data, b: Models.User.Data) => {
  if (a.onlineStatus === b.onlineStatus) {
    return a.id < b.id ? -1 : 1;
  } else {
    return statusPrio.indexOf(a.onlineStatus) - statusPrio.indexOf(b.onlineStatus);
  }
};

export default function MemberList(props: Props) {
  const { isMobile, isTablet, width } = useWindowSizeContext();
  const { memberListIsOpen, setShowMemberList, memberListDrawerRef } = useMemberListContext();
  const { channelId } = useCommunityChannelIdContext();
  const { channelsById, community } = useLoadedCommunityContext();
  const [search, setSearch] = React.useState<string | undefined>();
  const [memberListData, setMemberListData] = React.useState<MemberListData | undefined>();
  const [offset, setOffset] = React.useState<number>(0);
  const intervalRef = React.useRef<any>(undefined);
  const retrievalDebouceRef = React.useRef<any>(undefined);
  const nextOffsetRef = React.useRef<number | undefined>(undefined);

  useEffect(() => {
    setMemberListData(undefined);
    setOffset(0);
    if (retrievalDebouceRef.current !== undefined) {
      clearTimeout(retrievalDebouceRef.current);
    }
  }, [community.id, channelId]);

  const updateMemberList = useCallback(() => {
    if (!channelId || !community) return;
    communityApi.getChannelMemberList({
      channelId: channelId,
      communityId: community.id,
      offset,
      limit: WINDOW_SIZE,
      search,
    }).then(res => {
      setMemberListData({
        memberList: res,
        offset,
      });
    }).catch(err => {
      setMemberListData(undefined);
      console.log(err);
    });
  }, [community.id, channelId, offset, search]);

  const updateOffsetByScrollState = useCallback((scrollState: PositionData) => {
    if (scrollState.scrollTop === 0 && offset === 0) {
      if (offset !== 0) {
        setOffset(0);
      }
      return;
    }
    if (scrollState.scrollTop === 0 && scrollState.contentHeight === scrollState.visibleHeight) {
      if (offset !== 0) {
        setOffset(0);
      }
      return;
    }
    if (scrollState.contentHeight === 0) {
      if (offset !== 0) {
        setOffset(0);
      }
      return;
    }
    const lowerFactor = Math.max((scrollState.scrollTop / scrollState.contentHeight), 0);
    const upperFactor = Math.min((scrollState.scrollTop + scrollState.visibleHeight) / scrollState.contentHeight, 1);
    const minVisible = Math.floor(lowerFactor * (memberListData?.memberList.count || 0));
    const maxVisible = Math.floor(upperFactor * (memberListData?.memberList.count || 0));
    const buffer = Math.max(0, Math.floor((WINDOW_SIZE - maxVisible + minVisible) / 2));
    const min = Math.max(0, minVisible - buffer);

    nextOffsetRef.current = min;
    if (retrievalDebouceRef.current === undefined) {
      retrievalDebouceRef.current = setTimeout(() => {
        retrievalDebouceRef.current = undefined;
        if (nextOffsetRef.current !== undefined) {
          setOffset(nextOffsetRef.current);
        }
        nextOffsetRef.current = undefined;
      }, 500);
    }
  }, [offset, memberListData?.memberList.count]);

  useEffect(() => {
    let interval: any;
    if (memberListIsOpen) {
      updateMemberList();
      interval = setInterval(updateMemberList, 5000);
    }
    return () => clearInterval(interval);
  }, [updateMemberList, memberListIsOpen]);

  useEffect(() => {
    const handleMemberListPosition = () => {
      if (memberListDrawerRef && memberListDrawerRef.current) {
        if (memberListIsOpen) {
          if (window.innerWidth > 1430) {
            memberListDrawerRef.current.style.transform = 'translateX(calc(100vw - 640px))';
          } else if (window.innerWidth < 640) {
            memberListDrawerRef.current.style.transform = 'translateX(calc(100vw - 280px))';
          } else {
            memberListDrawerRef.current.style.transform = 'translateX(calc(100vw - 640px))';
          }
        } else {
          memberListDrawerRef.current.style.transform = 'translateX(100vw)';
        }
      }
    }

    handleMemberListPosition();

    window.addEventListener('resize', handleMemberListPosition);

    return () => {
      window.removeEventListener('resize', handleMemberListPosition);
    }
  }, [memberListIsOpen, memberListDrawerRef, isMobile, isTablet]);

  useEffect(() => {
    const handleClickOutside = (ev: MouseEvent) => {
      const target = ev.target as Element;
      if (width < 1430 && memberListIsOpen && target && !memberListDrawerRef?.current?.contains(target)) {
        setShowMemberList(false);
      }
    };
    document.addEventListener('click', handleClickOutside, true);
    return () => {
      document.removeEventListener('click', handleClickOutside, true);
    };
  }, [memberListDrawerRef, memberListIsOpen, setShowMemberList, width]);

  if (!memberListIsOpen) return null;

  return (
    <div className={`group-member-list${memberListIsOpen ? " open" : ""}`} ref={memberListDrawerRef}>
      <div className="caption" onClick={() => setShowMemberList(false)}>
        <div className="member-list-title">
          <span>Members {channelId && `in ${channelsById.get(channelId)?.title}`}</span>
        </div>
        <SidebarExpandIcon />
      </div>
      <Scrollable className="search-field-container">
        <SearchField
          placeholder="Search for people"
          value={search || ''}
          onChange={(value) => setSearch(value || undefined)}
        />
      </Scrollable>
      <div className="group-member-list-content">
        <FloatingDelayGroup delay={{ open: 500, close: 100 }}>
          <Scrollable innerClassName="px-3" positionCallback={updateOffsetByScrollState}>
            <MemberListByRole
              channelId={channelId}
              channelsById={channelsById}
              memberListData={memberListData}
              search={search}
            />
          </Scrollable>
        </FloatingDelayGroup>
      </div>
    </div>
  );
}

type ListByRoleProps = {
  channelId: string | undefined;
  channelsById: Readonly<Map<string, Models.Community.Channel>>;
  memberListData: MemberListData | undefined;
  search: string | undefined;
};

const MemberListByRole: React.FC<ListByRoleProps> = React.memo(({ channelId, channelsById, memberListData, search }) => {
  const memberList = memberListData?.memberList;

  const userIds = useMemo(() => {
    if (!memberList) return [];
    return memberList.admin.concat(memberList.moderator, memberList.writer, memberList.reader, memberList.offline).map(m => m[0]);
  }, [memberList]);

  const __allMembers = useMultipleUserData(userIds);

  if (!memberList) return null;

  const offset = memberListData?.offset || 0;
  const limit = WINDOW_SIZE;

  const moderatorStart = memberList.adminCount;
  const writerStart = moderatorStart + memberList.moderatorCount;
  const readerStart = writerStart + memberList.writerCount;
  const offlineStart = readerStart + memberList.readerCount;

  const adminElements: React.JSX.Element[] = [];
  const moderatorElements: React.JSX.Element[] = [];
  const writerElements: React.JSX.Element[] = [];
  const readerElements: React.JSX.Element[] = [];
  const offlineElements: React.JSX.Element[] = [];

  const offsetLimitSum = offset + limit;
  const offlineSubtract = Math.max(offlineStart, offset);
  const readerSubtract = Math.max(readerStart, offset);
  const writerSubtract = Math.max(writerStart, offset);
  const moderatorSubtract = Math.max(moderatorStart, offset);

  // gapCounter is used to add placeholder elements to the list to keep the scroll position
  let gapCounter = 0;
  let groupForNextGapElement: React.JSX.Element[] = adminElements;
  const injectGapElement = (currentIndex: number) => {
    if (gapCounter > 0) {
      groupForNextGapElement.push(
        <MemberListItem
          data={{type: 'placeholder', size: gapCounter}}
          key={`gap-${currentIndex}`}
          index={currentIndex}
          channelId={channelId}
        />
      );
      gapCounter = 0;
    }
  };

  for (let index = 0; index < memberList.count; index++) {
    if (index >= offlineStart) {
      if (index === offlineStart && gapCounter > 0) {
        injectGapElement(index);
      }
      let userId: string | undefined;
      if (index >= offset && index < offsetLimitSum) {
        userId = memberList.offline[index - offlineSubtract]?.[0] as string | undefined;
      }
      const user = userId ? __allMembers[userId] : undefined;
      if (!user) { 
        groupForNextGapElement = offlineElements;
        gapCounter++;
      }
      else {
        if (gapCounter > 0) {
          injectGapElement(index);
        }
        offlineElements.push(
          <MemberListItem
            data={{type: 'user', user}}
            key={userId}
            index={index}
            channelId={channelId}
          />
        );
      }
      
    }
    else if (index >= readerStart) {
      if (index === readerStart && gapCounter > 0) {
        injectGapElement(index);
      }
      let userId: string | undefined;
      if (index >= offset && index < offsetLimitSum) {
        userId = memberList.reader[index - readerSubtract]?.[0] as string | undefined;
      }
      const user = userId ? __allMembers[userId] : undefined;
      if (!user) { 
        groupForNextGapElement = readerElements;
        gapCounter++;
      }
      else {
        if (gapCounter > 0) {
          injectGapElement(index);
        }
        readerElements.push(
          <MemberListItem
            data={{type: 'user', user}}
            key={userId}
            index={index}
            channelId={channelId}
          />
        );
      }
    }
    else if (index >= writerStart) {
      if (index === writerStart && gapCounter > 0) {
        injectGapElement(index);
      }
      let userId: string | undefined;
      if (index >= offset && index < offsetLimitSum) {
        userId = memberList.writer[index - writerSubtract]?.[0] as string | undefined;
      }
      const user = userId ? __allMembers[userId] : undefined;
      if (!user) { 
        groupForNextGapElement = writerElements;
        gapCounter++;
      }
      else {
        if (gapCounter > 0) {
          injectGapElement(index);
        }
        writerElements.push(
          <MemberListItem
            data={{type: 'user', user}}
            key={userId}
            index={index}
            channelId={channelId}
          />
        );
      }
    }
    else if (index >= moderatorStart) {
      if (index === moderatorStart && gapCounter > 0) {
        injectGapElement(index);
      }
      let userId: string | undefined;
      if (index >= offset && index < offsetLimitSum) {
        userId = memberList.moderator[index - moderatorSubtract]?.[0] as string | undefined;
      }
      const user = userId ? __allMembers[userId] : undefined;
      if (!user) { 
        groupForNextGapElement = moderatorElements;
        gapCounter++;
      }
      else {
        if (gapCounter > 0) {
          injectGapElement(index);
        }
        moderatorElements.push(
          <MemberListItem
            data={{type: 'user', user}}
            key={userId}
            index={index}
            channelId={channelId}
          />
        );
      }
    }
    else {
      let userId: string | undefined;
      if (index >= offset && index < offsetLimitSum) {
        userId = memberList.admin[index - offset]?.[0] as string | undefined;
      }
      const user = userId ? __allMembers[userId] : undefined;
      if (!user) { 
        groupForNextGapElement = adminElements;
        gapCounter++;
      }
      else {
        if (gapCounter > 0) {
          injectGapElement(index);
        }
        adminElements.push(
          <MemberListItem
            data={{type: 'user', user}}
            key={userId}
            index={index}
            channelId={channelId}
          />
        );
      }
    }
  }

  if (gapCounter > 0) {
    injectGapElement(memberList.count);
  }

  return <>
    {memberList.adminCount > 0 && <>
      <div className="role-title">
        <span>Admins</span> <span>{memberList.adminCount}</span>
      </div>
      {adminElements}
    </>}

    {memberList.moderatorCount > 0 && <>
      <div className="role-title">
        <span>Moderators</span> <span>{memberList.moderatorCount}</span>
      </div>
      {moderatorElements}
    </>}

    {memberList.writerCount > 0 && <>
      <div className="role-title">
        <span>Members with write access</span> <span>{memberList.writerCount}</span>
      </div>
      {writerElements}
    </>}

    {memberList.readerCount > 0 && <>
      <div className="role-title">
        <span>Members with read access</span> <span>{memberList.readerCount}</span>
      </div>
      {readerElements}
    </>}

    {memberList.offlineCount > 0 && <>
      <div className="role-title">
        <span>Offline members</span> <span>{memberList.offlineCount}</span>
      </div>
      {offlineElements}
    </>}
  </>
});

function MemberListItem(props: {
  data: {
    type: 'user';
    user: Models.User.Data;
  } | {
    type: 'placeholder';
    size: number;
  }
  channelId: string | undefined;
  index: number;
}) {
  const { data, channelId, index } = props;

  const placeholderElement = useMemo(() => {
    if (data.type !== 'placeholder') return null;

    const height = MEMBER_ITEM_HEIGHT * data.size;
    const svg = encodeURI("data:image/svg+xml," +
      "<svg xmlns='http://www.w3.org/2000/svg' width='204px' height='56px' viewBox='0 0 204 56'>" +
        "<circle cx='24' cy='28' r='20' fill='rgba(128, 128, 128, 0.2)'/>" +
        "<rect x='48' y='20' width='120' height='16' rx='3' ry='3' fill='rgba(128, 128, 128, 0.2)'/>" +
      "</svg>");

    return (
      <div
        style={{
          height: `${height}px`,
          minHeight: `${height}px`,
          padding: "8px 12px 8px 4px",
          backgroundImage: `url("${svg}")`,
          backgroundRepeat: "repeat-y",
          backgroundSize: "204px 56px",
          backgroundPosition: "0 0",
        }}
        key={index}
        className="memberlist-placeholder"
      />
    );
  }, [data]);

  if (data.type === 'user') {
    return (
      <div
        key={index}
      >
        <UserTag
          userData={data.user}
          key={data.user.id}
          listId={data.user.id}
          channelId={channelId}
        />
      </div>
    );
  }
  else {
    return placeholderElement;
  }
}
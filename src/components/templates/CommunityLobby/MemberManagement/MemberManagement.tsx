// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useMemo, useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { FloatingDelayGroup } from "@floating-ui/react";

import { useLoadedCommunityContext } from "../../../../context/CommunityProvider";
import { useCommunitySidebarContext } from "../../../../components/organisms/CommunityViewSidebar/CommunityViewSidebarContext";
import { useWindowSizeContext } from "../../../../context/WindowSizeProvider";

import SearchField from "../../../../components/atoms/SearchField/SearchField";
import Jdenticon from "../../../atoms/Jdenticon/Jdenticon";
import LeaveCommunityModal from "../../../../components/organisms/LeaveCommunityModal/LeaveCommunityModal";
import UserTooltip from "../../../organisms/UserTooltip/UserTooltip";
import Scrollable, { type PositionData } from "components/molecules/Scrollable/Scrollable";
import { useMultipleUserData } from "context/UserDataProvider";

import "./MemberManagement.css";
import Button from "components/atoms/Button/Button";
import { getDisplayName } from "../../../../util";
import communityApi from "data/api/community";
import ManagementHeader2 from "components/molecules/ManagementHeader2/ManagementHeader2";
import BotBadge from "components/atoms/BotBadge/BotBadge";

const WINDOW_SIZE = 80;
const MEMBER_ITEM_HEIGHT = 81;

export default function MemberManagement() {
  const navigate = useNavigate();
  const { isMobile } = useWindowSizeContext();
  const { showLeaveGroupModal, setShowLeaveGroupModal } = useCommunitySidebarContext();
  const { community, rolesById, roles } = useLoadedCommunityContext();
  const [search, setSearch] = useState<string | undefined>();
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [memberListData, setMemberListData] = useState<{
    memberList: Models.Community.MemberList;
    offset: number;
  }>();
  const [offset, setOffset] = useState<number>(0);
  const visibleIndicesRef = React.useRef<Set<number>>(new Set());
  const retrievalDebouceRef = React.useRef<any>(undefined);
  const nextOffsetRef = React.useRef<number | undefined>(undefined);

  const updateMemberList = useCallback(() => {
    if (!community) {
      return;
    }
    communityApi.getMemberList({
      communityId: community.id,
      offset,
      limit: WINDOW_SIZE,
      search: search || undefined,
      roleId: roleFilter === 'all' ? undefined : roleFilter,
    }).then(res => {
      setMemberListData({
        memberList: res,
        offset,
      });
    }).catch(err => {
      setMemberListData(undefined);
      console.log(err);
    });
  }, [community, search, roleFilter, offset]);

  useEffect(() => {
    let interval: any;
    updateMemberList();
    interval = setInterval(updateMemberList, 5000);
    return () => clearInterval(interval);
  }, [updateMemberList]);

  useEffect(() => {
    visibleIndicesRef.current = new Set();
  }, [memberListData]);

  const updateOffsetByScrollState = useCallback((scrollState: PositionData) => {
    if (scrollState.scrollTop === 0 && offset !== 0) {
      setOffset(0);
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
    const minVisible = Math.floor(lowerFactor * (memberListData?.memberList.resultCount || 0));
    const maxVisible = Math.floor(upperFactor * (memberListData?.memberList.resultCount || 0));
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
  }, [offset, memberListData?.memberList.resultCount]);

  const memberListConcat = useMemo(() => {
    if (!memberListData) return [];
    return memberListData.memberList.online.concat(memberListData.memberList.offline) || [];
  }, [memberListData]);

  const userIds = useMemo(() => {
    return memberListConcat.map(m => m[0]) || [];
  }, [memberListConcat]);

  const userData = useMultipleUserData(userIds);

  const className = [
    "member-roles-management",
    isMobile ? 'mobile-member-roles-management' : 'desktop-member-roles-management'
  ].join(' ');

  const roleFilterItems = useMemo(() => {
    return roles.map(role => {
      const userCount = memberListData?.memberList.roles.find(item => item[0] === role.id)?.[1] || 0;
      return { role, userCount };
    });
  }, [roles, memberListData]);

  const memberItems = useMemo(() => {
    const items: JSX.Element[] = [];
    if (!memberListData) return items;
    const { memberList, offset } = memberListData;

    let gapCounter = 0;
    const injectGapElement = () => {
      items.push((
        <MemberItem
          key={`gap-${items.length}`}
          index={items.length}
          data={{
            type: 'placeholder',
            size: gapCounter,
          }}
        />
      ));
      gapCounter = 0;
    };

    for (let i = 0; i < memberList.resultCount; i++) {
      if (i < offset || i >= offset + WINDOW_SIZE) {
        gapCounter++;
      }
      else {
        const member = memberListConcat[i - offset];
        if (!!member) {
          const userId = member[0];
          const roles = member[1].map(id => rolesById.get(id)).filter(v => !!v) as Models.Community.Role[];
          const user = userData[userId];
          if (!!user) {
            if (gapCounter > 0) {
              injectGapElement();
            }
            items.push((
              <MemberItem
                key={i}
                index={i}
                data={{
                  type: 'user',
                  user,
                  roles: roles || [],
                }}
              />
            ));
          }
          else {
            gapCounter++;
          }
        }
        else {
          gapCounter++;
        }
      }
    }

    if (gapCounter > 0) {
      injectGapElement();
    }

    return items;
  }, [memberListData, memberListConcat, rolesById, userData]);

  const memberManagementContent = useMemo(() => <div className="members-list cg-text-main">
    <div className="flex flex-col gap-4">
      <p className="section-title">{memberListData?.memberList.totalCount} Members of {community.title}</p>
      <div
        style={{
          overflowX: 'auto',
          marginLeft: '-2px',
          marginTop: '-2px',
          padding: '2px',
          maxWidth: '100%',
        }}
        className={`member-management-role-buttons flex gap-2 ${isMobile ? "" : "flex-wrap"}`}
      >
        <Button text={`All${memberListData ? ` (${memberListData.memberList.totalCount})` : ''}`} role="chip" onClick={() => setRoleFilter('all')} className={roleFilter === 'all' ? 'active' : undefined} />
        {roleFilterItems.map(roleEntry => (
          <Button
            key={roleEntry.role.id}
            text={`${roleEntry.role.title} (${roleEntry.userCount})`}
            role="chip"
            onClick={() => {
              setRoleFilter(roleEntry.role.id);
              setSearch(undefined);
              setOffset(0);
            }}
            className={roleFilter === roleEntry.role.id ? 'active' : undefined}
          />
        ))}
      </div>
      <SearchField
        value={search || ''}
        onChange={value => {
          setSearch(value || undefined);
          setRoleFilter('all');
          setOffset(0);
        }}
        placeholder='Find users by nickname or address'
      />
    </div>
    <div className="member-list-inner">
      <FloatingDelayGroup delay={{ open: 500, close: 100 }}>
        {memberItems}
      </FloatingDelayGroup>
    </div>
  </div>, [memberListData, community.title, isMobile, roleFilter, roleFilterItems, search, memberItems]);

  if (isMobile) {
    return (
      <>
        <div className={className}>
          <ManagementHeader2
            title="Members"
            goBack={() => navigate(-1)}
          />
          <Scrollable positionCallback={updateOffsetByScrollState}>
            {memberManagementContent}
          </Scrollable>
        </div>
        <LeaveCommunityModal open={showLeaveGroupModal} onClose={() => setShowLeaveGroupModal(false)} />
      </>
    );
  }
  else {
    return (
      <Scrollable positionCallback={updateOffsetByScrollState}>
        <div className="member-management-view-inner">
          <div className={className}>
            <ManagementHeader2
              title="Members"
              goBack={() => navigate(-1)}
            />
            {memberManagementContent}
          </div>
          <LeaveCommunityModal open={showLeaveGroupModal} onClose={() => setShowLeaveGroupModal(false)} />
        </div>
      </Scrollable>
    );
  }
}

type MemberItemProps = {
  data: {
    type: 'user';
    user: Models.User.Data;
    roles: Models.Community.Role[];
  } | {
    type: 'placeholder';
    size: number;
  }
  index: number;
};

const MemberItem: React.FC<MemberItemProps> = ({ data, index }) => {
  const ownRef = React.useRef<HTMLDivElement>(null);

  const roleElement = useMemo(() => {
    if (data.type !== 'user') {
      return null;
    }
    return <div className="flex gap-0.5 items-center flex-nowrap overflow-x-hidden">
      {data.roles.reduce<(JSX.Element | string)[]>(
        (agg, role) => {
          agg.push(
            <span className={`member-list-role`} key={role.id}>
              {role.title}
            </span>
          );
          return agg;
        }, [])
      }
    </div>;
  }, [data.type === 'user' ? data.roles : null]);

  if (data.type === 'placeholder') {
    const height = MEMBER_ITEM_HEIGHT * data.size;
    const svg = encodeURI("data:image/svg+xml," +
      "<svg xmlns='http://www.w3.org/2000/svg' width='5000px' height='81px' viewBox='0 0 5000 81'>" +
      "<circle cx='40' cy='40' r='24' fill='rgba(128, 128, 128, 0.2)'/>" +
      "<rect x='72' y='30' width='150' height='20' rx='3' ry='3' fill='rgba(128, 128, 128, 0.2)'/>" +
      "<line x1='0' y1='81' x2='5000' y2='81' stroke='rgba(128, 128, 128, 0.2)' stroke-width='1'/>" +
      "</svg>");

    return (
      <div
        style={{
          height: `${height}px`,
          minHeight: `${height}px`,
          padding: "8px 12px 8px 4px",
          backgroundImage: `url("${svg}")`,
          backgroundRepeat: "repeat-y",
          backgroundSize: "5000px 81px",
          backgroundPosition: "0 0",
        }}
        key={index}
        className="membermanagement-placeholder"
      />
    );
  }

  return (
    <div
      className="member-item"
      key={index}
      data-listindex={index}
      ref={ownRef}
    >
      <UserTooltip
        userId={data.user.id}
        isMessageTooltip={false}
        listId={data.user.id}
        triggerClassName="flex"
      >
        <div className="flex gap-2">
          <Jdenticon userId={data.user.id} />
          <div className='member-item-text'>
            <span className="member-display-name flex items-center gap-1">
              {getDisplayName(data.user)}
              {data.user.isBot && <BotBadge />}
            </span>
            {roleElement}
          </div>
        </div>
      </UserTooltip>
    </div>
  )
}

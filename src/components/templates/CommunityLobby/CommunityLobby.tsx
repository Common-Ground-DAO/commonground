// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import { useCallback, useMemo, useRef } from "react";

import { useMemberListContext } from "../../../components/organisms/MemberList/MemberListContext";

import CommunityHome from "./CommunityHome/CommunityHome";
import TextChannel from "../../../components/organisms/TextChannel/TextChannel";
import Scrollable, { PositionData } from "../../molecules/Scrollable/Scrollable";
import { useLoadedCommunityContext } from "context/CommunityProvider";

import "./CommunityLobby.css";

export type CommunityContent = 'lobby' | 'text-channel';

type Props = {
    channelId?: string;
    positionCallback?: (direction: 'up' | 'down') => void;
};

const MIN_SCROLL_DELTA = 20;

export default function CommunityLobby(props: Props) {
    const { channelId, positionCallback: propsPositionCallback} = props;
    const { memberListIsOpen, setShowMemberList } = useMemberListContext();
    const { community, channelsById, areasById } = useLoadedCommunityContext();
    const scrollableRef = useRef<React.ElementRef<typeof Scrollable>>(null);
    const scrollY = useRef(0);

    const channel = useMemo(() => {
        return !!channelId ? channelsById.get(channelId) : undefined;
    }, [channelId, channelsById]);
    
    const area = useMemo(() => {
        return !!channel && !!channel.areaId ? areasById.get(channel.areaId) : undefined;
    }, [areasById, channel]);

    // FIXME: Refactor this thing when possible
    const positionCallback = useCallback((data: PositionData) => {
        if (propsPositionCallback) {
            if (data.isTop) {
                propsPositionCallback('up');
            } else if (data.isBottom) {
                propsPositionCallback('down');
            } else {
                const lastY = scrollY.current;
                const currDiff = lastY - data.scrollTop;
                if (Math.abs(currDiff) >= MIN_SCROLL_DELTA) {
                    propsPositionCallback(currDiff > 0 ? 'up' : 'down');
                    scrollY.current = data.scrollTop;
                }
            }
        }
    }, [propsPositionCallback]);

    const onMemberListToggle = useCallback(() => {
        setShowMemberList(old => !old);
    }, []);

    const content: React.JSX.Element | null = useMemo(() => {
        if (!!channel) {
            return (
                <TextChannel
                    community={community}
                    channel={channel}
                    area={area}
                    memberListIsExpanded={memberListIsOpen}
                    onMemberListToggle={onMemberListToggle}
                />
            );
        }
        return (<CommunityHome />);
    }, [area, channel, community, memberListIsOpen]);

    return (
        <Scrollable
            positionCallback={positionCallback}
            ref={scrollableRef}
        >
            <div className="community-lobby">
                {content}
            </div>
        </Scrollable>
    );
}
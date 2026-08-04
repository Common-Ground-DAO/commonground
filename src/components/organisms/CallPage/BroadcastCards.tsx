// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useMemo } from "react";
import "./BroadcastCards.css";
import { useCallContext } from 'context/CallProvider';
import PeerCard from "./PeerCard";
import { RoomPeer } from "./CallPage.reducer";
import { useMultipleUserData } from "context/UserDataProvider";
import { useWindowSizeContext } from "context/WindowSizeProvider";
import AudienceList from "./AudienceList/AudienceList";
import { HouseSimple } from "@phosphor-icons/react";
import { useLoadedCommunityContext } from "context/CommunityProvider";
import { CommunityPremiumFeatureName } from "common/enums";
import Button from "components/atoms/Button/Button";
import { createSearchParams, useNavigate } from "react-router-dom";
import { getUrl } from "common/util";
import { useCommunityPremiumTier } from "hooks/usePremiumTier";

type Props = {
    mobileCollapsed: boolean;
}

const BroadcastCards: React.FC<Props> = ({ mobileCollapsed }) => {
    const { peers, activeSpeaker, spotlightedPeer, broadcasters, callSlots, stageSlots } = useCallContext();
    const { community } = useLoadedCommunityContext();
    const { premium } = community;
    const { canUpgradeTier } = useCommunityPremiumTier(premium);

    const navigate = useNavigate();

    const { isMobile } = useWindowSizeContext();
    const peersArray = useMemo(() => Array.from(peers.values()), [peers]);
    const peerIds = useMemo(() => Array.from(peers.keys()), [peers]);

    const __allUsers = useMultipleUserData(peerIds);
    const allUsers = Object.values(__allUsers).filter(value => !!value) as Models.User.Data[];

    const broadcastersArray = useMemo(() => peersArray.filter(p => broadcasters.has(p.id)), [peersArray, broadcasters]);
    const sortedBroadcastersByPriority = useMemo(() => {
        const isSpotlightedPeer = (obj: RoomPeer) => obj.id === spotlightedPeer;
        const isActiveSpeaker = (obj: RoomPeer) => obj.id === activeSpeaker;

        const sortedBroadcasters = broadcastersArray.sort((a, b) => {
            if (isSpotlightedPeer(a)) return -1;
            if (isSpotlightedPeer(b)) return 1;

            if (a.priority !== b.priority) return b.priority - a.priority;

            if (isActiveSpeaker(a)) return -1;
            if (isActiveSpeaker(b)) return 1;

            return 0;
        });
        if (sortedBroadcasters.length === 2) {
            if (sortedBroadcasters[0].isMe && sortedBroadcasters[0].id !== spotlightedPeer) {
                return sortedBroadcasters.reverse();
            }
        }
        // return [...sortedBroadcasters,...sortedBroadcasters,...sortedBroadcasters,...sortedBroadcasters,...sortedBroadcasters,...sortedBroadcasters,];
        return sortedBroadcasters;
    }, [broadcastersArray, spotlightedPeer, activeSpeaker]);

    const broadcasterCards = useMemo(() => {
        const result: Record<string, React.JSX.Element> = {};
        for (const peer of sortedBroadcastersByPriority) {
            const actualUser = allUsers?.find(u => u.id === peer.id);
            if (actualUser) {
                result[peer.id] = <PeerCard
                    key={peer.id}
                    user={peer}
                    actualUser={actualUser}
                    isMainCard={peer.id === sortedBroadcastersByPriority[0].id}
                />
            }
        }
        return result;
    }, [allUsers, sortedBroadcastersByPriority]);

    const activeBroadcasterCard = useMemo(() => {
        const firstUser = sortedBroadcastersByPriority[0];
        if (firstUser) {
            return broadcasterCards[firstUser.id];
        }
    }, [broadcasterCards, sortedBroadcastersByPriority]);

    const navigatePremium = useCallback(() => {
        if (isMobile) {
          navigate(getUrl({ type: 'community-settings-upgrades', community }));
        } else {
          navigate({
            search: createSearchParams({
              modal: 'premium-management'
            }).toString()
          });
        }
      }, [community, isMobile, navigate]);

    return (
        <div className="broadcast-container flex flex-col items-center flex-1 overflow-hidden self-stretch">
            <div className="flex justify-between w-full flex-row overflow-hidden self-stretch">
                <div className="cg-text-md-500 flex gap-2 cg-text-main p-2 items-center">
                    <HouseSimple className="w-5 h-5 cg-text-secondary" weight="duotone"/>
                    <span>{`Stage ${broadcasters.size}/${stageSlots}`}</span>
                </div>
                <div className={`cg-text-md-500 flex gap-2 p-2 items-center ${peerIds.length === callSlots ? "cg-text-warning" : "cg-text-secondary"}`}>
                    <span>{`In Call (${peerIds.length}/${callSlots})${peerIds.length === callSlots ? " Full" : ""}`}</span>
                    {peerIds.length === callSlots && canUpgradeTier && <Button 
                        text={"Upgrade"}
                        role="textual"
                        className="cg-text-md-500 cg-text-warning upgrade-button"
                        onClick={navigatePremium}
                    />}
                </div>
            </div>
            <div className="broadcast-peers-active-speaker">
                {activeBroadcasterCard}
            </div>
            {!mobileCollapsed && <div className="broadcast-peers-other-peers">
                {sortedBroadcastersByPriority.length > 1 && <div className="broadcast-peers-other-broadcasters">
                    {sortedBroadcastersByPriority.slice(1, sortedBroadcastersByPriority.length).map((user: RoomPeer) => {
                        return broadcasterCards[user.id];
                    })}
                </div>}
                {!isMobile && <>
                    <div className="cg-separator" />
                    <AudienceList />
                </>}
            </div>}
        </div>
    );
}

export default BroadcastCards;
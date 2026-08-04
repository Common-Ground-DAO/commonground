// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import "./Peers.css";
import React, { useMemo } from "react";
import { useCallContext } from 'context/CallProvider';
import PeerCard from "./PeerCard";
import { RoomPeer } from "./CallPage.reducer";
import { useMultipleUserData } from "context/UserDataProvider";

type Props = {
    mobileCollapsed: boolean;
}

const PeersCards: React.FC<Props> = ({ mobileCollapsed }) => {
    const { peers, activeSpeaker, spotlightedPeer } = useCallContext();
    const peersArray = useMemo(() => {
        return Array.from(peers.values());
    },
        [peers]);
    const peerIds = useMemo(() => {
        return Array.from(peers.keys());
    }, [peers]);

    const __allUsers = useMultipleUserData(peerIds);
    const allUsers =
        Object.values(__allUsers)
            .filter(value => !!value) as Models.User.Data[];

    const sortedPeersByPriority = useMemo(() => {
        const isSpotlightedPeer = (obj: RoomPeer) => obj.id === spotlightedPeer;
        const isActiveSpeaker = (obj: RoomPeer) => obj.id === activeSpeaker;

        const sortedPeers = peersArray.sort((a, b) => {
            if (isSpotlightedPeer(a)) return -1;
            if (isSpotlightedPeer(b)) return 1;

            if (a.priority !== b.priority) return b.priority - a.priority;

            if (isActiveSpeaker(a)) return -1;
            if (isActiveSpeaker(b)) return 1;

            return 0;
        });

        // TODO: Remove me
        // sortedPeers.push(...sortedPeers);
        // sortedPeers.push(...sortedPeers);
        // sortedPeers.push(...sortedPeers);
        // sortedPeers.push(...sortedPeers);
        // sortedPeers.push(...sortedPeers);
        // TODO: End of remove me
        
        if (sortedPeers.length === 2) {
            if (sortedPeers[0].isMe && sortedPeers[0].id !== spotlightedPeer) {
                return sortedPeers.reverse();
            }
        }
        return sortedPeers;
    }, [peersArray, spotlightedPeer, activeSpeaker]);

    const peerCards = useMemo(() => {
        const result: Record<string, React.JSX.Element> = {};
        for (const peer of sortedPeersByPriority) {
            const actualUser = allUsers?.find(u => u.id === peer.id);
            if (actualUser) {
                result[peer.id] = <PeerCard
                    key={peer.id}
                    user={peer}
                    actualUser={actualUser}
                    isMainCard={peer.id === sortedPeersByPriority[0].id}
                />
            }
        }
        return result;
    }, [allUsers, sortedPeersByPriority]);

    const activePeerCard = useMemo(() => {
        const firstUser = sortedPeersByPriority[0];
        if (firstUser) {
            return peerCards[firstUser.id];
        }
    }, [peerCards, sortedPeersByPriority]);

    return (
        <div className="call-peers-container">
            <div className={`call-peers-active-speaker${peersArray.length === 1 ? ' alone' : ''}`}>
                {activePeerCard}
            </div>

            {!mobileCollapsed && peersArray.length > 1 && <div className="call-peers-other-peers">
                {sortedPeersByPriority.slice(1, sortedPeersByPriority.length).map((user: RoomPeer) => {
                    return peerCards[user.id];
                })}
            </div>}
        </div>
    );
}

export default PeersCards;
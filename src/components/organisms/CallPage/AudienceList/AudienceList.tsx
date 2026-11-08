// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useMemo } from 'react'
import './AudienceList.css';
import { useCallContext } from 'context/CallProvider';
import { RoomPeer } from '../CallPage.reducer';
import AudienceCard from '../AudienceCard';
import { useMultipleUserData } from 'context/UserDataProvider';
import { HouseSimple, UsersThree } from '@phosphor-icons/react';

type Props = {

}

const AudienceList: React.FC<Props> = () => {
  const { peers, broadcasters, raisedHands } = useCallContext();
  const peersArray = useMemo(() => Array.from(peers.values()), [peers]);
  const peerIds = useMemo(() => Array.from(peers.keys()), [peers]);
  
  const __allUsers = useMultipleUserData(peerIds);
  const allUsers = Object.values(__allUsers).filter(value => !!value) as Models.User.Data[];

  const audienceArray = useMemo(() => peersArray.filter(p => !broadcasters.has(p.id)), [broadcasters, peersArray]);
  // const audienceArray = useMemo(() => {
  //   const temp = [...Array.from(broadcasters.values()), ...Array.from(broadcasters.values()),...Array.from(broadcasters.values()), ...Array.from(broadcasters.values())];
  //   return [...temp, ...temp, ...temp];
  // }, [broadcasters]);
  const sortedAudienceByHandRaised = useMemo(() => {
    //sort audience peers by raised hands
    const sortedAudience = audienceArray.sort((a, b) => {
      if (raisedHands.has(a.id) && !raisedHands.has(b.id)) return -1;
      if (!raisedHands.has(a.id) && raisedHands.has(b.id)) return 1;
      return 0;
    });
    return sortedAudience;
  }, [audienceArray, raisedHands]);

  const audienceCards = useMemo(() => {
    const result: Record<string, React.JSX.Element> = {};
    for (const peer of sortedAudienceByHandRaised) {
      const actualUser = allUsers?.find(u => u.id === peer.id);
      if (actualUser) {
        result[peer.id] = <AudienceCard
          key={peer.id}
          user={peer}
          actualUser={actualUser}
        />
      }
    }
    return result;
  }, [allUsers, sortedAudienceByHandRaised]);

  const audienceContainer = useMemo(() => (
    <div className="audience-peers-container">
      {sortedAudienceByHandRaised.map((user: RoomPeer) => {
        return audienceCards[user.id];
      })}
    </div>
  ), [audienceCards, sortedAudienceByHandRaised]);

  return (<>
    <div className='flex gap-2 items-center'>
      <HouseSimple className="w-5 h-5 cg-text-secondary" weight="duotone"/>
      <span className="cg-text-lg-500 cg-text-main">{`Audience (${audienceArray.length})`}</span>
    </div>
    {audienceContainer}
  </>)
}

export default React.memo(AudienceList);
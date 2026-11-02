// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import './PreviewCards.css';
import './../PeerCard.css';
import Jdenticon from 'components/atoms/Jdenticon/Jdenticon';
import UserTag from 'components/atoms/UserTag/UserTag';
import { useSignedUrl } from 'hooks/useSignedUrl';
import { cssBackgroundImage } from 'util/cssBackground';

type Props = {
  membersInCall: Models.User.Data[];
}

const PreviewCards: React.FC<Props> = (props) => {
  const { membersInCall } = props;

  return <div className='call-peers-container preview-cards'>
    {membersInCall.map(member => <PreviewCard member={member} key={member.id} />)}
  </div>;
}

const PreviewCard: React.FC<{member: Models.User.Data}> = (props) => {
  const { member } = props;
  const imageUrl = useSignedUrl(member.accounts.find(acc => acc.type === member.displayAccount)?.imageId);

  return <div className='call-peer-card cg-border-xl overflow-hidden' key={member.id} style={{ backgroundImage: cssBackgroundImage(imageUrl) }}>
  <div className={"blur"} />
  <div className='call-card-avatar flex w-24 h-24'>
    <Jdenticon key={member.id} userId={member.id} hideStatus />
  </div>
  <div className="call-user-tag" onClick={(e) => e.stopPropagation()}>
    <UserTag userData={member} hideStatus />
  </div>
</div>
}

export default React.memo(PreviewCards);
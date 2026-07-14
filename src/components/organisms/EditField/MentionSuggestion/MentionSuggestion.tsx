// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import './MentionSuggestion.css';
import { getDisplayNameString } from '../../../../util';
import Jdenticon from '../../../atoms/Jdenticon/Jdenticon';
import { insertMention } from '../EditField.helpers';
import { useSlate } from 'slate-react';
import { BaseRange } from 'slate';
import BotBadge from '../../../atoms/BotBadge/BotBadge';

type Props = {
  currentInput?: string;
  userData: Models.User.Data;
  mentionTargetRange: BaseRange;
  selected?: boolean;
}

const MentionSuggestion: React.FC<Props> = ({ currentInput = '', userData, mentionTargetRange, selected }) => {
  const editor = useSlate();
  const displayName = getDisplayNameString(userData);
  const className = selected ? 'mentionSuggestion selected-mention' : 'mentionSuggestion';

  const boldDisplayName = displayName.startsWith('0x') ? '' : displayName.substring(0, currentInput.length);
  const remainingDisplayName = displayName.substring(boldDisplayName.length);
  const onlineStatus = userData.onlineStatus || 'offline';
  const ownerLabel = userData.botOwner?.type === 'user'
    ? `Owned by @${userData.botOwner.username}`
    : userData.botOwner?.type === 'community'
      ? `Owned by ${userData.botOwner.title}`
      : userData.botOwner?.type === 'platform'
        ? 'Platform bot'
        : undefined;

  const onClick = () => {
    // Delay to also allow for focusing on EditField
    setTimeout(() => insertMention(editor, mentionTargetRange, userData), 50);
  }

  return (<div className={className} onClick={onClick}>
      <div title={displayName}>
        <Jdenticon userId={userData.id} onlineStatus={onlineStatus} />
      </div>
      <div className="flex-grow min-w-0">
        <div className='mentionSuggestion-username'>
          <span>@</span>
          <span className='mentionSuggestion-bold'>{boldDisplayName}</span>
          <span>{remainingDisplayName}</span>
          {userData.isBot && <BotBadge />}
        </div>
        {userData.isBot && ownerLabel && <div className='mentionSuggestion-owner'>{ownerLabel}</div>}
      </div>
    </div>)
}

export default React.memo(MentionSuggestion);

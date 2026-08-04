// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useCallContext } from 'context/CallProvider';
import './ReactionOverlay.css';
import React, { useRef } from 'react'
import dayjs from 'dayjs';
import { RECENT_REACTIONS_WINDOW_SECONDS, Reaction } from '../CallPage.reducer';
import _ from 'lodash';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import ReactionPicker from '../ReactionPicker/ReactionPicker';

type Props = {
  showPicker: boolean;
  closePicker: () => void;
};

type ActiveReaction = Reaction & {
  xPos: number;
  sinDuration: number;
  reverseSinDirection: boolean;
};

const ReactionOverlay: React.FC<Props> = ({ showPicker, closePicker }) => {
  const { recentReactions } = useCallContext();
  const { isMobile } = useWindowSizeContext();
  const activeReactionsRef = useRef<ActiveReaction[]>(undefined);

  const activeReactions = activeReactionsRef.current;
  const lastActiveElement = activeReactions?.[activeReactions?.length - 1];
  const lastRecentReaction = recentReactions[recentReactions.length - 1];
  if (lastActiveElement?.peerId !== lastRecentReaction?.peerId || lastActiveElement?.reactionTime !== lastRecentReaction?.reactionTime) {
    let startIndex = 0;
    const now = dayjs();
    // Remove old reactions
    while (
      activeReactions &&
      startIndex < activeReactions.length &&
      dayjs(activeReactions[startIndex].reactionTime).add(RECENT_REACTIONS_WINDOW_SECONDS, 's').isBefore(now)
    ) {
      startIndex++;
    }

    const newActiveReactions = (activeReactions || []).slice(startIndex);
    const newRecentReactions = recentReactions.slice(newActiveReactions.length);

    for (const recReaction of newRecentReactions) {
      newActiveReactions.push({
        ...recReaction,
        xPos: _.random(20, 80, false),
        sinDuration: _.random(2, 5, true),
        reverseSinDirection: Math.random() > 0.5
      });
    }

    activeReactionsRef.current = newActiveReactions;
  }

  return (<>
    <div className='reaction-overlay absolute inset-0 pointer-events-none'>
      {activeReactionsRef.current?.map(reaction => <FloatingReaction
        reaction={reaction}
        key={`${reaction.peerId}-${reaction.reactionTime}`}
      />)}
    </div>
    {!isMobile && <ReactionPicker
      showPicker={showPicker}
      closePicker={closePicker}
    />}
  </>);
}

const FloatingReaction: React.FC<{ reaction: ActiveReaction }> = ({ reaction }) => {
  return <div className='reaction-floating-element' style={{ left: `calc(${reaction.xPos}% - 22px)` }}>
    <div className='reaction-floating-element-grower'>
      <div className='reaction-floating-element-swinger' style={{
        animationDuration: `${reaction.sinDuration}s`,
        animationName: reaction.reverseSinDirection ? 'swingLeft' : 'swingRight'
      }}>
        {reaction.reaction}
      </div>
    </div>
  </div>
};

export default React.memo(ReactionOverlay);
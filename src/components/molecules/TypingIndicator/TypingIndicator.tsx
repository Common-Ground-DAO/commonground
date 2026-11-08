// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useMemo } from 'react';
import { useTypingUsers } from 'hooks/useTypingUsers';
import { useMultipleUserData } from 'context/UserDataProvider';
import { useOwnUser } from 'context/OwnDataProvider';
import { getDisplayNameString } from 'util/index';
import './TypingIndicator.css';

/** "X is typing…" line for a channel, driven by relayed cliTypingEvent. */
export default function TypingIndicator({ channelId }: { channelId: string }) {
  const typingIds = useTypingUsers(channelId);
  const ownUser = useOwnUser();

  const others = useMemo(
    () => typingIds.filter((id) => id !== ownUser?.id),
    [typingIds, ownUser?.id],
  );
  const userData = useMultipleUserData(others);

  const label = useMemo(() => {
    if (others.length === 0) {
      return null;
    }
    const names = others.map((id) => {
      const user = userData?.[id];
      return user ? getDisplayNameString(user) : 'Someone';
    });
    if (names.length === 1) {
      return `${names[0]} is typing…`;
    }
    if (names.length === 2) {
      return `${names[0]} and ${names[1]} are typing…`;
    }
    if (names.length === 3) {
      return `${names[0]}, ${names[1]} and ${names[2]} are typing…`;
    }
    return 'Several people are typing…';
  }, [others, userData]);

  if (!label) {
    return null;
  }

  return (
    <div className="typing-indicator" aria-live="polite">
      <span className="typing-indicator-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="typing-indicator-text">{label}</span>
    </div>
  );
}

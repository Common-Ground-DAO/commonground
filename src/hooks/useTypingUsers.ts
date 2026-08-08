// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useEffect, useState } from 'react';
import typingManager from 'data/appstate/typing';

/** The userIds currently typing in a channel (server-relayed, locally expiring). */
export function useTypingUsers(channelId: string | undefined): string[] {
  const [ids, setIds] = useState<string[]>(() =>
    channelId ? typingManager.getTypingUserIds(channelId) : []
  );
  useEffect(() => {
    if (!channelId) {
      setIds([]);
      return;
    }
    return typingManager.subscribe(channelId, setIds);
  }, [channelId]);
  return ids;
}

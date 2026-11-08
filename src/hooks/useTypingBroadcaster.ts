// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useCallback, useEffect, useMemo, useRef } from 'react';
import connectionManager from 'data/appstate/connection';
import channelDatabaseManager from 'data/databases/channel';

// Refresh `isTyping:true` no more than once per window while composing (the
// server also collapses bursts); stop after a short idle so receivers, which
// apply their own ~7s expiry, clear promptly.
const REFRESH_THROTTLE_MS = 3_000;
const IDLE_STOP_MS = 6_000;

/**
 * Broadcasts ephemeral typing presence for a channel. Call `notify(hasText)`
 * on every composer change (true while there is text, false when emptied), and
 * `stop()` on send / blur. Automatically stops on channel switch and unmount.
 */
export function useTypingBroadcaster(channelId: string) {
  const stateRef = useRef<{ typing: boolean; lastTrue: number; idle?: ReturnType<typeof setTimeout> }>({
    typing: false,
    lastTrue: 0,
  });

  const stop = useCallback(() => {
    const state = stateRef.current;
    if (state.idle) {
      clearTimeout(state.idle);
      state.idle = undefined;
    }
    if (state.typing) {
      state.typing = false;
      state.lastTrue = 0;
      const access = channelDatabaseManager.getAccessForChannel(channelId);
      if (access) {
        connectionManager.sendTyping(access, false);
      }
    }
  }, [channelId]);

  const notify = useCallback((hasText: boolean) => {
    if (!hasText) {
      stop();
      return;
    }
    const access = channelDatabaseManager.getAccessForChannel(channelId);
    if (!access) {
      return;
    }
    const state = stateRef.current;
    const now = Date.now();
    if (now - state.lastTrue > REFRESH_THROTTLE_MS) {
      connectionManager.sendTyping(access, true);
      state.lastTrue = now;
    }
    state.typing = true;
    if (state.idle) {
      clearTimeout(state.idle);
    }
    state.idle = setTimeout(stop, IDLE_STOP_MS);
  }, [channelId, stop]);

  // Stop typing on channel switch / unmount (cleanup captures the old channel).
  useEffect(() => stop, [channelId, stop]);

  return useMemo(() => ({ notify, stop }), [notify, stop]);
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * COMPAT — remove one release after chat-sync (together with its call in
 * src/service-worker.ts and the Legacy* types in
 * src/data/appstate/transport.ts). Deploy compatibility with old open tabs.
 *
 * Pages from before chat-sync ask the service worker for a tab role on the
 * LEGACY_WEBSOCKET_STATE_CHANNEL BroadcastChannel and stay disconnected until
 * they get one. The worker no longer assigns roles; for one release it answers
 * every role request (`tabState: 'unknown'`) of such a page with "active", so an
 * old page that is still open after the update (e.g. it did not reload on the
 * worker's `reload` message) connects. Every other message on that channel
 * (heartbeats, 'tabClosed', role claims) is ignored. Several old pages answered
 * this way resolve their collisions among themselves (visible tab wins).
 * New pages never use the channel.
 *
 * Kept in its own module, free of worker globals, so it can be unit-tested.
 */

import {
  LEGACY_WEBSOCKET_STATE_CHANNEL,
  type LegacyCompatAnswer,
  type LegacyTabToWorkerMessage,
} from 'data/appstate/transport';

/** The answer to `data`, or null when `data` gets none. */
export function legacyTabCompatAnswer(data: unknown): LegacyCompatAnswer | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const message = data as Partial<LegacyTabToWorkerMessage>;
  if (
    message.type !== 'TabToWorker' ||
    message.tabState !== 'unknown' ||
    typeof message.tabId !== 'string' ||
    message.tabId.length === 0
  ) {
    return null;
  }
  return {
    type: 'WorkerToTab',
    tabId: message.tabId,
    tabState: 'active',
  };
}

/**
 * Listens on the legacy channel and posts the compat answer. `shouldAnswer`
 * is checked per message: the worker passes "this worker is the active one",
 * so a worker that is installed but still waiting does not answer next to the
 * active worker of the old build. Returns a function that closes the channel.
 */
export function installLegacyTabCompat(options: {
  shouldAnswer?: () => boolean;
  channel?: BroadcastChannel;
} = {}): () => void {
  const channel = options.channel ?? new BroadcastChannel(LEGACY_WEBSOCKET_STATE_CHANNEL);
  const shouldAnswer = options.shouldAnswer ?? (() => true);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const answer = legacyTabCompatAnswer(event.data);
    if (answer !== null && shouldAnswer()) {
      channel.postMessage(answer);
    }
  };
  return () => {
    channel.onmessage = null;
    channel.close();
  };
}

/** The parts of ServiceWorkerGlobalScope that createActiveWorkerCheck reads. */
export type WorkerScopeLike = {
  serviceWorker?: { readonly state: string };
  registration: {
    readonly active: object | null;
    readonly waiting: object | null;
    readonly installing: object | null;
  };
};

/**
 * "Is this worker the active one?" for `shouldAnswer`. Create it at the
 * worker's startup (top-level script evaluation) and call `markActivated()`
 * at the end of the `activate` handler.
 *
 * With `self.serviceWorker` (the worker's own ServiceWorker object) the
 * state decides. Without it, the worker answers once its `activate` handler
 * ran, or if it started up already active: a worker the browser restarted
 * after terminating it for idleness sees an active registration with nothing
 * installing or waiting, while a new worker's first start always has itself
 * in `installing`. (An active worker restarted while a newer one waits stays
 * silent until it would be replaced anyway.)
 */
export function createActiveWorkerCheck(scope: WorkerScopeLike): {
  isActive: () => boolean;
  markActivated: () => void;
} {
  const { registration } = scope;
  const startedActive =
    registration.active !== null &&
    registration.waiting === null &&
    registration.installing === null;
  let activated = false;
  return {
    isActive: () => scope.serviceWorker !== undefined
      ? scope.serviceWorker.state === 'activated'
      : activated || startedActive,
    markActivated: () => {
      activated = true;
    },
  };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

export type IndicatorState = "hidden" | "offline" | "updated" | "updating" | "connecting" | "connected" | "disconnected";

export type IndicatorInput = {
  webSocketState: Common.WebSocketState;
  serviceWorkerState: Common.ServiceWorkerState;
  onlineState: Common.OnlineState;
  /** the first seconds after a (re)load (INITIAL_CONNECT_GRACE) */
  initialGrace: boolean;
  /** the tab was live at least once in this page */
  everConnected: boolean;
  /** the account must finish the security step: its socket never goes live, which is no outage */
  securityStepRequired: boolean;
};

/**
 * What the connection indicator shows, by priority: offline > service-worker
 * update ready > updating > live ("connected") > connecting > disconnected.
 * `webSocketState` is `connected` only while the tab is live; a newer build
 * on the server no longer freezes it (the service-worker update flow shows
 * the update).
 */
export function indicatorStateFor(input: IndicatorInput): IndicatorState {
  const { webSocketState, serviceWorkerState, onlineState, initialGrace, everConnected, securityStepRequired } = input;
  if (onlineState === "offline") return "offline";
  if (serviceWorkerState === "updated") return "updated";
  if (serviceWorkerState === "updating") return "updating";
  if (webSocketState === "connected") return "connected";
  if (securityStepRequired) return "hidden";
  if (webSocketState === "connecting") return "connecting";
  // "disconnected"
  if (initialGrace && !everConnected) {
    // the first connection is still being set up
    return "hidden";
  }
  return "disconnected";
}

/** States that are shown only after DELAY_BEFORE_SHOW, and only while the page is visible. */
export function isDelayedState(state: IndicatorState): boolean {
  return state === "connecting" || state === "disconnected";
}

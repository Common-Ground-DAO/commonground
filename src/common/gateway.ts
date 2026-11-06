// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { getInstanceConfig } from "./instance";

/**
 * This web app runs on a gateway (docs/auth-identity §12): the instance config
 * names the instance it moved to. The app then signs in and hands over with a
 * transfer link, nothing else — no data socket, no local data setup.
 */
export function isGatewayInstance(): boolean {
  return !!getInstanceConfig()?.gatewayTargetUrl;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import config from "common/config";
import urlConfig from "data/util/urls";
import { getAuthMode } from "./authMode";

/**
 * Plugin content must never come from this instance's host or one of its
 * subdomains (nor from the passkey RP ID's): a page there could run WebAuthn
 * ceremonies for the instance's relying party. The server refuses such plugin
 * URLs (srv/validators/api/plugin.ts); the iframe host refuses to render
 * them, too, for plugins created before that check. Like the server, not
 * enforced in dev, where plugins are served from another localhost port.
 */

function isSameOrSubdomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const d = domain.toLowerCase().replace(/\.$/, "");
  return !!d && (h === d || h.endsWith(`.${d}`));
}

export function isForbiddenPluginUrl(url: string, forbiddenDomains: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  }
  catch {
    // not an absolute URL: it would resolve against this origin
    return true;
  }
  return forbiddenDomains.some(domain => isSameOrSubdomain(host, domain));
}

export function forbiddenPluginDomains(): string[] {
  const domains = new Set<string>();
  try {
    domains.add(new URL(urlConfig.APP_URL).hostname);
  }
  catch {
    // malformed APP_URL: the page host below still applies
  }
  const pageHost = (globalThis as any)?.location?.hostname;
  if (typeof pageHost === "string" && pageHost) {
    domains.add(pageHost);
  }
  const { passkeyRpId } = getAuthMode();
  if (passkeyRpId) {
    domains.add(passkeyRpId);
  }
  return Array.from(domains);
}

export function isPluginUrlAllowed(url: string): boolean {
  if (config.DEPLOYMENT === "dev") {
    return true;
  }
  return !isForbiddenPluginUrl(url, forbiddenPluginDomains());
}

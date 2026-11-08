// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import config from "../common/config";
import urls from "./urls";

/**
 * WebAuthn relying-party configuration (docs/auth-identity §7).
 *
 * - `mainRp`: passkeys on the instance's own origin. RP ID = `PASSKEY_RP_ID`
 *   or the host of `BASE_URL`; the only accepted origin is exactly the
 *   `BASE_URL` origin (dev adds the local Vite/backend origins). The RP ID is
 *   permanent: every credential is bound to it, so changing it later strands
 *   all registered passkeys.
 * - `legacyCgidRp`: the old CG ID app (`CGID_URL`) — only on a process that
 *   runs with `CG_LEGACY_CGID=true`, where it is the ONLY relying party and
 *   authentication-only.
 *
 * Each process accepts credentials of exactly one RP ID; rows of another RP ID
 * (or with a NULL rpId) are invisible to it.
 */

export type RpConfig = {
  rpId: string;
  rpName: string;
  origins: string[];
};

export const RP_NAME = "Common Ground";

const DEV_EXTRA_ORIGINS = ["http://localhost:3000", "http://localhost:8000"];

export function isLegacyCgidMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CG_LEGACY_CGID === "true";
}

const HOSTNAME_REGEX = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** true when `host` equals `domain` or is a subdomain of it */
export function isSameOrSubdomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const d = domain.toLowerCase().replace(/\.$/, "");
  return h === d || h.endsWith(`.${d}`);
}

/**
 * Pure builder for the main relying party; throws a descriptive Error when the
 * configuration cannot work (RP ID not equal to or a parent domain of the app
 * host, malformed values).
 */
export function buildMainRp(options: {
  baseUrl: string;
  appHostname: string;
  deployment: string;
  passkeyRpId?: string;
}): RpConfig {
  const appHostname = options.appHostname.toLowerCase();
  const rpId = (options.passkeyRpId?.trim() || appHostname).toLowerCase();
  if (!HOSTNAME_REGEX.test(rpId)) {
    throw new Error(`PASSKEY_RP_ID "${rpId}" is not a valid host name`);
  }
  if (!isSameOrSubdomain(appHostname, rpId)) {
    throw new Error(`PASSKEY_RP_ID "${rpId}" must equal the BASE_URL host "${appHostname}" or be a parent domain of it`);
  }
  if (!rpId.includes(".") && rpId !== "localhost" && options.deployment !== "dev") {
    throw new Error(`PASSKEY_RP_ID "${rpId}" must be a registrable domain, not a single label`);
  }
  const origins = [new URL(options.baseUrl).origin];
  if (options.deployment === "dev") {
    for (const origin of DEV_EXTRA_ORIGINS) {
      if (!origins.includes(origin)) origins.push(origin);
    }
  }
  return { rpId, rpName: RP_NAME, origins };
}

/** Pure builder for the legacy CG ID relying party (gateway mode only). */
export function buildLegacyCgidRp(options: {
  cgidUrl: string | undefined;
  deployment: string;
}): RpConfig {
  if (!options.cgidUrl) {
    throw new Error("CG_LEGACY_CGID=true requires CGID_URL");
  }
  const url = new URL(options.cgidUrl);
  const origins = [url.origin];
  if (options.deployment === "dev") {
    for (const origin of DEV_EXTRA_ORIGINS) {
      if (!origins.includes(origin)) origins.push(origin);
    }
  }
  return { rpId: url.hostname.toLowerCase(), rpName: RP_NAME, origins };
}

let cachedMainRp: RpConfig | undefined;
let cachedLegacyRp: RpConfig | undefined;

export function getMainRp(): RpConfig {
  if (!cachedMainRp) {
    cachedMainRp = buildMainRp({
      baseUrl: urls.APP_URL,
      appHostname: urls.APP_HOSTNAME,
      deployment: config.DEPLOYMENT,
      passkeyRpId: process.env.PASSKEY_RP_ID,
    });
  }
  return cachedMainRp;
}

export function getLegacyCgidRp(): RpConfig {
  if (!cachedLegacyRp) {
    cachedLegacyRp = buildLegacyCgidRp({
      cgidUrl: process.env.CGID_URL,
      deployment: config.DEPLOYMENT,
    });
  }
  return cachedLegacyRp;
}

/** The one relying party this process serves. */
export function getProcessRp(): RpConfig {
  return isLegacyCgidMode() ? getLegacyCgidRp() : getMainRp();
}

/**
 * RP ID of this process, or null when the configuration is invalid — for
 * read paths in processes that never validated it at startup (jobs etc.);
 * a null RP ID matches no credential.
 */
export function getProcessRpIdOrNull(): string | null {
  try {
    return getProcessRp().rpId;
  }
  catch {
    return null;
  }
}

/**
 * Startup check for the api process: resolves the relying party once so a
 * misconfiguration stops the process with a clear message instead of failing
 * every ceremony later.
 */
export function validatePasskeyConfigAtStartup(): RpConfig {
  const rp = getProcessRp();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rp.rpId) || rp.rpId.includes(":")) {
    console.warn(`Passkeys: RP ID "${rp.rpId}" is an IP address — browsers refuse WebAuthn there; use a domain name`);
  }
  console.log(`Passkeys: ${isLegacyCgidMode() ? "legacy CG ID" : "main-origin"} relying party "${rp.rpId}", origins ${rp.origins.join(", ")}`);
  return rp;
}

/** test hook */
export function _resetPasskeyConfigCache() {
  cachedMainRp = undefined;
  cachedLegacyRp = undefined;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { createHash, randomBytes } from "node:crypto";
import config from "../common/config";
import { safeNextPath } from "../common/safeNextPath";

/**
 * Transfer links (docs/auth-identity §11): a one-time link that signs the
 * holder in on another instance sharing this database — during the move, the
 * app.cg gateway mints links to cg.box for its logged-in users.
 *
 * - The token is 32 random bytes (base64url, 43 characters). Only its SHA-256
 *   hash is stored (transfer_tokens), with the user id, a same-site path to
 *   continue to, and an expiry TRANSFER_LINK_TTL_MS ahead.
 * - It travels in the URL fragment (`<target>/transfer#<token>`), which
 *   browsers never send to a server — not in requests, logs or `Referer`.
 * - The target instance's web app reads and removes the fragment, shows whose
 *   account the link belongs to, and redeems it with a POST
 *   (User/redeemTransferLink) after an explicit confirmation. Redemption
 *   marks the row used in one statement, so a token signs in at most once.
 *
 * Minting (User/createTransferLink) is on only where TRANSFER_TARGET_URL
 * names the instance the links lead to.
 */

export const TRANSFER_LINK_TTL_MS = 10 * 60 * 1000;
export const TRANSFER_PATH = "/transfer";

export function newTransferToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashTransferToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * The origin transfer links lead to (TRANSFER_TARGET_URL, e.g.
 * `https://cg.box`), or null when this instance does not mint links. Throws
 * on a malformed value (an `https` origin outside dev).
 */
export function getTransferTargetOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.TRANSFER_TARGET_URL?.trim();
  if (!value) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  }
  catch {
    throw new Error(`TRANSFER_TARGET_URL is not a URL: ${value}`);
  }
  const httpsOnly = config.DEPLOYMENT !== "dev";
  if (url.protocol !== "https:" && (httpsOnly || url.protocol !== "http:")) {
    throw new Error(`TRANSFER_TARGET_URL must be an https URL: ${value}`);
  }
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error(`TRANSFER_TARGET_URL must be an origin without a path: ${value}`);
  }
  return url.origin;
}

/** api startup: a misconfigured target stops the process instead of minting broken links */
export function validateTransferConfigAtStartup(): void {
  getTransferTargetOrigin();
}

export function transferLinkUrl(targetOrigin: string, token: string): string {
  return `${targetOrigin}${TRANSFER_PATH}#${token}`;
}

/** a same-site path on the target, or null (safeNextPath, shared with the web app) */
export function transferNextPath(nextPath: string | undefined | null, targetOrigin: string): string | null {
  const path = safeNextPath(nextPath, targetOrigin);
  if (!path || path === "/" || path === TRANSFER_PATH || path.startsWith(`${TRANSFER_PATH}?`) || path.startsWith(`${TRANSFER_PATH}#`) || path.startsWith(`${TRANSFER_PATH}/`)) {
    return null;
  }
  return path.length <= 2048 ? path : null;
}

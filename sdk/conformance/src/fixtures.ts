/**
 * Shared fixtures for conformance runs.
 *
 * Mutation-heavy suites (registration, messaging) default to running only
 * against a disposable instance (loopback HTTP, see tools/
 * disposable-instance.sh) so a shared live instance isn't polluted or
 * rate-limited to death. Set CG_LIVE_MUTATIONS=1 to run them elsewhere.
 *
 * Rate limits (srv/util/rateLimit.ts) key on the FIRST X-Forwarded-For
 * entry, and the selfhost nginx *appends* the peer address to a
 * client-supplied XFF — so against the disposable instance each fixture
 * client claims a unique address and registration limits (2/24h per /64,
 * srv/api/user.ts createUserRateLimiter) never collide across runs. This
 * only works because there is no sanitizing edge (caddy) in front; the
 * behavior itself is recorded in the findings log.
 */

import { randomBytes, randomInt } from "node:crypto";
import { CommonGroundClient } from "@commonground/client";
import { BASE_URL, FIXTURE_PREFIX } from "./env.js";

export const IS_DISPOSABLE =
  /^http:\/\/(127\.|localhost)/.test(BASE_URL) || process.env.CG_DISPOSABLE === "1";

/** Whether tests that create accounts/content should run at all. */
export const MUTATIONS_ENABLED = IS_DISPOSABLE || process.env.CG_LIVE_MUTATIONS === "1";

/** A unique public-looking IPv4 for rate-limit isolation per client. */
export function uniqueTestIp(): string {
  return `203.${randomInt(1, 254)}.${randomInt(1, 254)}.${randomInt(1, 254)}`;
}

/** Fresh client with its own cookie jar (and, when disposable, its own IP). */
export function newClient(): CommonGroundClient {
  return new CommonGroundClient({
    baseUrl: BASE_URL,
    headers: IS_DISPOSABLE ? { "x-forwarded-for": uniqueTestIp() } : {},
  });
}

export function uniqueName(tag: string): string {
  // cg displayName: /^[a-z0-9_-]{3,30}$/i. The random suffix must survive the
  // 30-char cap (else long tags collide), so truncate the TAG, not the tail.
  const suffix = `-${randomBytes(3).toString("hex")}`; // 7 chars
  const room = 30 - FIXTURE_PREFIX.length - suffix.length;
  return `${FIXTURE_PREFIX}${tag.slice(0, Math.max(1, room))}${suffix}`;
}

export function uniqueEmail(tag: string): string {
  return `${uniqueName(tag)}@example.org`;
}

export const TEST_PASSWORD = "Conformance-1!aB";

/** Register a throwaway user; callers own cleanup expectations (fixtures are
 * marked by prefix so operators can purge them). */
export async function registerUser(tag: string, curve: "P-256" | "P-384" = "P-384") {
  const client = newClient();
  const session = await client.auth.register({
    email: uniqueEmail(tag),
    password: TEST_PASSWORD,
    displayName: uniqueName(tag),
    curve,
  });
  return { client, session };
}

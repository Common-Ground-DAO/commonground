// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Whether an optional third-party key (SendGrid, Twitter, ...) holds a real
 * value. Empty, the `placeholder` fallback of srv/serverconfig.ts and the
 * `your-key` placeholder of docker/.env.example all mean "not configured", so
 * the feature is skipped (backend) or hidden (instance config) instead of
 * failing against the provider.
 */
export function isConfiguredSecret(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  return !!trimmed && trimmed !== "placeholder" && trimmed !== "your-key";
}

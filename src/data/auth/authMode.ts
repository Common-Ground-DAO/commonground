// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { getInstanceConfig, type InstanceConfig } from "common/instance";

/**
 * How this instance does passkeys (docs/auth-identity §7).
 *
 * - Main-origin passkeys (the default): ceremonies run on this origin against
 *   the `Passkey` API, bound to `passkeyRpId`.
 * - Legacy CG ID (gateway only): passkeys live on the separate CG ID app
 *   (`cgidUrl`) and are used through its popup. The instance config says so
 *   by carrying `cgidUrl`; without an instance config, the official app.cg
 *   hosts are the legacy gateway.
 * - `features.passkeys: false` on any other instance means passkeys are
 *   unavailable there (no RP ID could be derived) — never legacy.
 */
export type AuthMode = {
  legacyCgid: boolean;
  passkeysOnOrigin: boolean;
  /** RP ID the instance declared; null = let the server's options decide */
  passkeyRpId: string | null;
};

const LEGACY_HOSTS = new Set(["app.cg", "id.app.cg", "staging.app.cg", "id.staging.app.cg"]);

export function computeAuthMode(instance: InstanceConfig | undefined, hostname: string | undefined): AuthMode {
  if (instance) {
    const legacyCgid = !!instance.cgidUrl;
    return {
      legacyCgid,
      passkeysOnOrigin: !legacyCgid && instance.features?.passkeys !== false,
      passkeyRpId: legacyCgid ? null : instance.passkeyRpId ?? null,
    };
  }
  const legacyCgid = !!hostname && LEGACY_HOSTS.has(hostname.toLowerCase());
  return {
    legacyCgid,
    passkeysOnOrigin: !legacyCgid,
    passkeyRpId: null,
  };
}

let cached: AuthMode | undefined;

export function getAuthMode(): AuthMode {
  if (!cached) {
    let hostname: string | undefined;
    try {
      hostname = (globalThis as any)?.location?.hostname;
    }
    catch {
      hostname = undefined;
    }
    cached = computeAuthMode(getInstanceConfig(), hostname);
  }
  return cached;
}

/** RP ID for browser signals: the declared one, else this page's host. */
export function getSignalRpId(): string | null {
  const { passkeyRpId } = getAuthMode();
  if (passkeyRpId) {
    return passkeyRpId;
  }
  try {
    return (globalThis as any)?.location?.hostname || null;
  }
  catch {
    return null;
  }
}

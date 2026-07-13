// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

// Runtime instance configuration for self-hosted deployments.
//
// Historically the app derived its deployment mode and URLs from a hardcoded
// list of domains (app.cg, staging.app.cg) — any other domain silently ran
// with dev semantics. Self-hosted instances instead declare who they are at
// serve time: the server injects
//
//   <script>window.__CG_INSTANCE__ = {...}</script>
//
// into index.html / index_cgid.html (see srv/util/instanceConfig.ts and
// docker/nginx/inject-instance-config.sh). This module is the single, safe
// accessor for that global. When the global is absent, callers fall back to
// the legacy domain-based detection, so app.cg and local dev are unaffected.

export type InstanceConfig = {
  /** Semantic mode of the instance (feature flags, chains, captcha). */
  deployment?: 'prod' | 'staging' | 'dev';
  /** Public base URL of the instance, no trailing slash (e.g. https://chat.example.org). */
  appUrl?: string;
  /** Base URL of the CG ID app, including the hash router prefix (e.g. https://id.chat.example.org/#). */
  cgidUrl?: string;
  /** reCAPTCHA v2 site key for this instance; empty disables the default key. */
  recaptchaSiteKey?: string;
  /** Chains this instance supports (working RPC endpoints); keys of AVAILABLE_CHAINS. */
  activeChains?: string[];
  /** Capability flags derived from which secrets the server has configured. Absent flag = feature available (official instances). */
  features?: {
    email?: boolean;
    twitterAuth?: boolean;
    kyc?: boolean;
  };
  /** Giphy API key for this instance; empty disables the GIF picker. */
  giphyApiKey?: string;
  /** WalletConnect Cloud project id for this instance (origin-allowlisted upstream). */
  walletConnectProjectId?: string;
};

let cached: InstanceConfig | undefined;
let resolved = false;

export function getInstanceConfig(): InstanceConfig | undefined {
  if (resolved) {
    return cached;
  }
  resolved = true;
  const raw = (globalThis as any)?.__CG_INSTANCE__;
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const cfg: InstanceConfig = {};
  if (raw.deployment === 'prod' || raw.deployment === 'staging' || raw.deployment === 'dev') {
    cfg.deployment = raw.deployment;
  }
  if (typeof raw.appUrl === 'string' && /^https?:\/\/[^/]+/i.test(raw.appUrl)) {
    cfg.appUrl = raw.appUrl.replace(/\/+$/, '');
  }
  if (typeof raw.cgidUrl === 'string' && /^https?:\/\/[^/]+/i.test(raw.cgidUrl)) {
    cfg.cgidUrl = raw.cgidUrl;
  }
  if (typeof raw.recaptchaSiteKey === 'string') {
    cfg.recaptchaSiteKey = raw.recaptchaSiteKey;
  }
  if (Array.isArray(raw.activeChains)) {
    const chains = raw.activeChains.filter((c: unknown) => typeof c === 'string' && /^[a-z0-9_]+$/.test(c));
    if (chains.length > 0) {
      cfg.activeChains = chains;
    }
  }
  if (raw.features && typeof raw.features === 'object') {
    cfg.features = {};
    for (const key of ['email', 'twitterAuth', 'kyc'] as const) {
      if (typeof raw.features[key] === 'boolean') {
        cfg.features[key] = raw.features[key];
      }
    }
  }
  if (typeof raw.giphyApiKey === 'string') {
    cfg.giphyApiKey = raw.giphyApiKey;
  }
  if (typeof raw.walletConnectProjectId === 'string' && /^[a-z0-9]*$/i.test(raw.walletConnectProjectId)) {
    cfg.walletConnectProjectId = raw.walletConnectProjectId;
  }
  cached = cfg;
  return cached;
}

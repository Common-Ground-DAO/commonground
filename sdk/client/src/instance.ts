/**
 * Instance identity & capabilities.
 *
 * Contract: `GET /api/v2/Instance/config` (srv/api/instance.ts) returns the
 * same object the web app receives as `window.__CG_INSTANCE__` — the type is
 * `InstanceConfig` in src/common/instance.ts. Mirrored here (the SDK ships
 * standalone); the conformance suite asserts the mirror matches the live
 * shape, so drift is a test failure, not silent skew.
 */

import type { HttpTransport } from "./transport/http.js";

export type CaptchaProvider = "altcha" | "recaptcha" | "off";

export type InstanceConfig = {
  /** Semantic mode of the instance (feature flags, chains, captcha). */
  deployment?: "prod" | "staging" | "dev";
  /** Public base URL of the instance, no trailing slash. */
  appUrl?: string;
  /** Base URL of the CG ID app, including the hash router prefix. */
  cgidUrl?: string;
  /** reCAPTCHA v2 site key; empty disables the default key. */
  recaptchaSiteKey?: string;
  /** Captcha provider this instance verifies against. */
  captchaProvider?: CaptchaProvider;
  /** Chains this instance supports (keys of AVAILABLE_CHAINS). */
  activeChains?: string[];
  /** Capability flags. Absent flag = feature available (official instances). */
  features?: {
    email?: boolean;
    twitterAuth?: boolean;
    /** false when the instance runs without the mediasoup (calls) service. */
    calls?: boolean;
    /** false when the instance disables the server-side NSFW image filter. */
    imageFilter?: boolean;
  };
  /** Giphy API key; empty disables the GIF picker. */
  giphyApiKey?: string;
  /** WalletConnect Cloud project id. */
  walletConnectProjectId?: string;
};

export async function fetchInstanceConfig(transport: HttpTransport): Promise<InstanceConfig> {
  return transport.getJson<InstanceConfig>("Instance/config");
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import config from "../common/config";
import type { InstanceConfig } from "../common/instance";
import urls from "./urls";
import { dockerSecret } from ".";
import { CAPTCHA_PROVIDER } from "./captcha";
import { isConfiguredSecret } from "./configuredSecret";
import { parseMailConfig } from "./mailConfig";
import { getProcessRpIdOrNull, isLegacyCgidMode } from "./passkeyConfig";
import { isGatewayMode } from "./gateway";
import { getTransferTargetOrigin } from "./transferLink";

// Builds this instance's identity for the frontend (window.__CG_INSTANCE__)
// and for GET /api/v2/Instance/config. The web app normally gets it from
// /instance-config.js, which the Caddy edge renders from the same settings
// (docker/caddy/instance-config.js — keep the rules in sync); the inline
// <script> tag below is only the fallback for an HTML shell that does not
// load that script (srv/api/getRoutes.ts). See src/common/instance.ts for how
// the frontend consumes it.

export function buildInstanceConfig(): InstanceConfig {
  const legacyCgid = isLegacyCgidMode();
  const instance: InstanceConfig = {
    deployment: config.DEPLOYMENT,
    appUrl: urls.APP_URL,
  };
  if (legacyCgid) {
    // legacy CG ID (gateway) mode: passkeys live on the CG ID app
    let cgidUrl = process.env.CGID_URL || `${urls.APP_URL}/index_cgid.html`;
    if (!cgidUrl.includes("#")) {
      cgidUrl = `${cgidUrl.replace(/\/+$/, "")}/#`;
    }
    instance.cgidUrl = cgidUrl;
  }
  else {
    // passkeys on this origin (Passkey API); the RP ID is what credentials
    // registered here are bound to
    const rpId = getProcessRpIdOrNull();
    if (rpId) {
      instance.passkeyRpId = rpId;
    }
  }
  if (isGatewayMode()) {
    // a gateway (srv/util/gateway.ts): the web app shows only sign-in and
    // the move to this instance
    const target = getTransferTargetOrigin();
    if (target) {
      instance.gatewayTargetUrl = target;
    }
  }
  if (typeof process.env.CG_RECAPTCHA_SITE_KEY === "string") {
    instance.recaptchaSiteKey = process.env.CG_RECAPTCHA_SITE_KEY;
  }
  // Tell the frontend which captcha provider this server actually verifies
  // against, so it renders the matching widget (and fails closed with ALTCHA
  // instead of silently skipping captcha).
  instance.captchaProvider = CAPTCHA_PROVIDER;
  // config.ACTIVE_CHAINS already resolves CG_ACTIVE_CHAINS on the backend;
  // forward the resolved list so the frontend agrees with the server
  if (process.env.CG_ACTIVE_CHAINS) {
    instance.activeChains = config.ACTIVE_CHAINS as unknown as string[];
  }
  // capability flags: derived from which secrets this server actually has,
  // so the frontend can hide features that would only fail
  const configured = isConfiguredSecret;
  instance.features = {
    // opt-out: only an explicit "false" (no mediasoup service deployed) hides
    // the call UI, so instances that never set the variable keep calls
    calls: process.env.CG_ENABLE_CALLS !== "false",
    // the switch the filter itself runs on (srv/moderation/imageFilter.ts)
    imageFilter: config.IMAGE_MODERATION_ENABLED,
    // same rule as emailEnabled() in srv/api/emails.ts
    email: parseMailConfig(process.env, urls.APP_HOSTNAME).enabled,
    // main-origin passkeys (Passkey API); false on a legacy CG ID process
    passkeys: !legacyCgid && getProcessRpIdOrNull() !== null,
    twitterAuth:
      configured(dockerSecret("twitter_api_v1_key") || process.env.TWITTER_API_KEY) &&
      configured(dockerSecret("twitter_api_v1_secret") || process.env.TWITTER_API_SECRET),
  };
  // so the browser pre-check warns at the confidence this server rejects at,
  // instead of at a hardcoded one that ignores IMAGE_MODERATION_THRESHOLD
  instance.imageFilterThreshold = config.IMAGE_MODERATION_THRESHOLD;
  if (typeof process.env.CG_GIPHY_API_KEY === "string") {
    instance.giphyApiKey = process.env.CG_GIPHY_API_KEY;
  }
  if (process.env.CG_WALLETCONNECT_PROJECT_ID) {
    instance.walletConnectProjectId = process.env.CG_WALLETCONNECT_PROJECT_ID;
  }
  return instance;
}

export function instanceConfigScriptTag(): string {
  // <-escape to keep the JSON safe inside a <script> element
  const json = JSON.stringify(buildInstanceConfig()).replace(/</g, "\\u003c");
  return `<script>window.__CG_INSTANCE__ = ${json};</script>`;
}

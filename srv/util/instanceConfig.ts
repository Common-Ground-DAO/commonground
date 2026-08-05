// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import config from "../common/config";
import type { InstanceConfig } from "../common/instance";
import urls from "./urls";
import { dockerSecret } from ".";
import { CAPTCHA_PROVIDER } from "./captcha";

// Builds the <script> tag that declares this instance's identity to the
// frontend (window.__CG_INSTANCE__). Injected into every index.html the
// backend serves (share links / social previews); the nginx image performs
// the same injection for statically served copies
// (docker/nginx/inject-instance-config.sh). See src/common/instance.ts for
// how the frontend consumes it.

function buildInstanceConfig(): InstanceConfig {
  let cgidUrl = process.env.CGID_URL || `${urls.APP_URL}/index_cgid.html`;
  if (!cgidUrl.includes("#")) {
    cgidUrl = `${cgidUrl.replace(/\/+$/, "")}/#`;
  }
  const instance: InstanceConfig = {
    deployment: config.DEPLOYMENT,
    appUrl: urls.APP_URL,
    cgidUrl,
  };
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
  const configured = (v: string | undefined) => !!v && v !== "placeholder" && v !== "your-key";
  instance.features = {
    // opt-out: only an explicit "false" (no mediasoup service deployed) hides
    // the call UI, so instances that never set the variable keep calls
    calls: process.env.CG_ENABLE_CALLS !== "false",
    // the switch the filter itself runs on (srv/moderation/imageFilter.ts)
    imageFilter: config.IMAGE_MODERATION_ENABLED,
    email: configured(dockerSecret("sendgrid_api") || process.env.SENDGRID_API_KEY),
    twitterAuth:
      configured(dockerSecret("twitter_api_v1_key") || process.env.TWITTER_API_KEY) &&
      configured(dockerSecret("twitter_api_v1_secret") || process.env.TWITTER_API_SECRET),
  };
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

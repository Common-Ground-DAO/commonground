// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import config from "../common/config";
import type { InstanceConfig } from "../common/instance";
import urls from "./urls";

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
  // config.ACTIVE_CHAINS already resolves CG_ACTIVE_CHAINS on the backend;
  // forward the resolved list so the frontend agrees with the server
  if (process.env.CG_ACTIVE_CHAINS) {
    instance.activeChains = config.ACTIVE_CHAINS as unknown as string[];
  }
  return instance;
}

export function instanceConfigScriptTag(): string {
  // <-escape to keep the JSON safe inside a <script> element
  const json = JSON.stringify(buildInstanceConfig()).replace(/</g, "\\u003c");
  return `<script>window.__CG_INSTANCE__ = ${json};</script>`;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { getInstanceConfig } from "../../common/instance";

let APP_URL = "http://localhost:8000";
let API_BASE_URL = "http://localhost:8000";
let API_URL = "http://localhost:8000/api/v2"
let WS_URL = "ws://localhost:8000";
let CGID_URL = "http://localhost:8000/index_cgid.html/#";
let I_AM_CGID = false;

const href = window?.location?.href;
const instance = getInstanceConfig();

if (instance?.appUrl) {
  // self-hosted instance: URLs are declared at serve time, not derived from
  // a hardcoded domain list
  APP_URL = instance.appUrl;
  API_BASE_URL = APP_URL;
  API_URL = `${APP_URL}/api/v2/`;
  WS_URL = APP_URL.replace(/^http/i, "ws");
  CGID_URL = instance.cgidUrl || `${APP_URL}/index_cgid.html/#`;
  if (href) {
    try {
      const appOrigin = new URL(APP_URL).origin;
      const cgidOrigin = new URL(CGID_URL).origin;
      const myOrigin = new URL(href).origin;
      I_AM_CGID =
        (cgidOrigin !== appOrigin && myOrigin === cgidOrigin) ||
        href.startsWith(`${APP_URL}/index_cgid.html`);
    } catch (e) {
      I_AM_CGID = href.startsWith(`${APP_URL}/index_cgid.html`);
    }
  }
}
else if (href) {
  const re = /^(https?):\/\/([^/:]+)(:(3000|8000|8001))?/i;
  const m = href.match(re);
  if (m) {
    let protocol = m[1] as "http"|"https";
    let domain = m[2];
    let port = m[3] || "";

    if (domain === "app.cg" || domain === "id.app.cg") {
      if (domain === "id.app.cg") {
        I_AM_CGID = true;
      }
      APP_URL = "https://app.cg";
      API_BASE_URL = APP_URL;
      API_URL = `${APP_URL}/api/v2/`;
      WS_URL = "wss://app.cg";
      CGID_URL = "https://id.app.cg/#";
    }
    else if (domain === "staging.app.cg" || domain === "id.staging.app.cg") {
      if (domain === "id.staging.app.cg") {
        I_AM_CGID = true;
      }
      APP_URL = "https://staging.app.cg";
      API_BASE_URL = APP_URL;
      API_URL = `${APP_URL}/api/v2/`;
      WS_URL = "wss://staging.app.cg";
      CGID_URL = "https://id.staging.app.cg/#";
    }
    else {
      let apiPort = "";
      if (port === ":3000") {
        apiPort = protocol === "http" ? ":8000" : ":8001";
      }
      else if (port === ":8000" || port === ":8001") {
        apiPort = port;
      }

      APP_URL = `${protocol}://${domain}${port}`;
      API_BASE_URL = `${protocol}://${domain}${apiPort}`;
      API_URL = `${API_BASE_URL}/api/v2/`;
      WS_URL = `${protocol === "http" ? "ws" : "wss"}://${domain}${apiPort}`;
      CGID_URL = `${APP_URL}/index_cgid.html${port === ":3000" ? "#" : "/#"}`;
      I_AM_CGID = href.startsWith(`${APP_URL}/index_cgid.html`);
    }
  }
}

const urlConfig = {
  APP_URL,
  WS_URL,
  API_URL,
  API_BASE_URL,
  CGID_URL,
  I_AM_CGID,
};

export default Object.freeze(urlConfig);
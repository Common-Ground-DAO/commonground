// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import config from "../common/config";
import urls from "./urls";

/**
 * The origins the web app of this instance runs on: exactly the BASE_URL
 * origin, plus the local development origins in dev. Used for the api's CORS
 * list and for the domain of wallet sign-in messages (SIWE).
 */
export function appOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const origins = [new URL(urls.APP_URL).origin];
  if (config.DEPLOYMENT === 'dev') {
    origins.push(
      'http://localhost:3000',
      'https://localhost:3000',
      'http://localhost:8000',
      'https://localhost:8001',
      'http://app.cg.local:3000',
      'https://app.cg.local:3000',
      'http://app.cg.local:8000',
      'https://app.cg.local:8001',
      'https://bs-local.com:3000',
      'https://bs-local.com:8001',
    );
    if (env.LOCAL_CERTIFICATE_IP) {
      origins.push(
        `http://${env.LOCAL_CERTIFICATE_IP}:3000`,
        `https://${env.LOCAL_CERTIFICATE_IP}:3000`,
        `http://${env.LOCAL_CERTIFICATE_IP}:8000`,
        `https://${env.LOCAL_CERTIFICATE_IP}:8001`,
      );
    }
  }
  return origins;
}

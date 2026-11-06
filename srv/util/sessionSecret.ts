// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { dockerSecret } from ".";

/** the dev template's placeholder (docker/.env.example), replaced by docker/ensureEnv.sh */
const PLACEHOLDER = "generated-on-first-run";
const MIN_LENGTH = 16;

type ReadDockerSecret = (name: string) => string | false | undefined;

/**
 * The session secret as configured (Docker secret `redis_secret`, else
 * REDIS_SECRET), or undefined. Used as it is — a trailing newline of a secret
 * file included — so the cookie signatures, the unsubscribe-link key and the
 * mail-limit keys stay what they were before this helper existed. The one
 * place that reads it: requireSessionSecret, the unsubscribe links
 * (srv/api/emails.ts) and the mail limits (srv/util/mailSendLimits.ts).
 */
export function configuredSessionSecret(
  env: NodeJS.ProcessEnv = process.env,
  readDockerSecret: ReadDockerSecret = dockerSecret,
): string | undefined {
  return readDockerSecret("redis_secret") || env.REDIS_SECRET || undefined;
}

/**
 * The secret that signs the session cookies (configuredSessionSecret); the
 * unsubscribe-link and mail-limit keys are derived from it as well. Every
 * process that needs it (api, wsapi, job-runner) reads it through this
 * function at startup, so a missing one stops the process right away instead
 * of failing requests later: missing, only whitespace, the template
 * placeholder or shorter than 16 characters (each without surrounding
 * whitespace) refuses to start. Each instance that shares the Valkey has its
 * own (the gateway: docs/auth-identity §12).
 */
export function requireSessionSecret(
  env: NodeJS.ProcessEnv = process.env,
  readDockerSecret: ReadDockerSecret = dockerSecret,
): string {
  const secret = configuredSessionSecret(env, readDockerSecret) ?? "";
  const checked = secret.trim();
  if (!checked || checked === PLACEHOLDER) {
    throw new Error("REDIS_SECRET (the session secret) is not set: refusing to start");
  }
  if (checked.length < MIN_LENGTH) {
    throw new Error(`REDIS_SECRET (the session secret) is shorter than ${MIN_LENGTH} characters: refusing to start`);
  }
  return secret;
}

/**
 * The secret an instance and its gateway share for the per-address mail
 * limits (Docker secret `mail_limit_secret`, else CG_MAIL_LIMIT_SECRET;
 * docs/auth-identity §12), without surrounding whitespace — both sides then
 * derive the same keys, whichever of the two sources each reads — or
 * undefined. Read by the mail limits (mailLimitSecret) and checked at a
 * gateway api's start (validateGatewayConfig).
 */
export function sharedMailLimitSecret(
  env: NodeJS.ProcessEnv = process.env,
  readDockerSecret: ReadDockerSecret = dockerSecret,
): string | undefined {
  return (readDockerSecret("mail_limit_secret") || env.CG_MAIL_LIMIT_SECRET || "").trim() || undefined;
}

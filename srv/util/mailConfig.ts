// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * SMTP configuration of the outgoing mail path (srv/api/emails.ts).
 *
 * Email is optional: without SMTP_HOST the backend runs with email disabled
 * (emailEnabled() is false, the jobs skip their mail work, the instance config
 * hides email features). An invalid setting disables email as well — with the
 * reason in the log — instead of crashing the process.
 *
 * Kept free of imports with side effects so it can be unit-tested.
 */

export type SmtpSecurity = 'tls' | 'starttls' | 'none';

export type MailConfig = {
  host: string;
  port: number;
  /**
   * tls      implicit TLS from the first byte (usually port 465)
   * starttls plain connect, then STARTTLS — required, never falls back to
   *          plaintext (usually port 587)
   * none     no TLS at all — only for a relay on a private network, e.g. the
   *          selfhost `mail` container (usually port 25 or 587)
   */
  security: SmtpSecurity;
  auth?: { user: string; pass: string };
  from: { address: string; name: string };
};

export type MailConfigResult =
  | { enabled: true; config: MailConfig }
  | { enabled: false; reason: string };

const DEFAULT_PORTS: Record<SmtpSecurity, number> = {
  tls: 465,
  starttls: 587,
  none: 25,
};

// deliberately simple: one @, no whitespace, a dot in the domain part (or
// "localhost" for dev catchers). The SMTP server has the final word.
const ADDRESS_REGEX = /^[^\s@<>"]+@(localhost|[^\s@<>"]+\.[^\s@<>"]+)$/i;

type Env = Record<string, string | undefined>;

function isSmtpSecurity(value: string): value is SmtpSecurity {
  return Object.prototype.hasOwnProperty.call(DEFAULT_PORTS, value);
}

/**
 * @param appHostname host of BASE_URL; the default sender is no-reply@<appHostname>
 */
export function parseMailConfig(env: Env, appHostname: string): MailConfigResult {
  const host = (env.SMTP_HOST || '').trim();
  if (!host) {
    return { enabled: false, reason: 'SMTP_HOST is not set' };
  }

  const rawSecurity = (env.SMTP_SECURITY || '').trim().toLowerCase() || 'starttls';
  if (!isSmtpSecurity(rawSecurity)) {
    return { enabled: false, reason: `SMTP_SECURITY must be tls, starttls or none (got "${rawSecurity}")` };
  }
  const security = rawSecurity;

  const rawPort = (env.SMTP_PORT || '').trim();
  let port = DEFAULT_PORTS[security];
  if (rawPort) {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      return { enabled: false, reason: `SMTP_PORT is not a valid port (got "${rawPort}")` };
    }
    port = parsed;
  }

  const user = (env.SMTP_USER || '').trim();
  const pass = env.SMTP_PASSWORD || '';
  if (!!user !== !!pass) {
    return { enabled: false, reason: 'set both SMTP_USER and SMTP_PASSWORD, or neither' };
  }

  const fromAddress = (env.EMAIL_FROM || '').trim() || `no-reply@${appHostname}`;
  if (!ADDRESS_REGEX.test(fromAddress)) {
    return { enabled: false, reason: `EMAIL_FROM is not a plain email address (got "${fromAddress}")` };
  }
  // the display name goes into a header; strip what could break it
  const fromName = (env.EMAIL_FROM_NAME || '').replace(/[\r\n"<>]/g, '').trim() || 'Common Ground';

  return {
    enabled: true,
    config: {
      host,
      port,
      security,
      auth: user ? { user, pass } : undefined,
      from: { address: fromAddress, name: fromName },
    },
  };
}

/**
 * True for hosts that are plausibly on the same machine or docker network:
 * loopback, or a single-label name such as a compose service (`mail`,
 * `mailpit`). Anything with a dot is treated as reachable over a real network.
 */
export function isInternalSmtpHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h) || /^[a-z0-9-]+$/.test(h);
}

/**
 * Startup warning for SMTP_SECURITY=none towards a host that is not
 * internal; null when there is nothing to warn about. With a login, the
 * password itself crosses the network in clear.
 */
export function plaintextSmtpWarning(result: MailConfigResult): string | null {
  if (!result.enabled || result.config.security !== 'none' || isInternalSmtpHost(result.config.host)) {
    return null;
  }
  const { host, auth } = result.config;
  if (auth) {
    return `!!! SMTP_SECURITY=none with SMTP_HOST=${host}: the SMTP password and every mail (login codes included) cross the network unencrypted. Use tls or starttls for any server that is not an internal relay. !!!`;
  }
  return `SMTP_SECURITY=none with SMTP_HOST=${host}: mails (login codes included) cross the network unencrypted. Use tls or starttls for any server that is not an internal relay.`;
}

/** One line for the startup log; never contains the password. */
export function describeMailConfig(result: MailConfigResult): string {
  if (!result.enabled) {
    return `Email delivery is disabled: ${result.reason}. Email login codes, verification and notification mails are unavailable.`;
  }
  const { host, port, security, auth, from } = result.config;
  return `Email delivery via SMTP ${host}:${port} (${security}${auth ? `, user ${auth.user}` : ', no auth'}), from ${from.address}`;
}

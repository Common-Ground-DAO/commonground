// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describeMailConfig, parseMailConfig, plaintextSmtpWarning } from '../util/mailConfig';

const HOST = 'cg.example.org';

describe('parseMailConfig', () => {
  it('disables email without SMTP_HOST', () => {
    for (const SMTP_HOST of [undefined, '', '   ']) {
      const result = parseMailConfig({ SMTP_HOST }, HOST);
      expect(result.enabled).toBe(false);
    }
  });

  it('defaults to STARTTLS on 587 and no-reply@<app host>', () => {
    const result = parseMailConfig({ SMTP_HOST: 'smtp.example.org' }, HOST);
    expect(result).toEqual({
      enabled: true,
      config: {
        host: 'smtp.example.org',
        port: 587,
        security: 'starttls',
        auth: undefined,
        from: { address: 'no-reply@cg.example.org', name: 'Common Ground' },
      },
    });
  });

  it('derives the port from the security mode unless set', () => {
    const port = (env: Record<string, string>) => {
      const result = parseMailConfig({ SMTP_HOST: 'h', ...env }, HOST);
      return result.enabled ? result.config.port : null;
    };
    expect(port({ SMTP_SECURITY: 'tls' })).toBe(465);
    expect(port({ SMTP_SECURITY: 'none' })).toBe(25);
    expect(port({ SMTP_SECURITY: 'NONE', SMTP_PORT: '2525' })).toBe(2525);
  });

  it('disables email on invalid settings instead of throwing', () => {
    for (const env of [
      { SMTP_SECURITY: 'ssl' },
      { SMTP_SECURITY: 'constructor' },
      { SMTP_PORT: '0' },
      { SMTP_PORT: 'abc' },
      { SMTP_PORT: '70000' },
      { SMTP_USER: 'user' },
      { SMTP_PASSWORD: 'secret' },
      { EMAIL_FROM: 'Common Ground <no-reply@example.org>' },
      { EMAIL_FROM: 'no-reply' },
    ]) {
      const result = parseMailConfig({ SMTP_HOST: 'h', ...env }, HOST);
      expect(result.enabled).toBe(false);
    }
  });

  it('takes auth, sender and display name from the environment', () => {
    const result = parseMailConfig({
      SMTP_HOST: 'mail',
      SMTP_SECURITY: 'none',
      SMTP_PORT: '587',
      SMTP_USER: 'cg-app',
      SMTP_PASSWORD: 'secret',
      EMAIL_FROM: 'hello@example.org',
      EMAIL_FROM_NAME: 'My "Instance"\r\nBcc: x@example.org',
    }, HOST);
    expect(result.enabled && result.config).toEqual({
      host: 'mail',
      port: 587,
      security: 'none',
      auth: { user: 'cg-app', pass: 'secret' },
      from: { address: 'hello@example.org', name: 'My InstanceBcc: x@example.org' },
    });
  });

  it('never logs the password', () => {
    const result = parseMailConfig({ SMTP_HOST: 'mail', SMTP_USER: 'u', SMTP_PASSWORD: 'hunter2' }, HOST);
    expect(describeMailConfig(result)).not.toContain('hunter2');
    expect(describeMailConfig(parseMailConfig({}, HOST))).toContain('disabled');
  });
});

describe('plaintextSmtpWarning', () => {
  const warn = (env: Record<string, string>) => plaintextSmtpWarning(parseMailConfig(env, HOST));

  it('stays quiet for internal relays and for TLS', () => {
    for (const SMTP_HOST of ['mail', 'mailpit', 'localhost', '127.0.0.1', '[::1]']) {
      expect(warn({ SMTP_HOST, SMTP_SECURITY: 'none', SMTP_USER: 'u', SMTP_PASSWORD: 'p' })).toBeNull();
    }
    expect(warn({ SMTP_HOST: 'smtp.example.net', SMTP_SECURITY: 'starttls', SMTP_USER: 'u', SMTP_PASSWORD: 'p' })).toBeNull();
    expect(warn({ SMTP_HOST: 'smtp.example.net', SMTP_SECURITY: 'tls' })).toBeNull();
  });

  it('warns for plaintext to a real host, loudly with a login, never with the password', () => {
    const withAuth = warn({ SMTP_HOST: 'smtp.example.net', SMTP_SECURITY: 'none', SMTP_USER: 'u', SMTP_PASSWORD: 'hunter2' });
    expect(withAuth).toMatch(/^!!! .*password.*unencrypted/);
    expect(withAuth).not.toContain('hunter2');
    expect(warn({ SMTP_HOST: '192.0.2.10', SMTP_SECURITY: 'none' })).toMatch(/unencrypted/);
  });
});

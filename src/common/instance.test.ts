// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `getInstanceConfig()` is the single accessor for `window.__CG_INSTANCE__`,
 * the script the API (`srv/util/instanceConfig.ts`) and the selfhost nginx
 * entrypoint (`docker/nginx/inject-instance-config.sh`) inject into the shipped
 * HTML shell at serve time. It is a whitelist validator: the injected object is
 * attacker-reachable in a self-hosted deployment, so anything not explicitly
 * accepted has to be dropped rather than passed through.
 *
 * The module caches on first call, so every case re-imports it after resetting
 * the module registry.
 */
async function readConfig(raw: unknown) {
  vi.resetModules();
  (globalThis as Record<string, unknown>).__CG_INSTANCE__ = raw;
  const { getInstanceConfig } = await import('common/instance');
  return getInstanceConfig();
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__CG_INSTANCE__;
});

describe('getInstanceConfig', () => {
  it('returns undefined when no instance config was injected', async () => {
    expect(await readConfig(undefined)).toBeUndefined();
  });

  it('keeps the fields it recognises and normalises appUrl', async () => {
    const config = await readConfig({
      deployment: 'prod',
      appUrl: 'https://chat.example.org///',
      captchaProvider: 'altcha',
      activeChains: ['ethereum', 'base'],
      features: { calls: false, email: true, imageFilter: false },
    });

    expect(config).toEqual({
      deployment: 'prod',
      appUrl: 'https://chat.example.org',
      captchaProvider: 'altcha',
      activeChains: ['ethereum', 'base'],
      features: { calls: false, email: true, imageFilter: false },
    });
  });

  it('drops values outside the whitelist instead of passing them through', async () => {
    const config = await readConfig({
      deployment: 'staging-2',
      appUrl: 'javascript:alert(1)',
      cgidUrl: '/relative',
      captchaProvider: 'none',
      activeChains: ['ok', 'NOT OK', 42],
      features: { calls: 'yes', imageFilter: 'false', somethingElse: true },
      walletConnectProjectId: '../../etc/passwd',
      unknownKey: 'dropped',
    });

    expect(config).toEqual({ activeChains: ['ok'], features: {} });
  });

  it('caches: a later mutation of the global is ignored', async () => {
    vi.resetModules();
    (globalThis as Record<string, unknown>).__CG_INSTANCE__ = { deployment: 'dev' };
    const { getInstanceConfig } = await import('common/instance');

    expect(getInstanceConfig()).toEqual({ deployment: 'dev' });
    (globalThis as Record<string, unknown>).__CG_INSTANCE__ = { deployment: 'prod' };
    expect(getInstanceConfig()).toEqual({ deployment: 'dev' });
  });
});

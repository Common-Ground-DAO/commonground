// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).window = { location: { href: '' } };
});

import { computeAuthMode } from './authMode';
import { isForbiddenPluginUrl } from './pluginOrigin';

describe('computeAuthMode', () => {
  it('uses main-origin passkeys on an instance that declares them', () => {
    expect(computeAuthMode({ appUrl: 'https://cg.box', passkeyRpId: 'cg.box', features: { passkeys: true } }, 'cg.box'))
      .toEqual({ legacyCgid: false, passkeysOnOrigin: true, passkeyRpId: 'cg.box' });
  });

  it('is legacy only when the instance carries a CG ID url', () => {
    expect(computeAuthMode({ cgidUrl: 'https://id.app.cg/#' }, 'app.cg').legacyCgid).toBe(true);
    expect(computeAuthMode({ cgidUrl: 'https://id.app.cg/#', passkeyRpId: 'app.cg' }, 'app.cg').passkeyRpId).toBeNull();
  });

  it('treats features.passkeys: false as "passkeys unavailable", not as legacy', () => {
    expect(computeAuthMode({ features: { passkeys: false } }, 'example.org'))
      .toEqual({ legacyCgid: false, passkeysOnOrigin: false, passkeyRpId: null });
  });

  it('falls back to the host without an instance config', () => {
    expect(computeAuthMode(undefined, 'app.cg').legacyCgid).toBe(true);
    expect(computeAuthMode(undefined, 'localhost').legacyCgid).toBe(false);
  });
});

describe('isForbiddenPluginUrl', () => {
  const forbidden = ['cg.box'];
  it.each([
    'https://cg.box/plugin',
    'https://plugins.cg.box/x',
    'https://CG.BOX./x',
    '/relative/path',
  ])('refuses %s', (url) => {
    expect(isForbiddenPluginUrl(url, forbidden)).toBe(true);
  });

  it.each([
    'https://cg.box.evil.example/x',
    'https://notcg.box/x',
    'https://plugin.example.org/',
  ])('allows %s', (url) => {
    expect(isForbiddenPluginUrl(url, forbidden)).toBe(false);
  });
});

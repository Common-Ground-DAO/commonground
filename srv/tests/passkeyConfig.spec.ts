// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { buildLegacyCgidRp, buildMainRp, isLegacyCgidMode, isSameOrSubdomain } from '../util/passkeyConfig';
import { isForbiddenPluginHost } from '../validators/api/plugin';

describe('main relying party', () => {
  it('defaults to the BASE_URL host with exactly its origin', () => {
    expect(buildMainRp({ baseUrl: 'https://cg.box', appHostname: 'cg.box', deployment: 'prod' }))
      .toEqual({ rpId: 'cg.box', rpName: 'Common Ground', origins: ['https://cg.box'] });
  });

  it('accepts PASSKEY_RP_ID equal to or a parent of the app host', () => {
    expect(buildMainRp({ baseUrl: 'https://chat.example.org', appHostname: 'chat.example.org', deployment: 'prod', passkeyRpId: 'example.org' }).rpId)
      .toBe('example.org');
    expect(buildMainRp({ baseUrl: 'https://cg.box', appHostname: 'cg.box', deployment: 'prod', passkeyRpId: 'CG.BOX' }).rpId)
      .toBe('cg.box');
  });

  it.each([
    'other.org',
    'box',
    'sub.cg.box',
    'evilcg.box',
    'cg.box/x',
    'https://cg.box',
  ])('refuses PASSKEY_RP_ID %s for app host cg.box', (passkeyRpId) => {
    expect(() => buildMainRp({ baseUrl: 'https://cg.box', appHostname: 'cg.box', deployment: 'prod', passkeyRpId })).toThrow(/PASSKEY_RP_ID/);
  });

  it('adds the local dev origins only in dev', () => {
    const dev = buildMainRp({ baseUrl: 'http://localhost:8000', appHostname: 'localhost', deployment: 'dev' });
    expect(dev.rpId).toBe('localhost');
    expect(dev.origins).toEqual(['http://localhost:8000', 'http://localhost:3000']);
  });

  it('never includes a CG ID origin', () => {
    const rp = buildMainRp({ baseUrl: 'https://cg.box', appHostname: 'cg.box', deployment: 'prod' });
    expect(rp.origins.some(origin => origin.includes('id.'))).toBe(false);
  });
});

describe('legacy CG ID relying party', () => {
  it('is the CGID_URL host with exactly its origin', () => {
    expect(buildLegacyCgidRp({ cgidUrl: 'https://id.app.cg/#', deployment: 'prod' }))
      .toEqual({ rpId: 'id.app.cg', rpName: 'Common Ground', origins: ['https://id.app.cg'] });
  });

  it('needs CGID_URL', () => {
    expect(() => buildLegacyCgidRp({ cgidUrl: undefined, deployment: 'prod' })).toThrow(/CGID_URL/);
  });

  it('is only active with CG_LEGACY_CGID=true', () => {
    expect(isLegacyCgidMode({})).toBe(false);
    expect(isLegacyCgidMode({ CG_LEGACY_CGID: '1' })).toBe(false);
    expect(isLegacyCgidMode({ CG_LEGACY_CGID: 'true' })).toBe(true);
  });
});

describe('plugin hosts', () => {
  it.each([
    ['cg.box', true],
    ['CG.box', true],
    ['plugins.cg.box', true],
    ['a.b.cg.box', true],
    ['cg.box.evil.com', false],
    ['evilcg.box', false],
    ['plugin.example.org', false],
  ])('%s forbidden: %s', (host, forbidden) => {
    expect(isForbiddenPluginHost(host, ['cg.box'])).toBe(forbidden);
    expect(isSameOrSubdomain(host, 'cg.box')).toBe(forbidden);
  });
});

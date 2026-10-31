// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { addressesToUnverify, bouncePolicyFromEnv, detectBurst } from '../util/bouncePolicy';

const policy = bouncePolicyFromEnv({});
const HOUR = 60 * 60 * 1000;
const at = (hoursAgo: number) => new Date(Date.UTC(2026, 9, 31, 12) - hoursAgo * HOUR);
const noBurst = detectBurst([], policy);

describe('bounce policy', () => {
  it('has the documented defaults and env overrides', () => {
    expect(policy).toMatchObject({ minBounces: 2, minSpanMs: 24 * HOUR, burstWindowMs: HOUR, burstAddresses: 25, burstDomainAddresses: 10 });
    expect(bouncePolicyFromEnv({ MAIL_BOUNCE_BURST_ADDRESSES: '50', MAIL_BOUNCE_BURST_DOMAIN_ADDRESSES: 'x' }))
      .toMatchObject({ burstAddresses: 50, burstDomainAddresses: 10 });
  });

  it('never unverifies on the first bounce', () => {
    const history = new Map([['a@x.org', [at(0)]]]);
    expect(addressesToUnverify(['a@x.org'], history, noBurst, policy)).toEqual([]);
  });

  it('needs two bounces at least 24 h apart', () => {
    const close = new Map([['a@x.org', [at(23), at(0)]]]);
    expect(addressesToUnverify(['a@x.org'], close, noBurst, policy)).toEqual([]);
    const apart = new Map([['a@x.org', [at(24), at(0)]], ['b@y.org', [at(0), at(0.5), at(1)]]]);
    expect(addressesToUnverify(['a@x.org', 'b@y.org'], apart, noBurst, policy)).toEqual(['a@x.org']);
  });

  it('detects a global burst above the address limit and then unverifies nobody', () => {
    const addresses = Array.from({ length: 26 }, (_, i) => `u${i}@d${i % 5}.org`);
    const burst = detectBurst([...addresses, ...addresses], policy);
    expect(burst).toMatchObject({ global: true, addresses: 26 });
    expect(detectBurst(addresses.slice(0, 25), policy).global).toBe(false);
    const history = new Map([['u1@d1.org', [at(48), at(0)]]]);
    expect(addressesToUnverify(['u1@d1.org'], history, burst, policy)).toEqual([]);
  });

  it('detects a burst in one recipient domain and spares only that domain', () => {
    const gmail = Array.from({ length: 11 }, (_, i) => `u${i}@gmail.com`);
    const burst = detectBurst([...gmail, 'x@other.org'], policy);
    expect(burst).toEqual({ global: false, domains: ['gmail.com'], addresses: 12 });
    const history = new Map([
      ['u1@gmail.com', [at(48), at(0)]],
      ['x@other.org', [at(48), at(0)]],
    ]);
    expect(addressesToUnverify(['u1@gmail.com', 'x@other.org'], history, burst, policy)).toEqual(['x@other.org']);
  });
});

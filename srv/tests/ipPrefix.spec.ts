// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { classifyForwardedIp, ipv6ToBytes } from '../util/ipPrefix';

describe('ipv6ToBytes', () => {
  it('expands a full address', () => {
    expect(Array.from(ipv6ToBytes('2001:db8:85a3:1:2:3:4:5'))).toEqual([
      0x20, 0x01, 0x0d, 0xb8, 0x85, 0xa3, 0x00, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x00,
      0x05,
    ]);
  });

  it('expands :: compression at every position', () => {
    expect(Array.from(ipv6ToBytes('::'))).toEqual(new Array(16).fill(0));
    expect(Array.from(ipv6ToBytes('::1'))).toEqual([...new Array(15).fill(0), 1]);
    expect(Array.from(ipv6ToBytes('1::'))).toEqual([0, 1, ...new Array(14).fill(0)]);
    expect(Array.from(ipv6ToBytes('2001:db8::9'))).toEqual([
      0x20, 0x01, 0x0d, 0xb8, ...new Array(11).fill(0), 9,
    ]);
  });

  it('expands a trailing dotted quad', () => {
    expect(Array.from(ipv6ToBytes('::ffff:203.0.113.9'))).toEqual([
      ...new Array(10).fill(0), 0xff, 0xff, 203, 0, 113, 9,
    ]);
  });
});

describe('classifyForwardedIp', () => {
  it('keys IPv4 on the dotted address, with no prefix buckets', () => {
    expect(classifyForwardedIp('70.41.3.18')).toEqual({ ipString: '70.41.3.18' });
  });

  it('uses only the first address of a forwarding chain', () => {
    expect(classifyForwardedIp('70.41.3.18, 10.0.0.1')).toEqual({ ipString: '70.41.3.18' });
    expect(classifyForwardedIp('2001:db8::1, 70.41.3.18').ip56String).toBe('20010db8000000');
  });

  it('keys IPv6 on zero-padded /64, /56 and /48 prefixes', () => {
    expect(classifyForwardedIp('2001:db8:85a3:1:2:3:4:5')).toEqual({
      ipString: '20010db885a30001',
      ip56String: '20010db885a300',
      ip48String: '20010db885a3',
    });
  });

  it('groups addresses of one /56 into the same bucket', () => {
    const a = classifyForwardedIp('2001:db8:1:203::1');
    const b = classifyForwardedIp('2001:db8:1:2ff::9');
    expect(a.ipString).not.toBe(b.ipString); // different /64
    expect(a.ip56String).toBe(b.ip56String);
    expect(a.ip48String).toBe(b.ip48String);
    expect(a.ip56String).toBe('20010db8000102');
  });

  it('is case-insensitive for IPv6', () => {
    expect(classifyForwardedIp('2001:DB8::1')).toEqual(classifyForwardedIp('2001:db8::1'));
  });

  it('keys v4-mapped IPv6 on the embedded IPv4', () => {
    expect(classifyForwardedIp('::ffff:203.0.113.9')).toEqual({ ipString: '203.0.113.9' });
  });

  it('does not treat a non-mapped address with ffff groups as mapped', () => {
    expect(classifyForwardedIp('ffff::ffff').ip56String).toBe('ffff0000000000');
  });

  it('keys v4 embedded in a non-mapped position on the v6 prefixes', () => {
    // NAT64 well-known prefix — must NOT be treated as a v4 client
    expect(classifyForwardedIp('64:ff9b::1.2.3.4')).toEqual({
      ipString: '0064ff9b00000000',
      ip56String: '0064ff9b000000',
      ip48String: '0064ff9b0000',
    });
  });

  it('returns no keys for invalid input', () => {
    expect(classifyForwardedIp('')).toEqual({});
    expect(classifyForwardedIp('not-an-ip')).toEqual({});
    expect(classifyForwardedIp('1:2:3')).toEqual({});
    expect(classifyForwardedIp('::ffff:')).toEqual({});
    expect(classifyForwardedIp('::ffff:1.2.3.999')).toEqual({});
  });

  it('rejects non-canonical v4 shapes the old regex-based code keyed as-is', () => {
    // fail-closed vs. the `ip` package: these all got rate-limit keys before
    expect(classifyForwardedIp('070.41.3.18')).toEqual({});
    expect(classifyForwardedIp('999.1.2.3')).toEqual({});
    expect(classifyForwardedIp('1.2.3')).toEqual({});
    expect(classifyForwardedIp('abcd')).toEqual({});
  });
});

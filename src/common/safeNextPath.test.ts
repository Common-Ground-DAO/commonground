// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it } from 'vitest';
import { safeNextPath } from './safeNextPath';

const ORIGIN = 'https://cg.box';

describe('safeNextPath', () => {
  it.each([
    ['/c/abc/', '/c/abc/'],
    ['/notifications?x=1#top', '/notifications?x=1#top'],
    ['/a/../b', '/b'],
    // an encoded tab stays encoded in the path: harmless
    ['/%09/evil.com', '/%09/evil.com'],
  ])('keeps the same-site path %s', (next, expected) => {
    expect(safeNextPath(next, ORIGIN)).toBe(expected);
  });

  it.each([
    null,
    '',
    'https://evil.com/',
    'evil.com',
    '//evil.com',
    '/\\evil.com',
    '\\\\evil.com',
    // URLSearchParams has already decoded %09 / %0A / %0D into the raw characters
    '/\t/evil.com',
    '/\n/evil.com',
    '/\r//evil.com',
    '/\u0000x',
    'javascript:alert(1)',
  ])('rejects %j', (next) => {
    expect(safeNextPath(next, ORIGIN)).toBeNull();
  });

  it('decoded query values from the real URL are rejected too', () => {
    const params = new URLSearchParams('next=/%09/evil.com&n2=%0A//evil.com&n3=%2F%2Fevil.com');
    expect(safeNextPath(params.get('next'), ORIGIN)).toBeNull();
    expect(safeNextPath(params.get('n2'), ORIGIN)).toBeNull();
    expect(safeNextPath(params.get('n3'), ORIGIN)).toBeNull();
  });
});

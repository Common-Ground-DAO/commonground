// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, it, expect } from 'vitest';
import { cssBackgroundImage } from './cssBackground';

describe('cssBackgroundImage', () => {
  it('returns none without a URL, so no relative "undefined" request is made', () => {
    expect(cssBackgroundImage(undefined)).toBe('none');
    expect(cssBackgroundImage(null)).toBe('none');
    expect(cssBackgroundImage('')).toBe('none');
  });

  it('quotes the URL', () => {
    expect(cssBackgroundImage('https://s3.example/a.webp?X-Sig=1&b=2'))
      .toBe('url("https://s3.example/a.webp?X-Sig=1&b=2")');
    expect(cssBackgroundImage('blob:https://cg.test/1234')).toBe('url("blob:https://cg.test/1234")');
  });

  it('keeps parentheses inside the quoted value', () => {
    expect(cssBackgroundImage('https://x.example/a(1).png')).toBe('url("https://x.example/a(1).png")');
  });

  it('escapes quotes, backslashes and line breaks', () => {
    expect(cssBackgroundImage('a"b\\c')).toBe('url("a\\"b\\\\c")');
    expect(cssBackgroundImage('a\nb\rc')).toBe('url("a\\a b\\d c")');
  });
});

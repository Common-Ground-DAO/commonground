// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { icsFold, icsJoin, icsParam, icsText } from '../common/ics';

describe('iCalendar helpers', () => {
  it('escapes TEXT values (RFC 5545 3.3.11)', () => {
    expect(icsText('a\\b;c,d\ne\r\nf')).toBe('a\\\\b\\;c\\,d\\ne\\nf');
    // an injected line ending can't start a new property
    expect(icsText('x\r\nEND:VEVENT')).not.toMatch(/[\r\n]/);
    // "$placeholder"-looking text stays literal
    expect(icsText('$timeStart')).toBe('$timeStart');
  });

  it('quotes parameter values and strips what cannot be quoted', () => {
    expect(icsParam('Café "Night"; Owls, Inc.\r\nX-INJECT:1')).toBe('"Café Night; Owls, Inc.X-INJECT:1"');
  });

  it('folds at 75 octets without splitting UTF-8 characters', () => {
    const line = `SUMMARY:${'ä'.repeat(100)}`;
    const folded = icsFold(line);
    for (const part of folded.split('\r\n')) {
      expect(Buffer.byteLength(part)).toBeLessThanOrEqual(75);
      expect(part).not.toContain('�');
    }
    expect(folded.replace(/\r\n /g, '')).toBe(line);
    expect(icsFold('SHORT:x')).toBe('SHORT:x');
  });

  it('joins with CRLF and a final CRLF', () => {
    expect(icsJoin(['BEGIN:VCALENDAR', 'END:VCALENDAR'])).toBe('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
  });
});

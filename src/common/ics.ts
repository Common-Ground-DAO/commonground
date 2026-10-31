// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

// iCalendar (RFC 5545) building blocks for the event invites
// (generateEventICSFile in ./util). No imports: shared by frontend and backend.

/** TEXT value (RFC 5545 3.3.11): escape \ ; , and line breaks */
export function icsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** parameter value (RFC 5545 3.2): always quoted; DQUOTE and control characters can't appear in it */
export function icsParam(value: string): string {
  const allowed = [...value].filter(c => {
    const code = c.charCodeAt(0);
    return c !== '"' && code >= 0x20 && code !== 0x7f;
  });
  return `"${allowed.join('')}"`;
}

/** folds a content line at 75 octets (RFC 5545 3.1) without splitting a UTF-8 character */
export function icsFold(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    // continuation lines start with a space, which counts toward their 75
    if (currentBytes + bytes > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += bytes;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

/** joins content lines into an iCalendar object: folded, CRLF-terminated */
export function icsJoin(lines: string[]): string {
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

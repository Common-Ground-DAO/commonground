// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * `/login?next=…` and the path a transfer link continues to (shared with the
 * backend) only ever lead to a path on this site. Rejects anything
 * that is not a plain absolute path (`//host`, `\`, schemes), any control
 * character (browsers strip tabs and newlines, so `/\t/evil.com` would
 * become `//evil.com`), and anything that resolves to another origin; returns
 * the normalized pathname + search + hash, or null. The normalized result
 * never starts with `//` either (dot segments can collapse into one).
 */
export function safeNextPath(next: string | null | undefined, origin: string): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(next)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(next, origin);
  }
  catch {
    return null;
  }
  if (url.origin !== origin) {
    return null;
  }
  const path = `${url.pathname}${url.search}${url.hash}`;
  // normalisation can make a path out of dot segments that starts with two
  // slashes (`/.//host` → `//host`), which a browser reads as another host;
  // the result is checked like the input
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    return null;
  }
  return path;
}

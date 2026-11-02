// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * CSS `background-image` value for an image URL that may not exist (yet).
 *
 * Writing `url(${imageUrl})` directly renders `url(undefined)` while a signed
 * URL is still loading or when there is no image at all. The browser resolves
 * that as a relative URL against the current path and requests
 * `<path>/undefined` (on `/c/<community>/call/<id>/` that is a request for
 * `…/call/<id>/undefined`).
 *
 * Without a URL this returns `'none'`: an image that fails to load paints
 * nothing, so `none` keeps the look elements had before (their background
 * color shows) — without the request. With a URL it returns a quoted
 * `url("…")`, escaped so that quotes, backslashes, parentheses and line
 * breaks in the URL cannot end the value early.
 */
export function cssBackgroundImage(url: string | null | undefined): string {
  if (!url) {
    return 'none';
  }
  const escaped = url
    .replace(/[\\"]/g, '\\$&')
    .replace(/\n/g, '\\a ')
    .replace(/\r/g, '\\d ');
  return `url("${escaped}")`;
}

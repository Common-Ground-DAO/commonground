// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import config from 'common/config';
import { confirmSuspiciousImage } from './suspiciousImageDialog';

/**
 * The one entry point every "a File is about to enter upload state" path calls.
 *
 * Gate → pre-check → confirmation dialog, returning `true` when the file may
 * proceed. It is deliberately impossible for this to reject: a broken pre-check
 * must never cost a user their upload, and the server-side filter is what
 * actually enforces the policy.
 *
 * The heavy classifier lives behind the `import()` below and nowhere else. Both
 * early returns are what keep tfjs and the 4.4 MB model off the wire for
 * instances that disable the filter and for non-image files.
 */
export async function checkImageBeforeUpload(file: File): Promise<boolean> {
  // Checked *before* the dynamic import on purpose: with the instance filter
  // off, nothing about this module graph should ever be fetched.
  if (!config.IMAGE_FILTER_ENABLED) return true;

  // Only raster images. SVG is excluded rather than left to the decoder: it can
  // reference remote resources, it taints the canvas, and the server rasterises
  // it through sharp anyway — where the authoritative filter sees it.
  if (!file.type.startsWith('image/')) return true;
  if (file.type === 'image/svg+xml' || file.type === 'image/svg') return true;

  try {
    const { checkImageFile } = await import('./imagePrecheck');
    // the server's own threshold, so lowering IMAGE_MODERATION_THRESHOLD makes
    // the browser warn earlier too instead of leaving it on a hardcoded value
    if ((await checkImageFile(file, config.IMAGE_FILTER_THRESHOLD)) === 'ok') return true;
  } catch {
    // Chunk failed to load (offline, stale deploy). Not the user's problem.
    return true;
  }

  return confirmSuspiciousImage();
}

export default checkImageBeforeUpload;

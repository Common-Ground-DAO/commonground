// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { beforeEach, describe, expect, it } from 'vitest';
import errors from 'common/errors';
import { notifyIfImageRejected } from './imageUploadError';
import { registerImageRejectedNotice } from './suspiciousImageDialog';

/**
 * `notifyIfImageRejected` is what makes a server-side rejection look the same
 * at all fifteen upload surfaces, and every one of them relies on the return
 * value to decide whether to *also* raise its own snackbar or inline error.
 * Both halves of that contract are pinned here:
 *
 * - only `IMAGE_CONTENT_REJECTED` may claim the modal, and
 * - a `false` answer must leave the dialog untouched, or an ordinary network
 *   failure would pop "this image appears to contain explicit content".
 */

let notices = 0;

beforeEach(() => {
  notices = 0;
  registerImageRejectedNotice(() => { notices += 1; });
  return () => registerImageRejectedNotice(undefined);
});

describe('notifyIfImageRejected', () => {
  it('shows the notice and claims the error when the filter rejected the image', () => {
    expect(notifyIfImageRejected(new Error(errors.server.IMAGE_CONTENT_REJECTED))).toBe(true);
    expect(notices).toBe(1);
  });

  it.each([
    ['a different backend error', new Error(errors.server.EXISTS_ALREADY)],
    ['a network failure', new Error('Failed to fetch')],
    ['a non-Error rejection', errors.server.IMAGE_CONTENT_REJECTED],
    ['nothing at all', undefined],
  ])('leaves %s to the call site', (_name, error) => {
    expect(notifyIfImageRejected(error)).toBe(false);
    expect(notices).toBe(0);
  });

  it('is a no-op without a provider mounted, so a missing host cannot break a catch block', () => {
    registerImageRejectedNotice(undefined);

    expect(() => notifyIfImageRejected(new Error(errors.server.IMAGE_CONTENT_REJECTED))).not.toThrow();
  });
});

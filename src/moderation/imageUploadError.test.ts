// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { beforeEach, describe, expect, it } from 'vitest';
import errors from 'common/errors';
import {
  imageUploadErrorText,
  isUploadTemporarilyRefused,
  notifyIfImageRejected,
} from './imageUploadError';
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

/**
 * The upload path can refuse for capacity reasons too — the route's rate limit
 * and the classifier shedding load. Those are wire enums; without a mapping the
 * user reads `RATE_LIMIT_EXCEEDED` in a snackbar. Unlike a content rejection
 * they are transient, so they must NOT claim the rejection modal.
 */
describe('transient upload refusals', () => {
  it.each([errors.server.RATE_LIMIT_EXCEEDED, errors.server.SERVICE_UNAVAILABLE])(
    'recognises %s as retryable',
    (code) => {
      expect(isUploadTemporarilyRefused(new Error(code))).toBe(true);
      expect(imageUploadErrorText(new Error(code), 'fallback')).toBe(errors.client.UPLOAD_BUSY);
    },
  );

  it('does not route them through the content-rejection modal', () => {
    expect(notifyIfImageRejected(new Error(errors.server.RATE_LIMIT_EXCEEDED))).toBe(false);
    expect(notifyIfImageRejected(new Error(errors.server.SERVICE_UNAVAILABLE))).toBe(false);
    expect(notices).toBe(0);
  });

  it('leaves a content rejection and unrelated errors alone', () => {
    expect(isUploadTemporarilyRefused(new Error(errors.server.IMAGE_CONTENT_REJECTED))).toBe(false);
    expect(isUploadTemporarilyRefused(new Error('Failed to fetch'))).toBe(false);
    expect(isUploadTemporarilyRefused(undefined)).toBe(false);
  });

  it('still prefers the rejection text and otherwise the raw message', () => {
    expect(imageUploadErrorText(new Error(errors.server.IMAGE_CONTENT_REJECTED), 'fallback'))
      .toBe(errors.client.IMAGE_CONTENT_REJECTED);
    expect(imageUploadErrorText(new Error('Failed to fetch'), 'fallback')).toBe('Failed to fetch');
    expect(imageUploadErrorText(undefined, 'fallback')).toBe('fallback');
  });
});

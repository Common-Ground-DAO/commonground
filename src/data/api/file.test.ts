// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `uploadImage` is the only upload path that bypasses `BaseApiConnector.ajax`
 * (it needs `multipart/form-data`, so it posts through axios directly), which
 * means it also has to replicate `ajax`'s error mapping by hand: the endpoint
 * answers failures with `{ status: 'ERROR', error }` at **HTTP 200**.
 *
 * That mapping is the single point at which a server-side image rejection
 * becomes a rejected promise — every `IMAGE_CONTENT_REJECTED` message in the UI
 * hangs off `isImageContentRejected(err)` matching the `Error` thrown here. Drop
 * the mapping and every one of those call sites silently treats a rejected
 * upload as a success, so it is pinned rather than left to review.
 */

vi.mock('axios', () => ({
  default: { post: vi.fn() },
}));

// `data/util/urls` reads `window.location.href` at module scope, and the test
// environment is `node`.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).window = { location: { href: '' } };
});

import axios from 'axios';
import fileApi from 'data/api/file';

const post = vi.mocked(axios.post);

function pngFile() {
  return new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
}

beforeEach(() => {
  post.mockReset();
});

describe('fileApi.uploadImage', () => {
  it('throws the server error code when the 200 body is an ERROR envelope', async () => {
    post.mockResolvedValue({ data: { status: 'ERROR', error: 'IMAGE_CONTENT_REJECTED' } } as never);

    await expect(
      fileApi.uploadImage({ type: 'userProfileImage' }, pngFile()),
    ).rejects.toThrow('IMAGE_CONTENT_REJECTED');
  });

  it('throws a generic error when the ERROR envelope carries no code', async () => {
    post.mockResolvedValue({ data: { status: 'ERROR' } } as never);

    await expect(
      fileApi.uploadImage({ type: 'userProfileImage' }, pngFile()),
    ).rejects.toThrow('Unknown API Response Error');
  });

  it('resolves with the payload for a normal success body', async () => {
    post.mockResolvedValue({ data: { imageId: 'img-1', largeImageId: 'img-1-large' } } as never);

    await expect(
      fileApi.uploadImage({ type: 'userProfileImage' }, pngFile()),
    ).resolves.toEqual({ imageId: 'img-1', largeImageId: 'img-1-large' });

    const [url, body] = post.mock.calls[0];
    expect(url).toMatch(/\/uploadImage$/);
    expect(body).toBeInstanceOf(FormData);
  });
});

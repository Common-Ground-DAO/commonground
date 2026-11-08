// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it } from 'vitest';
import { isAttachmentBusy } from './attachmentState';
import type { InMemoryAttachment } from './useAttachments/useAttachments';

const file = new File(['x'], 'cat.png', { type: 'image/png' });
const picked = (extra: Partial<InMemoryAttachment> = {}) =>
  ({ type: 'image', imageId: 'cat.png', largeImageId: '', tentativeFile: file, state: 'INITIAL', ...extra }) as InMemoryAttachment;

describe('isAttachmentBusy', () => {
  it('blocks while the pre-check runs', () => {
    expect(isAttachmentBusy(picked({ precheckPending: true }))).toBe(true);
  });

  it('blocks while the image uploads (no uploaded ids yet)', () => {
    expect(isAttachmentBusy(picked())).toBe(true);
  });

  it('blocks while the uploaded image loads', () => {
    expect(isAttachmentBusy(picked({ imageId: 'i1', largeImageId: 'l1', state: 'LOADING' }))).toBe(true);
  });

  it('lets an uploaded and loaded image through', () => {
    expect(isAttachmentBusy(picked({ imageId: 'i1', largeImageId: 'l1', state: 'LOADED' }))).toBe(false);
  });

  it('does not block on a failed upload', () => {
    expect(isAttachmentBusy(picked({ uploadFailed: true }))).toBe(false);
  });

  it('does not block on attachments of a message being edited (ids, no file)', () => {
    expect(isAttachmentBusy({ type: 'image', imageId: 'i1', largeImageId: 'l1', state: 'INITIAL' } as InMemoryAttachment)).toBe(false);
  });

  it('does not block on other attachment types', () => {
    expect(isAttachmentBusy({ type: 'giphy', gifId: 'g1', state: 'INITIAL' } as InMemoryAttachment)).toBe(false);
  });
});

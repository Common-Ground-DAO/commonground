// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it } from 'vitest';
import { isMediaRefusal } from './mediaRefusal';

describe('isMediaRefusal', () => {
  it('is the call server refusing the media (NOT_ALLOWED)', () => {
    expect(isMediaRefusal(new Error('NOT_ALLOWED'))).toBe(true);
  });

  it('is not any other failure of a produce', () => {
    expect(isMediaRefusal(new Error('this call is audio-only'))).toBe(false);
    expect(isMediaRefusal(new Error('BROADCASTERS_LIMIT_EXCEEDED'))).toBe(false);
    expect(isMediaRefusal(new DOMException('Permission denied', 'NotAllowedError'))).toBe(false);
    expect(isMediaRefusal('NOT_ALLOWED')).toBe(false);
    expect(isMediaRefusal(undefined)).toBe(false);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { isConfiguredSecret } from '../util/configuredSecret';

describe('isConfiguredSecret', () => {
  it('treats missing, empty and placeholder values as unconfigured', () => {
    for (const value of [undefined, null, '', '   ', 'placeholder', 'your-key', ' your-key ']) {
      expect(isConfiguredSecret(value)).toBe(false);
    }
  });

  it('accepts real values', () => {
    expect(isConfiguredSecret('SG.abc123')).toBe(true);
  });
});

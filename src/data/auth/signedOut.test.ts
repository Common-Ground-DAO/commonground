// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it, vi } from 'vitest';
import signedOutNotice, { signedOutDevicesText } from './signedOut';

describe('signed out from elsewhere', () => {
  it('says how many other devices were signed out', () => {
    expect(signedOutDevicesText(0)).toBeNull();
    expect(signedOutDevicesText(1)).toBe('Signed out 1 other device.');
    expect(signedOutDevicesText(3)).toBe('Signed out 3 other devices.');
    // the server could not end the other sessions right away
    expect(signedOutDevicesText(3, true)).toBe('Other devices will be signed out within a minute.');
    expect(signedOutDevicesText(0, true)).toBe('Other devices will be signed out within a minute.');
  });

  it('the notice is shown until it is dismissed, and tells its listeners', () => {
    const listener = vi.fn();
    const unsubscribe = signedOutNotice.subscribe(listener);
    expect(signedOutNotice.shown).toBe(false);
    signedOutNotice.show();
    signedOutNotice.show();
    expect(signedOutNotice.shown).toBe(true);
    signedOutNotice.dismiss();
    expect(signedOutNotice.shown).toBe(false);
    expect(listener.mock.calls).toEqual([[true], [false]]);
    unsubscribe();
    signedOutNotice.show();
    expect(listener).toHaveBeenCalledTimes(2);
    signedOutNotice.dismiss();
  });
});

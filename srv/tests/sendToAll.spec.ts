// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { sendToAll } from '../util/sendToAll';

describe('sendToAll', () => {
  it('sends to everyone, counts failures and never rejects', async () => {
    const attempted: string[] = [];
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await sendToAll(
      'article a1',
      ['a@x.org', 'b@x.org', 'c@x.org'],
      (_, i) => `recipient #${i}`,
      async (to) => {
        attempted.push(to);
        if (to === 'b@x.org') {
          throw new Error('550 rejected');
        }
      },
    );

    expect(attempted).toEqual(['a@x.org', 'b@x.org', 'c@x.org']);
    expect(result).toEqual({ sent: 2, failed: 1 });
    // logged by description, not by address
    expect(errors).toHaveBeenCalledWith('article a1: sending to recipient #1 failed: 550 rejected');
    expect(errors.mock.calls.flat().join(' ')).not.toContain('b@x.org');
    jest.restoreAllMocks();
  });
});

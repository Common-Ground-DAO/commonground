// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import errors from 'common/errors';
import { ApiRequestError } from 'data/api/apiError';
import { isMemberListRefusal, pollChannelMemberList } from './channelMemberListPolling';

const INTERVAL = 5000;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(load: () => Promise<string>, canRead = true) {
  const onResult = vi.fn();
  const onError = vi.fn();
  const stop = pollChannelMemberList({ canRead, load, onResult, onError, intervalMs: INTERVAL });
  return { onResult, onError, stop };
}

describe('pollChannelMemberList', () => {
  it('loads now and on every interval while the channel is readable', async () => {
    const load = vi.fn().mockResolvedValue('list');
    const { onResult, stop } = setup(load);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith('list');
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(load).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('never asks for a channel the caller cannot read', async () => {
    const load = vi.fn().mockResolvedValue('list');
    setup(load, false);
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(load).not.toHaveBeenCalled();
  });

  it.each([errors.server.NOT_ALLOWED, errors.server.LOGIN_REQUIRED])('stops after a %s answer', async (code) => {
    const load = vi.fn().mockRejectedValue(new ApiRequestError(code));
    const { onError } = setup(load);
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(load).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('keeps polling after other errors', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new ApiRequestError(errors.server.UNKNOWN))
      .mockResolvedValue('list');
    const { onResult, onError, stop } = setup(load);
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(load).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledWith('list');
    stop();
  });

  it('drops an answer that arrives after stop', async () => {
    let resolve!: (value: string) => void;
    const load = vi.fn(() => new Promise<string>(r => { resolve = r; }));
    const { onResult, stop } = setup(load);
    stop();
    resolve('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(onResult).not.toHaveBeenCalled();
  });
});

describe('isMemberListRefusal', () => {
  it('only counts access refusals from the API', () => {
    expect(isMemberListRefusal(new ApiRequestError(errors.server.NOT_ALLOWED))).toBe(true);
    expect(isMemberListRefusal(new ApiRequestError(errors.server.LOGIN_REQUIRED))).toBe(true);
    expect(isMemberListRefusal(new ApiRequestError(errors.server.UNKNOWN))).toBe(false);
    expect(isMemberListRefusal(new Error(errors.server.NOT_ALLOWED))).toBe(false);
  });
});

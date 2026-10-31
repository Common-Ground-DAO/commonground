// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Step-up retry in `BaseApiConnector.ajax`: a protected route answers
 * REAUTH_REQUIRED before any side effect, the connector asks the user to
 * confirm it's them (ReauthDialog via stepUpManager) and then sends the very
 * same request once more. Cancelled → the caller gets REAUTH_REQUIRED.
 */

// `data/util/urls` reads `window.location.href` at module scope, and the test
// environment is `node`.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).window = { location: { href: '' } };
});

const loginRequiredErrorHandler = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('data/appstate/login', () => ({ default: { loginRequiredErrorHandler } }));

import BaseApiConnector from './baseConnector';
import stepUpManager from 'data/auth/stepUp';

type Reply = { status: 'OK'; data?: unknown } | { status: 'ERROR'; error: string };

const sent: { url: string; body: string | undefined }[] = [];
let replies: Reply[] = [];

class FakeXMLHttpRequest {
  public readyState = 0;
  public status = 0;
  public response = '';
  public responseType = '';
  public withCredentials = false;
  public onreadystatechange: (() => void) | null = null;
  public onerror: ((e: unknown) => void) | null = null;
  private url = '';
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader() { }
  send(body?: string) {
    sent.push({ url: this.url, body });
    const reply = replies.shift() ?? { status: 'ERROR', error: 'NO_REPLY' };
    queueMicrotask(() => {
      this.readyState = 4;
      this.status = 200;
      this.response = JSON.stringify(reply);
      this.onreadystatechange?.();
    });
  }
}

class TestConnector extends BaseApiConnector {
  constructor() {
    super('User');
  }
  public setPassword(password: string) {
    return this.ajax<void>('POST', '/setPassword', { password });
  }
  public get(value: string) {
    return this.ajax<string>('POST', '/whatever', { value });
  }
}

const connector = new TestConnector();

beforeEach(() => {
  sent.length = 0;
  replies = [];
  (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXMLHttpRequest;
});

afterEach(() => {
  stepUpManager.setHandler(undefined);
  stepUpManager.clear();
});

describe('BaseApiConnector REAUTH_REQUIRED', () => {
  it('asks for a step-up and retries the same request once', async () => {
    const handler = vi.fn(async () => true);
    stepUpManager.setHandler(handler);
    replies = [{ status: 'ERROR', error: 'REAUTH_REQUIRED' }, { status: 'OK' }];

    await expect(connector.setPassword('hunter2hunter2')).resolves.toBeUndefined();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ action: 'change your password', allowWallet: true });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
  });

  it('returns the data of the retried request', async () => {
    stepUpManager.setHandler(async () => true);
    replies = [{ status: 'ERROR', error: 'REAUTH_REQUIRED' }, { status: 'OK', data: 'fine' }];
    await expect(connector.get('x')).resolves.toBe('fine');
  });

  it('gives up with REAUTH_REQUIRED when the dialog is cancelled, without a retry', async () => {
    stepUpManager.setHandler(async () => false);
    replies = [{ status: 'ERROR', error: 'REAUTH_REQUIRED' }];

    await expect(connector.setPassword('hunter2hunter2')).rejects.toThrow('REAUTH_REQUIRED');
    expect(sent).toHaveLength(1);
  });

  it('retries only once', async () => {
    const handler = vi.fn(async () => true);
    stepUpManager.setHandler(handler);
    replies = [{ status: 'ERROR', error: 'REAUTH_REQUIRED' }, { status: 'ERROR', error: 'REAUTH_REQUIRED' }];

    await expect(connector.setPassword('hunter2hunter2')).rejects.toThrow('REAUTH_REQUIRED');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(2);
  });

  it('passes REAUTH_REQUIRED through when no dialog is mounted', async () => {
    replies = [{ status: 'ERROR', error: 'REAUTH_REQUIRED' }];
    await expect(connector.setPassword('hunter2hunter2')).rejects.toThrow('REAUTH_REQUIRED');
    expect(sent).toHaveLength(1);
  });

  it('shares one dialog between concurrent requests', async () => {
    let release: (value: boolean) => void = () => undefined;
    const handler = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
    stepUpManager.setHandler(handler);
    replies = [
      { status: 'ERROR', error: 'REAUTH_REQUIRED' },
      { status: 'ERROR', error: 'REAUTH_REQUIRED' },
      { status: 'OK' },
      { status: 'OK' },
    ];
    const first = connector.setPassword('a-long-password');
    const second = connector.setPassword('a-long-password');
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 0));
    release(true);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('handles a REAUTH_REQUIRED that follows a LOGIN_REQUIRED re-login — once each', async () => {
    const handler = vi.fn(async () => true);
    stepUpManager.setHandler(handler);
    replies = [
      { status: 'ERROR', error: 'LOGIN_REQUIRED' },
      { status: 'ERROR', error: 'REAUTH_REQUIRED' },
      { status: 'OK', data: 'done' },
    ];
    await expect(connector.get('x')).resolves.toBe('done');
    expect(loginRequiredErrorHandler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(3);

    sent.length = 0;
    replies = [
      { status: 'ERROR', error: 'LOGIN_REQUIRED' },
      { status: 'ERROR', error: 'LOGIN_REQUIRED' },
    ];
    await expect(connector.get('x')).rejects.toThrow('LOGIN_REQUIRED');
    expect(sent).toHaveLength(2);
  });

  it('does not ask again right after a confirmation in the dialog', async () => {
    const handler = vi.fn(async () => {
      stepUpManager.markAuthenticated(Date.now() + 5 * 60 * 1000);
      return true;
    });
    stepUpManager.setHandler(handler);
    replies = [{ status: 'ERROR', error: 'REAUTH_REQUIRED' }, { status: 'OK' }];
    await connector.setPassword('a-long-password');
    // a request that was already in flight comes back with REAUTH_REQUIRED
    replies = [{ status: 'ERROR', error: 'REAUTH_REQUIRED' }, { status: 'OK' }];
    await connector.setPassword('a-long-password');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('leaves other errors alone', async () => {
    const handler = vi.fn(async () => true);
    stepUpManager.setHandler(handler);
    replies = [{ status: 'ERROR', error: 'LAST_LOGIN_METHOD' }];
    await expect(connector.setPassword('hunter2hunter2')).rejects.toThrow('LAST_LOGIN_METHOD');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('stepUpManager freshness', () => {
  it('is fresh after an authentication and not after clear()', () => {
    const now = 1_000_000;
    stepUpManager.markAuthenticated(now + 5 * 60 * 1000);
    expect(stepUpManager.isFresh(now)).toBe(true);
    expect(stepUpManager.isFresh(now + 5 * 60 * 1000)).toBe(false);
    stepUpManager.clear();
    expect(stepUpManager.isFresh(now)).toBe(false);
  });
});

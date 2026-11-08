// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Error mapping of the WebAuthn ceremonies: a cancelled or replaced ceremony
 * must stay silent, "already registered on this device" gets its own
 * message, everything else a clear one — and no browser failure may escape
 * as an unhandled rejection (every browser call sits inside a try).
 */

vi.mock('@simplewebauthn/browser', () => {
  class WebAuthnError extends Error {
    code: string;
    constructor({ message, code, cause, name }: { message: string; code: string; cause: Error; name?: string }) {
      super(message, { cause });
      this.name = name ?? cause.name;
      this.code = code;
    }
  }
  return {
    WebAuthnError,
    startRegistration: vi.fn(),
    startAuthentication: vi.fn(),
    browserSupportsWebAuthn: vi.fn(() => true),
    browserSupportsWebAuthnAutofill: vi.fn(async () => true),
    WebAuthnAbortService: { cancelCeremony: vi.fn(), createNewAbortSignal: vi.fn() },
  };
});

vi.mock('data/api/passkey', () => ({
  default: {
    registrationOptions: vi.fn(),
    verifyRegistration: vi.fn(),
    authenticationOptions: vi.fn(),
  },
}));

import * as browser from '@simplewebauthn/browser';
import passkeyApi from 'data/api/passkey';
import stepUpManager from './stepUp';
import {
  authenticateWithPasskey,
  passkeyErrorMessage,
  PasskeyCeremonyError,
  registerPasskey,
  signalAcceptedCredentials,
  toPasskeyCeremonyError,
} from './passkeyCeremony';

const { WebAuthnError } = browser as unknown as { WebAuthnError: new (o: { message: string; code: string; cause: Error; name?: string }) => Error };

function domError(name: string, message = name) {
  const e = new Error(message);
  e.name = name;
  return e;
}

beforeEach(() => {
  vi.mocked(passkeyApi.registrationOptions).mockReset().mockResolvedValue({ challenge: 'c' } as never);
  vi.mocked(passkeyApi.verifyRegistration).mockReset().mockResolvedValue({ status: 'pending' });
  vi.mocked(passkeyApi.authenticationOptions).mockReset().mockResolvedValue({ challenge: 'c', rpId: 'cg.test' } as never);
  vi.mocked(browser.startRegistration).mockReset();
  vi.mocked(browser.startAuthentication).mockReset();
});

describe('toPasskeyCeremonyError', () => {
  it.each([
    ['user dismissed the dialog (NotAllowedError passthrough)', new WebAuthnError({ message: 'x', code: 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY', cause: domError('NotAllowedError') })],
    ['replaced by another ceremony', new WebAuthnError({ message: 'x', code: 'ERROR_CEREMONY_ABORTED', cause: domError('AbortError') })],
    ['raw AbortError', domError('AbortError')],
    ['raw NotAllowedError', domError('NotAllowedError')],
  ])('%s is a silent cancel', (_label, error) => {
    const mapped = toPasskeyCeremonyError(error);
    expect(mapped.kind).toBe('cancelled');
    expect(mapped.silent).toBe(true);
    expect(passkeyErrorMessage(error)).toBeNull();
  });

  it('maps "already registered" to its own message', () => {
    const error = new WebAuthnError({ message: 'x', code: 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED', cause: domError('InvalidStateError') });
    const mapped = toPasskeyCeremonyError(error);
    expect(mapped.kind).toBe('already-registered');
    expect(mapped.message).toMatch(/already has a passkey/i);
  });

  it('maps a missing user verification to "unsupported"', () => {
    const error = new WebAuthnError({ message: 'x', code: 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT', cause: domError('ConstraintError') });
    expect(toPasskeyCeremonyError(error).kind).toBe('unsupported');
  });

  it('maps a server refusal to a clear message and keeps the code', () => {
    const mapped = toPasskeyCeremonyError(new Error('EMAIL_VERIFICATION_REQUIRED'));
    expect(mapped.kind).toBe('failed');
    expect(mapped.serverCode).toBe('EMAIL_VERIFICATION_REQUIRED');
    expect(mapped.message).toMatch(/verify your email/i);
    expect(toPasskeyCeremonyError(new Error('RATE_LIMIT_EXCEEDED')).message).toMatch(/too many/i);
  });

  it('gives anything unknown a generic but visible message', () => {
    const mapped = toPasskeyCeremonyError(new TypeError('boom'));
    expect(mapped.kind).toBe('failed');
    expect(passkeyErrorMessage(mapped)).toBeTruthy();
  });
});

describe('registerPasskey', () => {
  it('honors server-authorized registration without a general step-up, as after migration', async () => {
    stepUpManager.clear();
    const prompt = vi.fn(async () => false);
    stepUpManager.setHandler(prompt);
    try {
      vi.mocked(browser.startRegistration).mockResolvedValue({ id: 'migrated-key' } as never);
      vi.mocked(passkeyApi.verifyRegistration).mockResolvedValue({ status: 'attached', passkeys: [] });
      await expect(registerPasskey()).resolves.toMatchObject({ credentialId: 'migrated-key' });
      expect(prompt).not.toHaveBeenCalled();
    }
    finally { stepUpManager.setHandler(undefined); }
  });

  it('verifies the registration and returns the credential id', async () => {
    vi.mocked(browser.startRegistration).mockResolvedValue({ id: 'cred-1' } as never);
    const result = await registerPasskey({ displayName: 'alice' });
    expect(passkeyApi.registrationOptions).toHaveBeenCalledWith({ displayName: 'alice' });
    expect(passkeyApi.verifyRegistration).toHaveBeenCalledWith({ registrationResponse: { id: 'cred-1' } });
    expect(result).toEqual({ credentialId: 'cred-1', result: { status: 'pending' } });
  });

  it('turns a cancelled browser dialog into a silent PasskeyCeremonyError', async () => {
    vi.mocked(browser.startRegistration).mockRejectedValue(
      new WebAuthnError({ message: 'x', code: 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY', cause: domError('NotAllowedError') }),
    );
    const error = await registerPasskey().catch(e => e);
    expect(error).toBeInstanceOf(PasskeyCeremonyError);
    expect(error.silent).toBe(true);
    expect(passkeyApi.verifyRegistration).not.toHaveBeenCalled();
  });

  it('does not start the ceremony after a step-up dialog (a new click is needed)', async () => {
    stepUpManager.setHandler(async () => true);
    vi.mocked(passkeyApi.registrationOptions).mockImplementation(async () => {
      // BaseApiConnector: REAUTH_REQUIRED → dialog → retry
      await stepUpManager.request({ action: 'add a passkey', allowWallet: true }, 0);
      return { challenge: 'c' } as never;
    });
    try {
      const error = await registerPasskey().catch(e => e);
      expect(error.kind).toBe('reauthenticated');
      expect(browser.startRegistration).not.toHaveBeenCalled();
    }
    finally {
      stepUpManager.setHandler(undefined);
      stepUpManager.clear();
    }
  });

  it('does not start when beforeStart says no', async () => {
    const error = await registerPasskey({ beforeStart: () => false }).catch(e => e);
    expect(error.silent).toBe(true);
    expect(browser.startRegistration).not.toHaveBeenCalled();
  });

  it('also catches a failure fetching the options', async () => {
    vi.mocked(passkeyApi.registrationOptions).mockRejectedValue(new Error('REAUTH_REQUIRED'));
    const error = await registerPasskey().catch(e => e);
    expect(error).toBeInstanceOf(PasskeyCeremonyError);
    expect(error.serverCode).toBe('REAUTH_REQUIRED');
  });
});

describe('authenticateWithPasskey', () => {
  it('asks for conditional (autofill) login options only when requested', async () => {
    vi.mocked(browser.startAuthentication).mockResolvedValue({ id: 'cred-1' } as never);
    const result = await authenticateWithPasskey('login', { conditional: true });
    expect(passkeyApi.authenticationOptions).toHaveBeenCalledWith({ purpose: 'login', conditional: true });
    expect(vi.mocked(browser.startAuthentication).mock.calls[0][0]).toMatchObject({ useBrowserAutofill: true });
    expect(result.rpId).toBe('cg.test');

    await authenticateWithPasskey('stepup', { conditional: true });
    expect(passkeyApi.authenticationOptions).toHaveBeenLastCalledWith({ purpose: 'stepup' });
  });

  it('maps a replaced autofill request to a silent cancel', async () => {
    vi.mocked(browser.startAuthentication).mockRejectedValue(
      new WebAuthnError({ message: 'x', code: 'ERROR_CEREMONY_ABORTED', cause: domError('AbortError') }),
    );
    const error = await authenticateWithPasskey('login', { conditional: true }).catch(e => e);
    expect(error.silent).toBe(true);
  });
});

describe('signalAcceptedCredentials', () => {
  it('reports the credentials per user handle when the browser supports it', async () => {
    const signal = vi.fn(async () => undefined);
    (globalThis as any).PublicKeyCredential = { signalAllAcceptedCredentials: signal };
    try {
      await signalAcceptedCredentials('cg.test', [
        { userHandle: 'h1', credentialID: 'a' },
        { userHandle: 'h2', credentialID: 'b' },
        { userHandle: 'h1', credentialID: 'c' },
      ] as Models.Passkey.Info[]);
      expect(signal).toHaveBeenCalledWith({ rpId: 'cg.test', userId: 'h1', allAcceptedCredentialIds: ['a', 'c'] });
      expect(signal).toHaveBeenCalledWith({ rpId: 'cg.test', userId: 'h2', allAcceptedCredentialIds: ['b'] });
    }
    finally {
      delete (globalThis as any).PublicKeyCredential;
    }
  });

  it('does nothing without browser support', async () => {
    await expect(signalAcceptedCredentials('cg.test', [])).resolves.toBeUndefined();
  });
});

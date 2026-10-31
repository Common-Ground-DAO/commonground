// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/browser";
import errors from "common/errors";
import passkeyApi from "data/api/passkey";
import stepUpManager from "./stepUp";

/**
 * WebAuthn ceremonies against this instance's `Passkey` API
 * (docs/auth-identity §7). Every browser call sits inside a `try`; failures
 * leave here as a `PasskeyCeremonyError` whose `kind` tells the UI what to do:
 *
 * - `cancelled`: the user closed the browser dialog, it timed out, or another
 *   ceremony replaced this one — show nothing.
 * - `already-registered`: this authenticator already holds a passkey for the
 *   account (excludeCredentials matched).
 * - `unsupported`: the browser or authenticator cannot do what is required
 *   (no WebAuthn, no user verification, no discoverable credentials).
 * - `failed`: anything else, including server-side rejections (`serverCode`).
 * - `reauthenticated`: getting the options needed the "Confirm it's you"
 *   dialog. The ceremony was NOT started — after an async dialog the
 *   browser (Safari) may refuse it; the UI asks for a new click.
 */

export type PasskeyFailureKind = 'cancelled' | 'already-registered' | 'unsupported' | 'failed' | 'reauthenticated';

export class PasskeyCeremonyError extends Error {
  public readonly kind: PasskeyFailureKind;
  /** the server's error code, when the API refused */
  public readonly serverCode?: string;

  constructor(kind: PasskeyFailureKind, message: string, serverCode?: string) {
    super(message);
    this.name = 'PasskeyCeremonyError';
    this.kind = kind;
    this.serverCode = serverCode;
  }

  public get silent() {
    return this.kind === 'cancelled';
  }
}

const MESSAGES = {
  alreadyRegistered: "This device already has a passkey for your account.",
  noWebAuthn: "This browser doesn't support passkeys.",
  noUserVerification: "This authenticator can't be used here: it needs a PIN, fingerprint or face unlock.",
  noDiscoverable: "This authenticator can't store a passkey. Try your phone or your device's built-in passkey manager.",
  wrongDomain: "Passkeys aren't available on this address.",
  rateLimited: "Too many attempts. Please wait a few minutes and try again.",
  verifyFailed: "The passkey could not be verified. Please try again.",
  emailVerification: "Please verify your email address first.",
  generic: "Something went wrong with the passkey. Please try again.",
} as const;

const SERVER_CODES: ReadonlySet<string> = new Set(Object.values(errors.server));

function errorName(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'name' in e && typeof (e as any).name === 'string'
    ? (e as any).name
    : undefined;
}

/** Maps anything a ceremony can throw to a PasskeyCeremonyError. */
export function toPasskeyCeremonyError(e: unknown): PasskeyCeremonyError {
  if (e instanceof PasskeyCeremonyError) {
    return e;
  }
  const code: string | undefined = typeof e === 'object' && e !== null && 'code' in e ? String((e as any).code) : undefined;
  const cause = typeof e === 'object' && e !== null && 'cause' in e ? (e as any).cause : undefined;
  const name = errorName(cause) || errorName(e);
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : '';

  // server refusals come through BaseApiConnector as Error(<code>)
  if (message && SERVER_CODES.has(message)) {
    if (message === errors.server.RATE_LIMIT_EXCEEDED) {
      return new PasskeyCeremonyError('failed', MESSAGES.rateLimited, message);
    }
    if (message === errors.server.EMAIL_VERIFICATION_REQUIRED) {
      return new PasskeyCeremonyError('failed', MESSAGES.emailVerification, message);
    }
    return new PasskeyCeremonyError('failed', MESSAGES.verifyFailed, message);
  }

  switch (code) {
    case 'ERROR_CEREMONY_ABORTED':
      return new PasskeyCeremonyError('cancelled', 'cancelled');
    case 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED':
      return new PasskeyCeremonyError('already-registered', MESSAGES.alreadyRegistered);
    case 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT':
    case 'ERROR_AUTO_REGISTER_USER_VERIFICATION_FAILURE':
      return new PasskeyCeremonyError('unsupported', MESSAGES.noUserVerification);
    case 'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT':
      return new PasskeyCeremonyError('unsupported', MESSAGES.noDiscoverable);
    case 'ERROR_INVALID_DOMAIN':
    case 'ERROR_INVALID_RP_ID':
      return new PasskeyCeremonyError('failed', MESSAGES.wrongDomain);
  }

  switch (name) {
    // the user dismissed the dialog or it timed out; browsers deliberately
    // don't tell which
    case 'NotAllowedError':
    case 'AbortError':
      return new PasskeyCeremonyError('cancelled', 'cancelled');
    case 'InvalidStateError':
      return new PasskeyCeremonyError('already-registered', MESSAGES.alreadyRegistered);
    case 'SecurityError':
      return new PasskeyCeremonyError('failed', MESSAGES.wrongDomain);
  }

  if (/WebAuthn is not supported|does not support WebAuthn autofill/i.test(message)) {
    return new PasskeyCeremonyError('unsupported', MESSAGES.noWebAuthn);
  }
  return new PasskeyCeremonyError('failed', MESSAGES.generic);
}

/** null when the failure should not be shown (cancelled) */
export function passkeyErrorMessage(e: unknown): string | null {
  const error = toPasskeyCeremonyError(e);
  return error.silent ? null : error.message;
}

export function passkeysSupported(): boolean {
  try {
    return browserSupportsWebAuthn();
  }
  catch {
    return false;
  }
}

export async function passkeyAutofillSupported(): Promise<boolean> {
  try {
    return passkeysSupported() && await browserSupportsWebAuthnAutofill();
  }
  catch {
    return false;
  }
}

/** Whether the browser can create a passkey silently after a password login. */
export async function passkeyAutoRegisterSupported(): Promise<boolean> {
  try {
    const pkc = (globalThis as any).PublicKeyCredential;
    if (!passkeysSupported() || typeof pkc?.getClientCapabilities !== 'function') {
      return false;
    }
    const capabilities = await pkc.getClientCapabilities();
    return capabilities?.conditionalCreate === true;
  }
  catch {
    return false;
  }
}

/** Cancels whatever ceremony is running (e.g. a pending autofill request). */
export function abortPasskeyCeremony() {
  try {
    WebAuthnAbortService.cancelCeremony();
  }
  catch {
    // nothing running
  }
}

export type RegisteredPasskey = {
  /** credential id of the new passkey (base64url) */
  credentialId: string;
  result: API.Passkey.verifyRegistration.Response;
};

/**
 * Creates a passkey: options from the server, the browser ceremony, then
 * verification. Logged out (sign-up) the passkey waits in the session for
 * User/createUser; logged in it is attached to the account.
 */
export async function registerPasskey(options: {
  /** sign-up only: the profile name the passkey is labelled with */
  displayName?: string;
  /** label; the server defaults to browser and OS */
  name?: string;
  /** conditional create right after a password login (no dialog) */
  useAutoRegister?: boolean;
  /** checked right before the browser ceremony starts; false = give up silently */
  beforeStart?: () => boolean;
} = {}): Promise<RegisteredPasskey> {
  try {
    const confirmationsBefore = stepUpManager.confirmations;
    const optionsJSON = await passkeyApi.registrationOptions(
      options.displayName ? { displayName: options.displayName } : {}
    );
    if (stepUpManager.confirmations !== confirmationsBefore) {
      throw new PasskeyCeremonyError('reauthenticated', "Confirmed. Now create the passkey.");
    }
    if (options.beforeStart && !options.beforeStart()) {
      throw new PasskeyCeremonyError('cancelled', 'cancelled');
    }
    const registrationResponse = await startRegistration({
      optionsJSON,
      useAutoRegister: options.useAutoRegister === true,
    });
    const result = await passkeyApi.verifyRegistration({
      registrationResponse,
      ...(options.name ? { name: options.name } : {}),
    });
    return { credentialId: registrationResponse.id, result };
  }
  catch (e) {
    throw toPasskeyCeremonyError(e);
  }
}

/**
 * Gets an assertion for `User/login {type:'passkey'}` (purpose login) or
 * `User/reauthenticate {type:'passkey'}` (purpose stepup). `conditional`
 * arms the browser's autofill on an `autocomplete="… webauthn"` input
 * instead of opening a dialog; it resolves once the user picks a passkey.
 */
export async function authenticateWithPasskey(
  purpose: 'login' | 'stepup',
  options: {
    conditional?: boolean;
    /** checked right before the browser ceremony starts; false = give up silently */
    beforeStart?: () => boolean;
  } = {},
): Promise<{ response: AuthenticationResponseJSON; rpId: string | undefined }> {
  try {
    const conditional = purpose === 'login' && options.conditional === true;
    const optionsJSON = await passkeyApi.authenticationOptions({
      purpose,
      ...(conditional ? { conditional: true } : {}),
    });
    if (options.beforeStart && !options.beforeStart()) {
      throw new PasskeyCeremonyError('cancelled', 'cancelled');
    }
    const response = await startAuthentication({
      optionsJSON,
      useBrowserAutofill: conditional,
    });
    return { response, rpId: optionsJSON.rpId };
  }
  catch (e) {
    throw toPasskeyCeremonyError(e);
  }
}

// --- Signal API (https://w3c.github.io/webauthn/#sctn-signal-methods) -------
// Lets the browser's passkey manager hide credentials the server no longer
// knows and keep names current. Every call is optional and best-effort.

type SignalCapablePublicKeyCredential = {
  signalUnknownCredential?: (options: { rpId: string; credentialId: string }) => Promise<void>;
  signalAllAcceptedCredentials?: (options: { rpId: string; userId: string; allAcceptedCredentialIds: string[] }) => Promise<void>;
  signalCurrentUserDetails?: (options: { rpId: string; userId: string; name: string; displayName: string }) => Promise<void>;
};

function signalApi(): SignalCapablePublicKeyCredential | undefined {
  try {
    return (globalThis as any).PublicKeyCredential as SignalCapablePublicKeyCredential | undefined;
  }
  catch {
    return undefined;
  }
}

/** the server does not know this credential (deleted, or a sign-up that never finished) */
export async function signalUnknownCredential(rpId: string | null | undefined, credentialId: string) {
  const api = signalApi();
  if (!rpId || typeof api?.signalUnknownCredential !== 'function') {
    return;
  }
  try {
    await api.signalUnknownCredential({ rpId, credentialId });
  }
  catch (e) {
    console.warn("signalUnknownCredential failed", e);
  }
}

/** the complete list of this account's passkeys on this RP, per user handle */
export async function signalAcceptedCredentials(rpId: string | null | undefined, passkeys: Models.Passkey.Info[]) {
  const api = signalApi();
  if (!rpId || typeof api?.signalAllAcceptedCredentials !== 'function') {
    return;
  }
  const byHandle = new Map<string, string[]>();
  for (const passkey of passkeys) {
    if (!passkey.userHandle) {
      continue;
    }
    byHandle.set(passkey.userHandle, [...(byHandle.get(passkey.userHandle) || []), passkey.credentialID]);
  }
  for (const [userId, allAcceptedCredentialIds] of byHandle) {
    try {
      await api.signalAllAcceptedCredentials({ rpId, userId, allAcceptedCredentialIds });
    }
    catch (e) {
      console.warn("signalAllAcceptedCredentials failed", e);
    }
  }
}

export async function signalUserDetails(
  rpId: string | null | undefined,
  passkeys: Models.Passkey.Info[],
  details: { name: string; displayName: string },
) {
  const api = signalApi();
  if (!rpId || typeof api?.signalCurrentUserDetails !== 'function') {
    return;
  }
  const handles = new Set(passkeys.map(passkey => passkey.userHandle).filter(Boolean));
  for (const userId of handles) {
    try {
      await api.signalCurrentUserDetails({ rpId, userId, name: details.name, displayName: details.displayName });
    }
    catch (e) {
      console.warn("signalCurrentUserDetails failed", e);
    }
  }
}

/**
 * Identity & session flows.
 *
 * Contract: srv/api/user.ts (createUser, login, logout, checkLoginStatus,
 * getSignableSecret), srv/repositories/device.ts (signature verification),
 * srv/util/captcha.ts (registration captcha). Sessions are cookies (12h,
 * rolling); login/createUser also mint the device row that signature-based
 * flows (HTTP device login, socket login, protoo login) authenticate against.
 */

import type { HttpTransport } from "../transport/http.js";
import { DeviceKey, type DeviceCurve } from "../identity/deviceKey.js";
import { obtainCaptchaToken } from "../captcha/altcha.js";
import type {
  CreateUserRequest,
  LoginResponse,
  PasskeyAuthenticationResponse,
  PasskeyCreationOptions,
  PasskeyInfo,
  PasskeyRegistrationResponse,
  PasskeyRequestOptions,
  PasskeyVerifyRegistrationResult,
} from "./types.js";

export interface RegisterOptions {
  /** account address; on instances that send mail it must be verified first */
  email?: string;
  /** password sign-in (omit for a passkey-only account) */
  password?: string;
  /** use the passkey registered in this session (passkeyVerifyRegistration) */
  usePreparedPasskey?: boolean;
  /** cg profile name, /^[a-z0-9_-]{3,30}$/i */
  displayName: string;
  /** device curve; P-384 = web parity, P-256 = Secure-Enclave parity */
  curve?: DeviceCurve;
  /** supply a pre-generated key (e.g. imported); default: generate fresh */
  deviceKey?: DeviceKey;
  /** pre-solved captcha token; default: solve an ALTCHA challenge natively */
  captchaToken?: string;
}

export interface AuthSession {
  response: LoginResponse;
  deviceId: string;
  deviceKey: DeviceKey;
}

export class AuthApi {
  constructor(private readonly transport: HttpTransport) {}

  /**
   * POST /User/createUser — registration with a cg profile, signing in with a
   * password and/or the passkey registered during this sign-up.
   * Solves the instance's ALTCHA challenge natively unless a token is given.
   * On success the server logs the new user in (session cookie in the jar).
   */
  async register(options: RegisterOptions): Promise<AuthSession> {
    const deviceKey = options.deviceKey ?? (await DeviceKey.generate(options.curve ?? "P-384"));
    const captchaToken = options.captchaToken ?? (await obtainCaptchaToken(this.transport));
    const body: CreateUserRequest = {
      displayAccount: "cg",
      recaptchaToken: captchaToken,
      device: { publicKey: deviceKey.publicJwk },
      ...(options.email !== undefined && options.password !== undefined
        ? { useEmailAndPassword: { email: options.email, password: options.password } }
        : {}),
      ...(options.usePreparedPasskey ? { usePreparedPasskey: true } : {}),
      useCgProfile: {
        type: "cg",
        displayName: options.displayName,
        imageId: null,
        extraData: { type: "cg", description: "", homepage: "", links: [] },
      },
    };
    const response = await this.transport.call<LoginResponse>("User/createUser", body);
    return { response, deviceId: response.deviceId, deviceKey };
  }

  /**
   * POST /User/login type=password. Password login registers the supplied
   * public key as a NEW device; keep the returned deviceId with the key —
   * that pair is the identity for all signature-based logins afterwards.
   */
  async loginWithPassword(
    aliasOrEmail: string,
    password: string,
    deviceKey?: DeviceKey,
    curve: DeviceCurve = "P-384",
  ): Promise<AuthSession> {
    const key = deviceKey ?? (await DeviceKey.generate(curve));
    const response = await this.transport.call<LoginResponse>("User/login", {
      type: "password",
      aliasOrEmail,
      password,
      device: { publicKey: key.publicJwk },
    });
    return { response, deviceId: response.deviceId, deviceKey: key };
  }

  /** POST /User/getSignableSecret — 20-char secret bound to this session. */
  async getSignableSecret(): Promise<string> {
    return this.transport.call<string>("User/getSignableSecret");
  }

  /**
   * POST /User/login type=device — cryptographic re-login with an existing
   * (deviceId, key) pair: fetch the session's signable secret, sign its
   * UTF-8 bytes (ECDSA P1363, hash by curve), send back base64.
   */
  async loginWithDevice(deviceId: string, deviceKey: DeviceKey): Promise<AuthSession> {
    const secret = await this.getSignableSecret();
    const base64Signature = await deviceKey.signSecret(secret);
    const response = await this.transport.call<LoginResponse>("User/login", {
      type: "device",
      deviceId,
      secret,
      base64Signature,
    });
    return { response, deviceId: response.deviceId, deviceKey };
  }

  /**
   * POST /User/requestSignupEmailCode — step 1 of sign-up on instances that
   * send mail: a 6-digit code goes to `email` (EMAIL_DISABLED otherwise).
   * The sign-up captcha is checked here (CAPTCHA_FAILED); a resend to the same
   * address in the same session needs no new token, and createUser after the
   * verified code needs none at all.
   */
  async requestSignupEmailCode(email: string, recaptchaToken?: string): Promise<void> {
    await this.transport.call("User/requestSignupEmailCode", recaptchaToken ? { email, recaptchaToken } : { email });
  }

  /** POST /User/verifySignupEmailCode — binds the verified address to this session's sign-up. */
  async verifySignupEmailCode(email: string, code: string): Promise<void> {
    await this.transport.call("User/verifySignupEmailCode", { email, code });
  }

  /**
   * POST /Passkey/registrationOptions — logged out: options for the sign-up
   * passkey (`displayName` labels it); logged in: for adding a passkey (needs a
   * recent authentication, REAUTH_REQUIRED otherwise).
   */
  async passkeyRegistrationOptions(displayName?: string): Promise<PasskeyCreationOptions> {
    return this.transport.call("Passkey/registrationOptions", displayName === undefined ? {} : { displayName });
  }

  /** POST /Passkey/verifyRegistration — attaches the passkey, or keeps it for createUser while logged out. */
  async passkeyVerifyRegistration(registrationResponse: PasskeyRegistrationResponse, name?: string): Promise<PasskeyVerifyRegistrationResult> {
    return this.transport.call("Passkey/verifyRegistration", name === undefined ? { registrationResponse } : { registrationResponse, name });
  }

  /**
   * POST /Passkey/authenticationOptions — `login`: discoverable credentials
   * (empty allowCredentials); `stepup`: the session user's credentials.
   */
  async passkeyAuthenticationOptions(purpose: "login" | "stepup", conditional = false): Promise<PasskeyRequestOptions> {
    return this.transport.call("Passkey/authenticationOptions", conditional ? { purpose, conditional } : { purpose });
  }

  /** POST /User/login type=passkey — verifies the assertion and logs in; registers a NEW device. */
  async loginWithPasskey(
    authenticationResponse: PasskeyAuthenticationResponse,
    deviceKey?: DeviceKey,
    curve: DeviceCurve = "P-384",
  ): Promise<AuthSession> {
    const key = deviceKey ?? (await DeviceKey.generate(curve));
    const response = await this.transport.call<LoginResponse>("User/login", {
      type: "passkey",
      authenticationResponse,
      device: { publicKey: key.publicJwk },
    });
    return { response, deviceId: response.deviceId, deviceKey: key };
  }

  /**
   * POST /User/reauthenticate — re-proves control of the account so that
   * sensitive actions (REAUTH_REQUIRED) are allowed for the next minutes.
   * Returns the epoch ms until which they are.
   */
  async reauthenticateWithPassword(password: string): Promise<number> {
    const { validUntil } = await this.transport.call<{ validUntil: number }>("User/reauthenticate", { type: "password", password });
    return validUntil;
  }

  async reauthenticateWithPasskey(authenticationResponse: PasskeyAuthenticationResponse): Promise<number> {
    const { validUntil } = await this.transport.call<{ validUntil: number }>("User/reauthenticate", { type: "passkey", authenticationResponse });
    return validUntil;
  }

  /** after a fresh User/prepareWalletAction of one of the account's login wallets */
  async reauthenticateWithWallet(): Promise<number> {
    const { validUntil } = await this.transport.call<{ validUntil: number }>("User/reauthenticate", { type: "wallet" });
    return validUntil;
  }

  /** POST /Passkey/list — the session user's passkeys on this instance. */
  async listPasskeys(): Promise<PasskeyInfo[]> {
    return this.transport.call("Passkey/list");
  }

  async renamePasskey(id: string, name: string): Promise<void> {
    await this.transport.call("Passkey/rename", { id, name });
  }

  /** needs a recent authentication; LAST_LOGIN_METHOD if nothing else could sign in */
  async removePasskey(id: string): Promise<void> {
    await this.transport.call("Passkey/remove", { id });
  }

  /** POST /User/ensureSession — keepalive for the rolling session cookie. */
  async ensureSession(): Promise<void> {
    await this.transport.call("User/ensureSession");
  }

  /** POST /User/checkLoginStatus → the session's userId, or null. */
  async checkLoginStatus(): Promise<{ userId: string | null }> {
    return this.transport.call("User/checkLoginStatus");
  }

  /**
   * POST /User/logout — de-authenticates the session AND soft-deletes the
   * current device; a deviceId does not survive logout.
   */
  async logout(): Promise<void> {
    await this.transport.call("User/logout");
  }
}

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
import type { CreateUserRequest, LoginResponse } from "./types.js";

export interface RegisterOptions {
  email: string;
  password: string;
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
   * POST /User/createUser — email+password registration with a cg profile.
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
      useEmailAndPassword: { email: options.email, password: options.password },
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

/**
 * R1 — identity & session lifecycle.
 *
 * Contract: srv/api/user.ts createUser/login/logout/checkLoginStatus/
 * getSignableSecret/reauthenticate; srv/repositories/device.ts
 * verifyDeviceAndGetUserId (ECDSA over utf8(secret), P1363 base64, hash by
 * stored curve — P-256→SHA-256, P-384→SHA-384); srv/validators/common.ts
 * JsonWebKey (P-256 | P-384 both valid since PR #45); srv/api/passkeys.ts +
 * srv/util/passkeys.ts (passkeys on the instance origin, driven by a software
 * authenticator); srv/util/authSession.ts (step-up).
 */

import { describe, expect, it } from "vitest";
import { CommonGroundClient, DeviceKey } from "@commonground/client";
import { BASE_URL } from "./env.js";
import { MUTATIONS_ENABLED, newClient, registerUser, TEST_PASSWORD, uniqueName } from "./fixtures.js";
import { SoftAuthenticator } from "./softAuthenticator.js";

describe.runIf(MUTATIONS_ENABLED)("Identity & sessions", () => {
  it("registers with a P-384 device key and is logged in (cookie session)", async () => {
    const { client, session } = await registerUser("p384");
    expect(session.response.ownData.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.response.ownData.emailVerified).toBe(false);
    expect(session.response.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.response.communities).toEqual([]);
    // The createUser response IS the login response: session cookie is live.
    const status = await client.auth.checkLoginStatus();
    expect(status.userId).toBe(session.response.ownData.id);
  });

  it("registers with a P-256 device key (Secure-Enclave stand-in)", async () => {
    const { client, session } = await registerUser("p256", "P-256");
    expect(session.deviceKey.curve).toBe("P-256");
    const status = await client.auth.checkLoginStatus();
    expect(status.userId).toBe(session.response.ownData.id);
  });

  it("password login authenticates and mints a NEW device", async () => {
    const { session } = await registerUser("pwlogin");
    const alias = session.response.ownData.accounts[0].displayName!;

    const fresh = newClient();
    const loggedIn = await fresh.auth.loginWithPassword(alias, TEST_PASSWORD);
    expect(loggedIn.response.ownData.id).toBe(session.response.ownData.id);
    // Contract: password login registers the supplied key as a new device.
    expect(loggedIn.deviceId).not.toBe(session.deviceId);
  });

  it("password login works with the email as alias", async () => {
    const { session } = await registerUser("pwemail");
    const fresh = newClient();
    const loggedIn = await fresh.auth.loginWithPassword(
      session.response.ownData.email!,
      TEST_PASSWORD,
    );
    expect(loggedIn.response.ownData.id).toBe(session.response.ownData.id);
  });

  it("wrong password is NOT_ALLOWED", async () => {
    const { session } = await registerUser("pwbad");
    const fresh = newClient();
    await expect(
      fresh.auth.loginWithPassword(session.response.ownData.email!, "wrong-password-1!A"),
    ).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  });

  for (const curve of ["P-384", "P-256"] as const) {
    it(`device-signature login round-trips (${curve})`, async () => {
      const { session } = await registerUser(`dev${curve.slice(2)}`, curve);
      const fresh = newClient();
      const loggedIn = await fresh.auth.loginWithDevice(session.deviceId, session.deviceKey);
      expect(loggedIn.response.ownData.id).toBe(session.response.ownData.id);
      // Device login re-uses the SAME device row (unlike password login).
      expect(loggedIn.deviceId).toBe(session.deviceId);
    });
  }

  it("a signature from the wrong key is INVALID_SIGNATURE", async () => {
    const { session } = await registerUser("badsig");
    const fresh = newClient();
    const wrongKey = await DeviceKey.generate("P-384");
    await expect(
      fresh.auth.loginWithDevice(session.deviceId, wrongKey),
    ).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
  });

  it("a secret the session never issued is INVALID_SECRET", async () => {
    const { session } = await registerUser("badsecret");
    const fresh = new CommonGroundClient({ baseUrl: BASE_URL });
    // Skip getSignableSecret: sign an arbitrary 20-char string instead.
    const madeUpSecret = "aaaaaaaaaaaaaaaaaaaa";
    const base64Signature = await session.deviceKey.signSecret(madeUpSecret);
    await expect(
      fresh.transport.call("User/login", {
        type: "device",
        deviceId: session.deviceId,
        secret: madeUpSecret,
        base64Signature,
      }),
    ).rejects.toMatchObject({ code: "INVALID_SECRET" });
  });

  it("logout ends the session and soft-deletes the device", async () => {
    const { client, session } = await registerUser("logout");
    await client.auth.logout();
    expect((await client.auth.checkLoginStatus()).userId).toBeNull();
    // The device died with the logout: signature login must now fail.
    const fresh = newClient();
    await expect(
      fresh.auth.loginWithDevice(session.deviceId, session.deviceKey),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("unauthenticated protected calls are LOGIN_REQUIRED with HTTP 200", async () => {
    const fresh = newClient();
    await expect(fresh.transport.call("Chat/getChats")).rejects.toMatchObject({
      code: "LOGIN_REQUIRED",
      httpStatus: 200,
    });
  });

  it("malformed request bodies are VALIDATION", async () => {
    const fresh = newClient();
    await expect(
      fresh.transport.call("User/login", { type: "password", nonsense: true }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe.runIf(MUTATIONS_ENABLED)("Passkeys on the instance origin", async () => {
  const config = await new CommonGroundClient({ baseUrl: BASE_URL }).getInstanceConfig();
  const enabled = config.features?.passkeys === true;
  // the origin the browser would report: the instance's own appUrl
  const origin = config.appUrl ? new URL(config.appUrl).origin : BASE_URL;

  async function signUpWithPasskey(tag: string) {
    const client = newClient();
    const authenticator = new SoftAuthenticator();
    const displayName = uniqueName(tag);
    const options = await client.auth.passkeyRegistrationOptions(displayName);
    const pending = await client.auth.passkeyVerifyRegistration(authenticator.createCredential(options, origin));
    const session = await client.auth.register({ displayName, usePreparedPasskey: true });
    return { client, authenticator, options, pending, session };
  }

  it.runIf(enabled)("signs up with a passkey (no password) and logs in with it", async () => {
    const { options, pending, session, authenticator } = await signUpWithPasskey("pk");
    expect(options.rp.id).toBe(config.passkeyRpId);
    expect(options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    expect(pending).toEqual({ status: "pending" });
    expect(session.response.ownData.passkeys).toHaveLength(1);

    const fresh = newClient();
    const login = await fresh.auth.passkeyAuthenticationOptions("login");
    // discoverable credentials only: nobody's credential ids are handed out
    expect(login.allowCredentials ?? []).toEqual([]);
    const loggedIn = await fresh.auth.loginWithPasskey(authenticator.getAssertion(login, origin));
    expect(loggedIn.response.ownData.id).toBe(session.response.ownData.id);
    expect((await fresh.auth.checkLoginStatus()).userId).toBe(session.response.ownData.id);
  });

  it.runIf(enabled)("an assertion for another RP ID or from another origin is refused", async () => {
    const { authenticator } = await signUpWithPasskey("pkrp");
    const fresh = newClient();
    const wrongRp = await fresh.auth.passkeyAuthenticationOptions("login");
    await expect(
      fresh.auth.loginWithPasskey(authenticator.getAssertion(wrongRp, origin, { rpId: "id.app.cg" })),
    ).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
    const wrongOrigin = await fresh.auth.passkeyAuthenticationOptions("login");
    await expect(
      fresh.auth.loginWithPasskey(authenticator.getAssertion(wrongOrigin, "https://evil.example")),
    ).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
    expect((await fresh.auth.checkLoginStatus()).userId).toBeNull();
  });

  it.runIf(enabled)("a challenge cannot be answered twice", async () => {
    const { authenticator } = await signUpWithPasskey("pkreplay");
    const fresh = newClient();
    const login = await fresh.auth.passkeyAuthenticationOptions("login");
    const assertion = authenticator.getAssertion(login, origin);
    await fresh.auth.loginWithPasskey(assertion);
    const other = newClient();
    await expect(other.auth.loginWithPasskey(assertion)).rejects.toMatchObject({ code: "INVALID_SECRET" });
  });

  it.runIf(enabled)("anonymous login options take no user id", async () => {
    await expect(
      newClient().transport.call("Passkey/authenticationOptions", { purpose: "login", userId: "00000000-0000-4000-8000-000000000001" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("setPassword needs a recent authentication: REAUTH_REQUIRED, reauthenticate, retry", async () => {
    const { session } = await registerUser("stepup");
    // a device-key login is not an interactive authentication
    const fresh = newClient();
    await fresh.auth.loginWithDevice(session.deviceId, session.deviceKey);
    await expect(fresh.profile.setPassword("Conformance-2!bC")).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    await expect(fresh.auth.reauthenticateWithPassword("not-the-password")).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    const validUntil = await fresh.auth.reauthenticateWithPassword(TEST_PASSWORD);
    expect(validUntil).toBeGreaterThan(Date.now());
    await fresh.profile.setPassword("Conformance-2!bC");
    const again = newClient();
    const loggedIn = await again.auth.loginWithPassword(session.response.ownData.email!, "Conformance-2!bC");
    expect(loggedIn.response.ownData.id).toBe(session.response.ownData.id);
  });

  it("the session keepalive is User/ensureSession", async () => {
    await expect(newClient().auth.ensureSession()).resolves.toBeUndefined();
  });
});

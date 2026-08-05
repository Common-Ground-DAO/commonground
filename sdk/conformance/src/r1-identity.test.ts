/**
 * R1 — identity & session lifecycle.
 *
 * Contract: srv/api/user.ts createUser/login/logout/checkLoginStatus/
 * getSignableSecret; srv/repositories/device.ts verifyDeviceAndGetUserId
 * (ECDSA over utf8(secret), P1363 base64, hash by stored curve —
 * P-256→SHA-256, P-384→SHA-384); srv/validators/common.ts JsonWebKey
 * (P-256 | P-384 both valid since PR #45).
 */

import { describe, expect, it } from "vitest";
import { CommonGroundClient, DeviceKey } from "@commonground/client";
import { BASE_URL } from "./env.js";
import { MUTATIONS_ENABLED, newClient, registerUser, TEST_PASSWORD } from "./fixtures.js";

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

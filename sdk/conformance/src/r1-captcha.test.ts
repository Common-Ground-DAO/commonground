/**
 * R1 — captcha (registration spam protection).
 *
 * Contract: GET /Captcha/config + /Captcha/challenge (srv/api/captcha.ts),
 * ALTCHA v2 verify path srv/util/captcha.ts (deterministic PBKDF2 PoW,
 * HMAC-signed parameters, single-use via Redis SET NX on the signature,
 * 10-min expiry). Tokens ride the `recaptchaToken` field of createUser.
 */

import { describe, expect, it } from "vitest";
import {
  ApiError,
  buildCaptchaToken,
  fetchAltchaChallenge,
  fetchCaptchaConfig,
  solveAltchaChallenge,
} from "@commonground/client";
import { MUTATIONS_ENABLED, newClient, registerUser, TEST_PASSWORD, uniqueEmail, uniqueName } from "./fixtures.js";

describe("Captcha", () => {
  const client = newClient();

  it("config declares the provider (bare JSON, no envelope)", async () => {
    const config = await fetchCaptchaConfig(client.transport);
    expect(["altcha", "recaptcha", "off"]).toContain(config.provider);
  });

  it("challenge is ALTCHA v2 and natively solvable", async (ctx) => {
    const config = await fetchCaptchaConfig(client.transport);
    if (config.provider !== "altcha") return ctx.skip();

    const challenge = await fetchAltchaChallenge(client.transport);
    expect(challenge.parameters.algorithm).toBe("PBKDF2/SHA-256");
    expect(challenge.parameters.nonce).toMatch(/^[0-9a-f]+$/);
    expect(challenge.parameters.salt).toMatch(/^[0-9a-f]+$/);
    expect(challenge.parameters.cost).toBeGreaterThan(0);
    expect(challenge.parameters.keyPrefix).toMatch(/^[0-9a-f]+$/);
    expect(challenge.signature).toMatch(/^[0-9a-f]+$/);
    // expiresAt is unix seconds within the 10-min TTL window
    expect(challenge.parameters.expiresAt).toBeGreaterThan(Date.now() / 1000);
    expect(challenge.parameters.expiresAt).toBeLessThanOrEqual(Date.now() / 1000 + 601);

    const solution = await solveAltchaChallenge(challenge);
    expect(solution).not.toBeNull();
    expect(solution!.derivedKey.startsWith(challenge.parameters.keyPrefix)).toBe(true);
  });

  it.runIf(MUTATIONS_ENABLED)("replayed token is rejected (single-use)", async () => {
    // First use succeeds via a full registration; the identical token on a
    // second registration must fail CAPTCHA_FAILED (Redis SET NX replay lock).
    const { client: first } = await registerUser("replay");
    void first;

    const fresh = newClient();
    const challenge = await fetchAltchaChallenge(fresh.transport);
    const solution = await solveAltchaChallenge(challenge);
    const token = buildCaptchaToken(challenge, solution!);

    await fresh.auth.register({
      email: uniqueEmail("replay1"),
      password: TEST_PASSWORD,
      displayName: uniqueName("replay1"),
      captchaToken: token,
    });

    const second = newClient();
    await expect(
      second.auth.register({
        email: uniqueEmail("replay2"),
        password: TEST_PASSWORD,
        displayName: uniqueName("replay2"),
        captchaToken: token,
      }),
    ).rejects.toMatchObject(new ApiError("CAPTCHA_FAILED", "User/createUser", 200));
  });

  it.runIf(MUTATIONS_ENABLED)("tampered challenge parameters are rejected", async () => {
    const fresh = newClient();
    const challenge = await fetchAltchaChallenge(fresh.transport);
    // Solve honestly, then stretch expiresAt by an hour before submitting.
    // The PoW still verifies — only the HMAC over the canonical parameters
    // can catch the edit, which is exactly what this test pins down.
    const solution = await solveAltchaChallenge(challenge);
    const tampered = {
      parameters: { ...challenge.parameters, expiresAt: challenge.parameters.expiresAt! + 3600 },
      signature: challenge.signature,
    };
    const token = buildCaptchaToken(tampered, solution!);
    await expect(
      fresh.auth.register({
        email: uniqueEmail("tamper"),
        password: TEST_PASSWORD,
        displayName: uniqueName("tamper"),
        captchaToken: token,
      }),
    ).rejects.toMatchObject({ code: "CAPTCHA_FAILED" });
  });

  it.runIf(MUTATIONS_ENABLED)("garbage token is rejected", async () => {
    const fresh = newClient();
    await expect(
      fresh.auth.register({
        email: uniqueEmail("garbage"),
        password: TEST_PASSWORD,
        displayName: uniqueName("garbage"),
        captchaToken: Buffer.from("{}").toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "CAPTCHA_FAILED" });
  });
});

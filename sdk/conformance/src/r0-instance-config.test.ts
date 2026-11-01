/**
 * R0 — instance identity.
 *
 * Contract: GET /api/v2/Instance/config (srv/api/instance.ts) returns the
 * InstanceConfig object (src/common/instance.ts) as bare JSON — the same
 * shape the web app gets injected as window.__CG_INSTANCE__. Public,
 * unauthenticated, Cache-Control: no-store.
 */

import { describe, expect, it } from "vitest";
import { CommonGroundClient } from "@commonground/client";
import { BASE_URL } from "./env.js";

describe("Instance/config", () => {
  const client = new CommonGroundClient({ baseUrl: BASE_URL });

  it("is public and returns the InstanceConfig shape", async () => {
    const config = await client.getInstanceConfig();

    // Required-by-construction fields (buildInstanceConfig always sets them).
    expect(config.deployment).toMatch(/^(prod|staging|dev)$/);
    expect(config.appUrl).toMatch(/^https?:\/\/[^/]+/);
    expect(config.appUrl).not.toMatch(/\/$/);
    expect(["altcha", "recaptcha", "off"]).toContain(config.captchaProvider);

    // Passkeys: either on this origin (features.passkeys + the RP ID, no CG ID
    // app), or — legacy CG ID (gateway) instances only — on the CG ID app.
    if (config.cgidUrl === undefined) {
      expect(config.features?.passkeys).toBe(true);
      const appHost = new URL(config.appUrl!).hostname;
      expect(typeof config.passkeyRpId).toBe("string");
      // the RP ID is the app host or a parent domain of it
      expect(appHost === config.passkeyRpId || appHost.endsWith(`.${config.passkeyRpId}`)).toBe(true);
    } else {
      expect(config.cgidUrl).toContain("#");
      expect(config.features?.passkeys).not.toBe(true);
      expect(config.passkeyRpId).toBeUndefined();
    }

    // Optional fields must have the right type when present.
    if (config.activeChains !== undefined) {
      expect(Array.isArray(config.activeChains)).toBe(true);
      for (const chain of config.activeChains) {
        expect(chain).toMatch(/^[a-z0-9_]+$/);
      }
    }
    if (config.features !== undefined) {
      for (const key of Object.keys(config.features)) {
        expect(["email", "twitterAuth", "calls", "imageFilter", "passkeys"]).toContain(key);
        expect(typeof config.features[key as keyof typeof config.features]).toBe("boolean");
      }
    }

    // No unexpected keys: the endpoint mirrors InstanceConfig exactly.
    const allowed = new Set([
      "deployment", "appUrl", "cgidUrl", "passkeyRpId", "recaptchaSiteKey", "captchaProvider",
      "activeChains", "features", "imageFilterThreshold", "giphyApiKey", "walletConnectProjectId",
    ]);
    for (const key of Object.keys(config)) {
      expect(allowed, `unexpected field ${key} — SDK InstanceConfig mirror is stale`).toContain(key);
    }
  });

  it("is served with no-store caching", async () => {
    const response = await fetch(`${BASE_URL}/api/v2/Instance/config`);
    expect(response.status).toBe(200);
    // The app sets no-store; the edge's no-cache on API routes is only a
    // default for responses without their own (older nginx edges appended it,
    // giving "no-store, no-cache"). Assert the contract-relevant part: the
    // response is marked non-storable.
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("matches the config the web app gets", async () => {
    // The endpoint and the web app's window.__CG_INSTANCE__ must agree — two
    // clients (web, native) must not see different instance identities. The
    // self-host edge (Caddy) declares it in /instance-config.js, rendered
    // from its own settings (docker/caddy/instance-config.js); a shell
    // without that script gets it inlined by the API.
    const [config, script, html] = await Promise.all([
      client.getInstanceConfig(),
      fetch(`${BASE_URL}/instance-config.js`).then((r) => (r.ok ? r.text() : "")),
      fetch(`${BASE_URL}/`).then((r) => r.text()),
    ]);
    const match =
      script.match(/window\.__CG_INSTANCE__ = (\{.*\});/) ??
      html.match(/window\.__CG_INSTANCE__ = (\{.*?\});<\/script>/);
    if (!match) {
      // Instances that declare nothing (official app.cg) have nothing to compare.
      return;
    }
    const webConfig = JSON.parse(match[1]);
    expect(config).toEqual(webConfig);
  });
});

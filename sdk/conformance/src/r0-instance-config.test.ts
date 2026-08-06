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
    expect(config.cgidUrl).toContain("#");
    expect(["altcha", "recaptcha", "off"]).toContain(config.captchaProvider);

    // Optional fields must have the right type when present.
    if (config.activeChains !== undefined) {
      expect(Array.isArray(config.activeChains)).toBe(true);
      for (const chain of config.activeChains) {
        expect(chain).toMatch(/^[a-z0-9_]+$/);
      }
    }
    if (config.features !== undefined) {
      for (const key of Object.keys(config.features)) {
        expect(["email", "twitterAuth", "calls", "imageFilter"]).toContain(key);
        expect(typeof config.features[key as keyof typeof config.features]).toBe("boolean");
      }
    }

    // No unexpected keys: the endpoint mirrors InstanceConfig exactly.
    const allowed = new Set([
      "deployment", "appUrl", "cgidUrl", "recaptchaSiteKey", "captchaProvider",
      "activeChains", "features", "giphyApiKey", "walletConnectProjectId",
    ]);
    for (const key of Object.keys(config)) {
      expect(allowed, `unexpected field ${key} — SDK InstanceConfig mirror is stale`).toContain(key);
    }
  });

  it("is served with no-store caching", async () => {
    const response = await fetch(`${BASE_URL}/api/v2/Instance/config`);
    expect(response.status).toBe(200);
    // The app sets no-store; nginx appends its blanket no-cache on API routes,
    // so through the proxy this reads "no-store, no-cache". Assert the
    // contract-relevant part: the response is marked non-storable.
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("matches the config the web app gets via HTML injection", async () => {
    // The endpoint and the injected window.__CG_INSTANCE__ must agree —
    // two clients (web, native) must not see different instance identities.
    const [config, html] = await Promise.all([
      client.getInstanceConfig(),
      fetch(`${BASE_URL}/`).then((r) => r.text()),
    ]);
    const match = html.match(/window\.__CG_INSTANCE__ = (\{.*?\});<\/script>/);
    if (!match) {
      // Instances that don't inject (official app.cg) have nothing to compare.
      return;
    }
    const injected = JSON.parse(match[1]);
    expect(config).toEqual(injected);
  });
});

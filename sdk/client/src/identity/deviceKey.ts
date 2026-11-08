/**
 * Device keypair — the client's cryptographic identity.
 *
 * Contract: every login/registration carries `device.publicKey`, an EC JWK
 * the server validates strictly (srv/validators/common.ts JsonWebKey:
 * kty "EC", crv "P-256"|"P-384", ext true, key_ops ["verify"], x, y).
 * Signature-based flows (HTTP device login, socket login, protoo login) sign
 * the UTF-8 bytes of a server-issued secret with ECDSA; the server verifies
 * via WebCrypto with the hash chosen by the stored curve — P-256→SHA-256,
 * P-384→SHA-384 (srv/repositories/device.ts verifyDeviceAndGetUserId) — and
 * expects the raw IEEE P1363 (r‖s) signature, base64-encoded.
 *
 * P-384 is what the web client generates; P-256 exists for Secure-Enclave
 * class hardware keys on native platforms. The SDK supports both — the
 * conformance suite proves both against a live server.
 */

import { webcrypto } from "node:crypto";

export type DeviceCurve = "P-256" | "P-384";

/** The strict public-JWK shape the server validator accepts. */
export interface DevicePublicJwk {
  crv: DeviceCurve;
  ext: true;
  key_ops: ["verify"];
  kty: "EC";
  x: string;
  y: string;
}

/** Serializable form of a device identity (KEEP PRIVATE — contains d). */
export interface DeviceKeyExport {
  crv: DeviceCurve;
  privateJwk: webcrypto.JsonWebKey;
  publicJwk: DevicePublicJwk;
}

const hashFor = (curve: DeviceCurve) => (curve === "P-256" ? "SHA-256" : "SHA-384");

export class DeviceKey {
  private constructor(
    readonly curve: DeviceCurve,
    private readonly privateKey: webcrypto.CryptoKey,
    readonly publicJwk: DevicePublicJwk,
    private readonly privateJwk: webcrypto.JsonWebKey,
  ) {}

  static async generate(curve: DeviceCurve = "P-384"): Promise<DeviceKey> {
    const pair = await webcrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: curve },
      true,
      ["sign", "verify"],
    );
    const privateJwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
    const publicJwkRaw = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
    const publicJwk: DevicePublicJwk = {
      crv: curve,
      ext: true,
      key_ops: ["verify"],
      kty: "EC",
      x: publicJwkRaw.x!,
      y: publicJwkRaw.y!,
    };
    return new DeviceKey(curve, pair.privateKey, publicJwk, privateJwk);
  }

  static async import(data: DeviceKeyExport): Promise<DeviceKey> {
    const privateKey = await webcrypto.subtle.importKey(
      "jwk",
      data.privateJwk,
      { name: "ECDSA", namedCurve: data.crv },
      true,
      ["sign"],
    );
    return new DeviceKey(data.crv, privateKey, data.publicJwk, data.privateJwk);
  }

  export(): DeviceKeyExport {
    return { crv: this.curve, privateJwk: this.privateJwk, publicJwk: this.publicJwk };
  }

  /** Sign a server-issued secret: base64(P1363 ECDSA over utf8(secret)). */
  async signSecret(secret: string): Promise<string> {
    const signature = await webcrypto.subtle.sign(
      { name: "ECDSA", hash: hashFor(this.curve) },
      this.privateKey,
      new TextEncoder().encode(secret),
    );
    return Buffer.from(signature).toString("base64");
  }
}

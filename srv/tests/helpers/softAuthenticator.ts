// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * A software WebAuthn authenticator for tests: ES256 keys from node:crypto,
 * CBOR from @simplewebauthn/server/helpers. It answers the JSON options the
 * server produces with the JSON responses @simplewebauthn/browser would send,
 * and every field a test may want to break (origin, RP ID, user verification,
 * counter, user handle) can be overridden per call.
 */

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

type StoredCredential = {
  id: string;
  privateKey: KeyObject;
  rpId: string;
  userHandle: string;
  counter: number;
};

export type CeremonyOverrides = {
  /** origin written into clientDataJSON */
  origin?: string;
  /** RP ID whose hash goes into authenticatorData */
  rpId?: string;
  /** user verified flag (default true) */
  uv?: boolean;
  /** explicit signature counter for this assertion */
  counter?: number;
  /** challenge to answer instead of the one in the options */
  challenge?: string;
  /** clientData type (webauthn.create / webauthn.get) */
  type?: string;
  /** userHandle to report (null: omit it) */
  userHandle?: string | null;
};

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

function sha256(data: Uint8Array | string) {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function u32(n: number) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}

function u16(n: number) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n);
  return b;
}

export class SoftAuthenticator {
  readonly credentials = new Map<string, StoredCredential>();
  /** "increment": counter +1 per assertion; "zero": always 0 (synced passkeys) */
  constructor(private readonly counterMode: "increment" | "zero" = "zero") {}

  createCredential(options: PublicKeyCredentialCreationOptionsJSON, origin: string, overrides: CeremonyOverrides = {}): RegistrationResponseJSON {
    const rpId = overrides.rpId ?? options.rp.id!;
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const credentialId = new Uint8Array(randomBytes(32));
    const id = isoBase64URL.fromBuffer(credentialId);
    const counter = 0;
    this.credentials.set(id, { id, privateKey, rpId, userHandle: options.user.id, counter });

    const cosePublicKey = isoCBOR.encode(new Map<number, number | Uint8Array>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, isoBase64URL.toBuffer(jwk.x)],
      [-3, isoBase64URL.toBuffer(jwk.y)],
    ]));
    const flags = FLAG_UP | FLAG_AT | FLAG_BE | FLAG_BS | ((overrides.uv ?? true) ? FLAG_UV : 0);
    const authData = concat(
      sha256(rpId),
      new Uint8Array([flags]),
      u32(counter),
      new Uint8Array(16), // aaguid
      u16(credentialId.length),
      credentialId,
      cosePublicKey,
    );
    const attestationObject = isoCBOR.encode(new Map<string, string | Uint8Array | Map<string, string>>([
      ["fmt", "none"],
      ["attStmt", new Map<string, string>()],
      ["authData", authData],
    ]));
    const clientDataJSON = JSON.stringify({
      type: overrides.type ?? "webauthn.create",
      challenge: overrides.challenge ?? options.challenge,
      origin: overrides.origin ?? origin,
      crossOrigin: false,
    });
    return {
      id,
      rawId: id,
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: isoBase64URL.fromUTF8String(clientDataJSON),
        attestationObject: isoBase64URL.fromBuffer(attestationObject),
        transports: ["internal", "hybrid"],
      },
    };
  }

  getAssertion(options: PublicKeyCredentialRequestOptionsJSON, origin: string, credentialId?: string, overrides: CeremonyOverrides = {}): AuthenticationResponseJSON {
    const id = credentialId ?? options.allowCredentials?.[0]?.id ?? [...this.credentials.keys()][0];
    const credential = this.credentials.get(id);
    if (!credential) {
      throw new Error("soft authenticator: unknown credential");
    }
    if (this.counterMode === "increment") {
      credential.counter += 1;
    }
    const counter = overrides.counter ?? credential.counter;
    const rpId = overrides.rpId ?? options.rpId ?? credential.rpId;
    const flags = FLAG_UP | FLAG_BE | FLAG_BS | ((overrides.uv ?? true) ? FLAG_UV : 0);
    const authData = concat(sha256(rpId), new Uint8Array([flags]), u32(counter));
    const clientDataJSON = JSON.stringify({
      type: overrides.type ?? "webauthn.get",
      challenge: overrides.challenge ?? options.challenge,
      origin: overrides.origin ?? origin,
      crossOrigin: false,
    });
    const signature = sign("sha256", concat(authData, sha256(clientDataJSON)), credential.privateKey);
    const userHandle = overrides.userHandle === undefined ? credential.userHandle : overrides.userHandle;
    return {
      id,
      rawId: id,
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: isoBase64URL.fromUTF8String(clientDataJSON),
        authenticatorData: isoBase64URL.fromBuffer(authData),
        signature: isoBase64URL.fromBuffer(new Uint8Array(signature)),
        ...(userHandle === null ? {} : { userHandle }),
      },
    };
  }
}

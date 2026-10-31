/**
 * A dependency-free software WebAuthn authenticator for the conformance
 * suite: ES256 keys from node:crypto and a minimal CBOR encoder (unsigned and
 * negative integers, byte strings, text strings, maps — all a "none"
 * attestation needs). It answers the instance's options with the JSON a
 * browser (via @simplewebauthn/browser) would send, and lets a test sign for
 * another RP ID to check that the instance refuses it.
 */

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type {
  PasskeyAuthenticationResponse,
  PasskeyCreationOptions,
  PasskeyRegistrationResponse,
  PasskeyRequestOptions,
} from "@commonground/client";

type CborValue = number | string | Uint8Array | Map<CborValue, CborValue>;

function cborHead(major: number, length: number): Uint8Array {
  if (length < 24) return Uint8Array.of((major << 5) | length);
  if (length < 0x100) return Uint8Array.of((major << 5) | 24, length);
  if (length < 0x10000) return Uint8Array.of((major << 5) | 25, length >> 8, length & 0xff);
  return Uint8Array.of((major << 5) | 26, (length >>> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff);
}

export function cborEncode(value: CborValue): Uint8Array {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error("cbor: integers only");
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return concat(cborHead(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) {
    return concat(cborHead(2, value.length), value);
  }
  const parts: Uint8Array[] = [cborHead(5, value.size)];
  for (const [k, v] of value) {
    parts.push(cborEncode(k), cborEncode(v));
  }
  return concat(...parts);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array | string) => new Uint8Array(createHash("sha256").update(data).digest());
const u32 = (n: number) => Uint8Array.of((n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);

const FLAGS_UP_UV_BE_BS = 0x01 | 0x04 | 0x08 | 0x10;
const FLAG_AT = 0x40;

type Credential = { id: string; privateKey: KeyObject; rpId: string; userHandle: string; counter: number };

export class SoftAuthenticator {
  readonly credentials = new Map<string, Credential>();

  createCredential(options: PasskeyCreationOptions, origin: string, overrides: { rpId?: string } = {}): PasskeyRegistrationResponse {
    const rpId = overrides.rpId ?? options.rp.id!;
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const rawId = new Uint8Array(randomBytes(32));
    const id = b64url(rawId);
    this.credentials.set(id, { id, privateKey, rpId, userHandle: options.user.id, counter: 0 });
    const coseKey = cborEncode(new Map<CborValue, CborValue>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x, "base64url"))],
      [-3, new Uint8Array(Buffer.from(jwk.y, "base64url"))],
    ]));
    const authData = concat(
      sha256(rpId),
      Uint8Array.of(FLAGS_UP_UV_BE_BS | FLAG_AT),
      u32(0),
      new Uint8Array(16),
      Uint8Array.of(rawId.length >> 8, rawId.length & 0xff),
      rawId,
      coseKey,
    );
    const attestationObject = cborEncode(new Map<CborValue, CborValue>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ]));
    const clientDataJSON = JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false });
    return {
      id,
      rawId: id,
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: b64url(new TextEncoder().encode(clientDataJSON)),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
    };
  }

  getAssertion(options: PasskeyRequestOptions, origin: string, overrides: { rpId?: string; credentialId?: string } = {}): PasskeyAuthenticationResponse {
    const id = overrides.credentialId ?? options.allowCredentials?.[0]?.id ?? [...this.credentials.keys()][0];
    const credential = this.credentials.get(id);
    if (!credential) throw new Error("soft authenticator: unknown credential");
    const rpId = overrides.rpId ?? options.rpId ?? credential.rpId;
    const authData = concat(sha256(rpId), Uint8Array.of(FLAGS_UP_UV_BE_BS), u32(credential.counter));
    const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false });
    const signature = sign("sha256", concat(authData, sha256(clientDataJSON)), credential.privateKey);
    return {
      id,
      rawId: id,
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: b64url(new TextEncoder().encode(clientDataJSON)),
        authenticatorData: b64url(authData),
        signature: b64url(new Uint8Array(signature)),
        userHandle: credential.userHandle,
      },
    };
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import errors from "../common/errors";
import { appOrigins } from "./origins";

/**
 * A Sign-In with Ethereum message (EIP-4361), parsed by its structure: every
 * field is found by its label in the order the standard defines, not by a
 * line number, so an optional statement or optional fields (Expiration Time,
 * Not Before, Request ID, Resources) cannot shift another field into place.
 * Used for wallet sign-in and for Sign In With Farcaster, which is the same
 * format with a `farcaster://fid/<fid>` resource.
 */
export type SiweMessage = {
  /** the whole first line (`<domain> wants you to sign in with your Ethereum account:`) */
  headerLine: string;
  /** the authority the message is for (host, with a port if any) */
  domain: string;
  /** lowercase */
  address: Common.Address;
  statement: string | null;
  uri: string;
  version: string;
  chainId: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string | null;
  notBefore: string | null;
  requestId: string | null;
  resources: string[];
};

// the domain is an authority (host[:port]); a scheme is refused here, like
// assertSiweForThisInstance does
const HEADER = /^([^\s/]+) wants you to sign in with your Ethereum account:$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function invalid(): never {
  throw new Error(errors.server.INVALID_REQUEST);
}

/** Throws INVALID_REQUEST for anything that is not a well-formed message. */
export function parseSiweMessage(message: string): SiweMessage {
  if (typeof message !== "string" || message.length > 8192 || message.includes("\r")) {
    invalid();
  }
  const lines = message.split("\n");
  let i = 0;
  const next = () => (i < lines.length ? lines[i++] : invalid());

  const headerLine = next();
  const domain = headerLine.match(HEADER)?.[1] ?? invalid();
  const address = next();
  if (!ADDRESS.test(address)) {
    invalid();
  }
  if (next() !== "") {
    invalid();
  }
  // either an empty line (no statement), or the statement and an empty line
  let statement: string | null = null;
  const afterAddress = next();
  if (afterAddress !== "") {
    statement = afterAddress;
    if (next() !== "") {
      invalid();
    }
  }

  const field = (label: string): string => {
    const line = next();
    if (!line.startsWith(`${label}: `)) {
      invalid();
    }
    const value = line.slice(label.length + 2);
    return value.length > 0 ? value : invalid();
  };
  const optionalField = (label: string): string | null => {
    if (i < lines.length && lines[i].startsWith(`${label}: `)) {
      return field(label);
    }
    return null;
  };

  const uri = field("URI");
  const version = field("Version");
  const chainId = field("Chain ID");
  const nonce = field("Nonce");
  const issuedAt = field("Issued At");
  const expirationTime = optionalField("Expiration Time");
  const notBefore = optionalField("Not Before");
  const requestId = optionalField("Request ID");
  const resources: string[] = [];
  if (i < lines.length && lines[i] === "Resources:") {
    i++;
    while (i < lines.length && lines[i].startsWith("- ")) {
      resources.push(lines[i++].slice(2));
    }
  }
  if (i !== lines.length) {
    invalid();
  }
  if (!/^[0-9]+$/.test(chainId) || !/^[a-zA-Z0-9]{8,}$/.test(nonce)) {
    invalid();
  }
  for (const time of [issuedAt, expirationTime, notBefore]) {
    if (time !== null && Number.isNaN(Date.parse(time))) {
      invalid();
    }
  }
  return {
    headerLine,
    domain,
    address: address.toLowerCase() as Common.Address,
    statement,
    uri,
    version,
    chainId,
    nonce,
    issuedAt,
    expirationTime,
    notBefore,
    requestId,
    resources,
  };
}

/**
 * The message is valid at `now`: its Expiration Time (if any) has not passed
 * and its Not Before (if any) has been reached. Throws INVALID_SIGNATURE.
 */
export function assertSiweMessageCurrent(message: SiweMessage, now = Date.now()): void {
  if (message.expirationTime !== null && Date.parse(message.expirationTime) <= now) {
    throw new Error(errors.server.INVALID_SIGNATURE);
  }
  if (message.notBefore !== null && Date.parse(message.notBefore) > now) {
    throw new Error(errors.server.INVALID_SIGNATURE);
  }
}

const SIWE_DOMAIN_LINE = /^(\S+) wants you to sign in with your Ethereum account:$/;

/**
 * A sign-in message (EIP-4361) names the site it is for: its first line
 * carries the host, its `URI:` the origin. Both must be this instance's web
 * app (appOrigins), so a signature a user gave another site cannot be
 * replayed here. Used for wallet, Farcaster and LUKSO sign-in messages.
 * Throws INVALID_SIGNATURE otherwise.
 */
export function assertSiweForThisInstance(domainLine: string | undefined, uri: string, origins: string[] = appOrigins()) {
  const domain = domainLine?.match(SIWE_DOMAIN_LINE)?.[1];
  let uriOrigin: string;
  try {
    uriOrigin = new URL(uri).origin;
  }
  catch {
    throw new Error(errors.server.INVALID_SIGNATURE);
  }
  if (!domain || !origins.includes(uriOrigin) || new URL(uriOrigin).host !== domain) {
    throw new Error(errors.server.INVALID_SIGNATURE);
  }
}

const FARCASTER_FID_RESOURCE = /^farcaster:\/\/fid\/([1-9][0-9]{0,15})$/;

/**
 * The Farcaster ID a Sign In With Farcaster message claims: exactly one
 * `farcaster://fid/<fid>` resource. Throws INVALID_REQUEST otherwise.
 */
export function farcasterIdOf(message: SiweMessage): number {
  const fids = message.resources
    .map(resource => resource.match(FARCASTER_FID_RESOURCE)?.[1])
    .filter((fid): fid is string => fid !== undefined);
  if (fids.length !== 1) {
    invalid();
  }
  const fid = Number(fids[0]);
  return Number.isSafeInteger(fid) ? fid : invalid();
}

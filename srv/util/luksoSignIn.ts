// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import errors from "../common/errors";
import { assertSiweForThisInstance, assertSiweMessageCurrent, parseSiweMessage, type SiweMessage } from "./siweMessage";

/** LUKSO mainnet: the chain the onchain service checks profile signatures on */
export const LUKSO_CHAIN_ID = '42';
/**
 * how far `Issued At` may lie from the server's clock, either way: a sanity
 * bound with room for client clocks that are off. Freshness comes from the
 * single-use session nonce and the prepared sign-in's age.
 */
export const LUKSO_MESSAGE_CLOCK_WINDOW_MS = 15 * 60 * 1000;
/** a prepared LUKSO sign-in (Lukso/PrepareLuksoAction) older than this signs in no one */
export const LUKSO_PREPARED_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * The text a Universal Profile signs to sign in must be a Sign-In with
 * Ethereum message (EIP-4361, srv/util/siweMessage.ts) made for this
 * instance, exactly like a wallet or Farcaster sign-in message:
 * - its domain line and `URI:` name this instance's web app
 *   (assertSiweForThisInstance), so a signature given to another site is
 *   worthless here;
 * - it names the profile that signs (`address`), LUKSO mainnet as its chain
 *   and version 1;
 * - its `Nonce:` is the session's signable secret (User/getSignableSecret);
 * - its `Issued At` lies within LUKSO_MESSAGE_CLOCK_WINDOW_MS of now, and it
 *   is neither expired nor not yet valid.
 * The signature itself is checked by the onchain service (ERC-1271).
 * Throws INVALID_REQUEST for a malformed message, INVALID_SECRET for another
 * nonce and INVALID_SIGNATURE for anything else.
 */
export function assertLuksoSignInMessage(
  message: string,
  { address, nonce, now = Date.now(), origins }: { address: string; nonce: string | undefined; now?: number; origins?: string[] },
): SiweMessage {
  const parsed = parseSiweMessage(message);
  assertSiweForThisInstance(parsed.headerLine, parsed.uri, origins);
  if (parsed.version !== '1' || parsed.chainId !== LUKSO_CHAIN_ID) {
    throw new Error(errors.server.INVALID_SIGNATURE);
  }
  if (typeof address !== 'string' || parsed.address !== address.toLowerCase()) {
    throw new Error(errors.server.INVALID_SIGNATURE);
  }
  if (!nonce || parsed.nonce !== nonce) {
    throw new Error(errors.server.INVALID_SECRET);
  }
  const issuedAt = Date.parse(parsed.issuedAt);
  if (Math.abs(now - issuedAt) > LUKSO_MESSAGE_CLOCK_WINDOW_MS) {
    throw new Error(errors.server.INVALID_SIGNATURE);
  }
  assertSiweMessageCurrent(parsed, now);
  return parsed;
}

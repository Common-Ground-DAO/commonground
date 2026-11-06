// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Key material for e2e/checks/gateway.sh (run in the backend image): a wallet
 * key and a P-256 passkey credential in the shape the passkeys table stores
 * (data jsonb: COSE public key, base64). Prints one JSON object.
 */

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire('/dist/package.json');
const { ethers } = require('ethers');
const { isoCBOR } = require('@simplewebauthn/server/helpers');

const wallet = ethers.Wallet.createRandom();
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' });
const cose = isoCBOR.encode(new Map([
  [1, 2],
  [3, -7],
  [-1, 1],
  [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))],
  [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))],
]));
const credentialId = randomBytes(32).toString('base64url');
const userHandle = randomBytes(32).toString('base64url');

console.log(JSON.stringify({
  walletKey: wallet.privateKey,
  walletAddress: wallet.address.toLowerCase(),
  passkeyKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
  passkeyCredentialId: credentialId,
  passkeyUserHandle: userHandle,
  passkeyData: JSON.stringify({
    webAuthnUserID: userHandle,
    credentialID: credentialId,
    credentialPublicKeyBase64: Buffer.from(cose).toString('base64'),
    credentialDeviceType: 'multiDevice',
    credentialBackedUp: true,
    transports: ['internal'],
  }),
}));

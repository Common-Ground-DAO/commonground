// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Joi from "joi";
import config from "../common/config";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../common/passwordPolicy";
import { EMAIL_CODE_PATTERN, PROFILE_NAME_PATTERN } from "../common/authInputRules";

// mirrored in src/common/util.ts, change in both places
export const itemUrlRegex = /^[a-z0-9-]{3,50}$/i;

const Base64 = Joi.string();
const ItemUrl = Joi.string().regex(itemUrlRegex);
const allowedChainIdentifiers = [
  "eth",
  "optimism",
  "arbitrum",
  "xdai",
  "matic",
  "bsc",
  "fantom",
  "avax",
  "base",
  "linea",
  "arbitrum_nova",
  "celo",
  "polygon_zkevm",
  "scroll",
  "zksync",
  "lukso",
];
if (config.DEPLOYMENT === "dev") {
  allowedChainIdentifiers.push("hardhat");
}

// WebAuthn JSON (as produced by @simplewebauthn/browser): base64url fields
// with generous but finite lengths. Credential IDs are at most 1023 bytes.
const Base64URL = Joi.string().regex(/^[A-Za-z0-9_-]*$/);
const CredentialId = Base64URL.min(16).max(1366);
const AuthenticatorTransport = Joi.string().valid('ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb');
const ClientExtensionResults = Joi.object().unknown(true);
const AuthenticatorAttachment = Joi.string().valid('platform', 'cross-platform');

const WebAuthnRegistrationResponse = Joi.object({
  id: CredentialId.required(),
  rawId: CredentialId.required(),
  type: Joi.string().valid('public-key').required(),
  authenticatorAttachment: AuthenticatorAttachment,
  clientExtensionResults: ClientExtensionResults.required(),
  response: Joi.object({
    clientDataJSON: Base64URL.min(1).max(4096).required(),
    attestationObject: Base64URL.min(1).max(16384).required(),
    authenticatorData: Base64URL.max(16384),
    transports: Joi.array().items(AuthenticatorTransport).unique().max(8),
    publicKeyAlgorithm: Joi.number().integer(),
    publicKey: Base64URL.max(4096),
  }).strict(true).required(),
}).strict(true);

const WebAuthnAuthenticationResponse = Joi.object({
  id: CredentialId.required(),
  rawId: CredentialId.required(),
  type: Joi.string().valid('public-key').required(),
  authenticatorAttachment: AuthenticatorAttachment,
  clientExtensionResults: ClientExtensionResults.required(),
  response: Joi.object({
    clientDataJSON: Base64URL.min(1).max(4096).required(),
    authenticatorData: Base64URL.min(1).max(16384).required(),
    signature: Base64URL.min(1).max(2048).required(),
    // user handles are at most 64 bytes
    userHandle: Base64URL.min(1).max(86),
  }).strict(true).required(),
}).strict(true);

const Tag = Joi.string().max(30).regex(/^[a-z0-9-_ /]+$/i);
const Tags = Joi.array().items(Tag).unique().max(50);

const common = {
  Link: Joi.object({
    url: Joi.string(), // @Todo
    text: Joi.string()
  }).strict(true),
  ImageId: Joi.string().regex(/^[0-9a-f]{64}$/),
  Uuid: Joi.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  ChannelType: Joi.string().regex(/^text|voice$/),
  WalletVisibility: Joi.string().regex(/^public|followed|private$/),
  Emoji: Joi.string().regex(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F9B0}-\u{1F9B3}]/u),
  Tag,
  Tags,
  // the username rule, shared with the web app (src/common/authInputRules.ts)
  CgProfileDisplayName:  Joi.string().regex(PROFILE_NAME_PATTERN),
  OnlineStatus: Joi.string().regex(/^online|away|dnd|invisible$/),
  ChainIdentifier: Joi.string().valid(...allowedChainIdentifiers),
  EIP712Signature: Joi.string(),
  DateString: Joi.string().isoDate(),
  // a new password: the password policy (src/common/passwordPolicy.ts)
  Password: Joi.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  // a password typed to sign in or re-authenticate: older passwords may be
  // shorter than the policy (the account then has to choose a new one)
  PasswordAttempt: Joi.string().min(1).max(PASSWORD_MAX_LENGTH),
  // the one-time token of a transfer link (srv/util/transferLink.ts)
  TransferToken: Joi.string().regex(/^[A-Za-z0-9_-]{43}$/),
  // an 8-digit email code (src/common/authInputRules.ts)
  EmailCode: Joi.string().regex(EMAIL_CODE_PATTERN),
  // Signable login secrets. Two generations coexist: wsapi still issues
  // 20-char alphanumeric secrets (randomString), the call server issues
  // 64-char hex secrets (realRandomHexString(32)) since the mediasoup
  // hardening. Every consumer compares the echoed secret against the one it
  // stored for the connection, so the validator only pins the two shapes.
  Secret: Joi.alternatives().try(
    Joi.string().length(20),
    Joi.string().hex().length(64),
  ),
  ItemUrl,
  ItemUrlNullable: Joi.alternatives().try(ItemUrl, Joi.equal(null)),
  JsonWebKey: Joi.object({
    alg: Joi.valid("ES256", "ES384"), // is present on firefox only
    // P-384 is what the web client generates; P-256 is additionally accepted
    // for native clients whose hardware keystores only support it (iOS Secure
    // Enclave). Verification derives curve and hash from the stored key.
    crv: Joi.valid("P-256", "P-384").required(),
    ext: Joi.equal(true).required(),
    key_ops: Joi.array().length(1).items(Joi.equal("verify")).required(),
    kty: Joi.equal("EC").required(),
    x: Joi.string().max(150).required(),
    y: Joi.string().max(150).required(),
  }).strict(true),
  Base64DeviceSignature: Base64.max(200),
  Address: Joi.string().regex(/^0x[a-fA-F0-9]{40}$/),
  TutorialName: Joi.string().valid('onboarding'),
  WebAuthnRegistrationResponse,
  WebAuthnAuthenticationResponse,
  PasskeyName: Joi.string().min(1).max(64).regex(/^[^\u0000-\u001f\u007f]+$/),
};

export default common;
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Joi from "joi";
import config from "../common/config";

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
  CgProfileDisplayName:  Joi.string().regex(/^[a-z0-9_-]{3,30}$/i),
  OnlineStatus: Joi.string().regex(/^online|away|dnd|invisible$/),
  ChainIdentifier: Joi.string().valid(...allowedChainIdentifiers),
  EIP712Signature: Joi.string(),
  DateString: Joi.string().isoDate(),
  Password: Joi.string(),
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
    alg: Joi.equal("ES384"), // is present on firefox only
    crv: Joi.equal("P-384").required(),
    ext: Joi.equal(true).required(),
    key_ops: Joi.array().length(1).items(Joi.equal("verify")).required(),
    kty: Joi.equal("EC").required(),
    x: Joi.string().max(150).required(),
    y: Joi.string().max(150).required(),
  }).strict(true),
  Base64DeviceSignature: Base64.max(200),
  Address: Joi.string().regex(/^0x[a-fA-F0-9]{40}$/),
  TutorialName: Joi.string().valid('onboarding'),
};

export default common;
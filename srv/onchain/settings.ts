// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { dockerSecret } from '../util';
import { chainIds } from '../common/chainIds';
// Maximum queued requests in api before responding with "overloaded"
const MAX_QUEUED_REQUESTS = {
  LOW_PRIO: 1000,
  MEDIUM_PRIO: 2000,
  HIGH_PRIO: 3000,
}
const DEFAULT_REQUEST_TIMEOUT = 35000; // allows at least 3 retries
const DEFAULT_PROVIDER_TIMEOUT = 10000; // the internal timeout for every prodiver request
const WARN_RETRIES = 5;
const MAX_RETRIES = 10;
const NUM_BACKEND_WORKERS = 4;
const MAX_REQUESTS_PER_SECOND = 100;

const BAN_TIME = 20000;
const QUIKNODE_UPDATE_INTERVAL = 30000;
const QUIKNODE_ETH = dockerSecret("quiknode_eth") || process.env.QUIKNODE_ETH || "";
const QUIKNODE_BSC = dockerSecret("quiknode_bsc") || process.env.QUIKNODE_BSC || "";
const QUIKNODE_MATIC = dockerSecret("quiknode_matic") || process.env.QUIKNODE_MATIC || "";
const QUIKNODE_XDAI = dockerSecret("quiknode_xdai") || process.env.QUIKNODE_XDAI || "";
const QUIKNODE_FANTOM = dockerSecret("quiknode_fantom") || process.env.QUIKNODE_FANTOM || "";
const QUIKNODE_AVAX = dockerSecret("quiknode_avax") || process.env.QUIKNODE_AVAX || "";
const QUIKNODE_ARBITRUM = dockerSecret("quiknode_arbitrum") || process.env.QUIKNODE_ARBITRUM || "";
const QUIKNODE_OPTIMISM = dockerSecret("quiknode_optimism") || process.env.QUIKNODE_OPTIMISM || "";
const QUIKNODE_BASE = dockerSecret("quiknode_base") || process.env.QUIKNODE_BASE || "";
const INFURA_LINEA = dockerSecret("infura_linea") || process.env.INFURA_LINEA || "";
const QUIKNODE_ARBITRUM_NOVA = dockerSecret("quiknode_arbitrum_nova") || process.env.QUIKNODE_ARBITRUM_NOVA || "";
const QUIKNODE_CELO = dockerSecret("quiknode_celo") || process.env.QUIKNODE_CELO || "";
const QUIKNODE_POLYGON_ZKEVM = dockerSecret("quiknode_polygon_zkevm") || process.env.QUIKNODE_POLYGON_ZKEVM || "";
const QUIKNODE_SCROLL = dockerSecret("quiknode_scroll") || process.env.QUIKNODE_SCROLL || "";
const QUIKNODE_ZKSYNC = dockerSecret("quiknode_zksync") || process.env.QUIKNODE_ZKSYNC || "";
// Unlike the other chains, LUKSO falls back to the official public RPC when
// unconfigured: it predates configurability here, and existing deployments
// rely on it working without a dedicated endpoint.
const QUIKNODE_LUKSO = dockerSecret("quiknode_lukso") || process.env.QUIKNODE_LUKSO || 'https://rpc.mainnet.lukso.network/';

const BETWEEN_REQUESTS_COOLDOWN = 35;

const chains: {
  [chain in (Models.Contract.ChainIdentifier|"hardhat"|"sokol")]: {
    PROVIDER_COOLDOWN: number;
    PROVIDER_URL: string;
    UPDATE_INTERVAL: number;
    CHAIN_ID: bigint;
    BLOCK_BATCHSIZE: number;
    SAFE_BLOCK_DELAY: number;
  }
} = {
  // ETH
  eth: {
    PROVIDER_COOLDOWN: BETWEEN_REQUESTS_COOLDOWN,
    PROVIDER_URL: QUIKNODE_ETH,
    UPDATE_INTERVAL: QUIKNODE_UPDATE_INTERVAL,
    CHAIN_ID: BigInt(chainIds.eth),
    BLOCK_BATCHSIZE: 4,
    SAFE_BLOCK_DELAY: 2,
  },
  // BSC
  bsc: {
    PROVIDER_COOLDOWN: BETWEEN_REQUESTS_COOLDOWN,
    PROVIDER_URL: QUIKNODE_BSC,
    UPDATE_INTERVAL: QUIKNODE_UPDATE_INTERVAL,
    CHAIN_ID: BigInt(chainIds.bsc),
    BLOCK_BATCHSIZE: 4,
    SAFE_BLOCK_DELAY: 2,
  },
  // MATIC
  matic: {
    PROVIDER_COOLDOWN: BETWEEN_REQUESTS_COOLDOWN,
    PROVIDER_URL: QUIKNODE_MATIC,
    UPDATE_INTERVAL: QUIKNODE_UPDATE_INTERVAL,
    CHAIN_ID: BigInt(chainIds.matic),
    BLOCK_BATCHSIZE: 8,
    SAFE_BLOCK_DELAY: 2,
  },
  // XDAI
  xdai: {
    PROVIDER_COOLDOWN: BETWEEN_REQUESTS_COOLDOWN,
    PROVIDER_URL: QUIKNODE_XDAI,
    UPDATE_INTERVAL: QUIKNODE_UPDATE_INTERVAL,
    CHAIN_ID: BigInt(chainIds.xdai),
    BLOCK_BATCHSIZE: 8,
    SAFE_BLOCK_DELAY: 2,
  },
  // FANTOM
  fantom: {
    PROVIDER_COOLDOWN: BETWEEN_REQUESTS_COOLDOWN,
    PROVIDER_URL: QUIKNODE_FANTOM,
    UPDATE_INTERVAL: QUIKNODE_UPDATE_INTERVAL,
    CHAIN_ID: BigInt(chainIds.fantom),
    BLOCK_BATCHSIZE: 8,
    SAFE_BLOCK_DELAY: 2,
  },
  // AVAX
  avax: {
    PROVIDER_COOLDOWN: BETWEEN_REQUESTS_COOLDOWN,
    PROVIDER_URL: QUIKNODE_AVAX,
    UPDATE_INTERVAL: QUIKNODE_UPDATE_INTERVAL,
    CHAIN_ID: BigInt(chainIds.avax),
    BLOCK_BATCHSIZE: 8,
    SAFE_BLOCK_DELAY: 2,
  },
  // ARBITRUM
  arbitrum: {
    PROVIDER_COOLDOWN: BETWEEN_REQUESTS_COOLDOWN,
    PROVIDER_URL: QUIKNODE_ARBITRUM,
    UPDATE_INTERVAL: QUIKNODE_UPDATE_INTERVAL,
    CHAIN_ID: BigInt(chainIds.arbitrum),
    BLOCK_BATCHSIZE: 40,
    SAFE_BLOCK_DELAY: 2,
  },
  // OPTIMISM
  optimism: {
    PROVIDER_COOLDOWN: BETWEEN_REQUESTS_COOLDOWN,
    PROVIDER_URL: QUIKNODE_OPTIMISM,
    UPDATE_INTERVAL: QUIKNODE_UPDATE_INTERVAL,
    CHAIN_ID: BigInt(chainIds.optimism),
    BLOCK_BATCHSIZE: 8,
    SAFE_BLOCK_DELAY: 2,
  },
  // BASE
  base: {
    PROVIDER_COOLDOWN: BETWEEN_REQUESTS_COOLDOWN,
    PROVIDER_URL: QUIKNODE_BASE,
    UPDATE_INTERVAL: QUIKNODE_UPDATE_INTERVAL,
    CHAIN_ID: BigInt(chainIds.base),
    BLOCK_BATCHSIZE: 8,
    SAFE_BLOCK_DELAY: 2,
  },
  // LINEA (MAINNET)
  linea: {
    PROVIDER_COOLDOWN: BETWEEN_REQUESTS_COOLDOWN,
    PROVIDER_URL: INFURA_LINEA,
    UPDATE_INTERVAL: 30000,
    CHAIN_ID: BigInt(chainIds.linea),
    BLOCK_BATCHSIZE: 3,
    SAFE_BLOCK_DELAY: 2,
  },
  // ARBITRUM NOVA
  arbitrum_nova: {
    PROVIDER_COOLDOWN: BETWEEN_REQUESTS_COOLDOWN,
    PROVIDER_URL: QUIKNODE_ARBITRUM_NOVA,
    UPDATE_INTERVAL: QUIKNODE_UPDATE_INTERVAL,
    CHAIN_ID: BigInt(chainIds.arbitrum_nova),
    BLOCK_BATCHSIZE: 40,
    SAFE_BLOCK_DELAY: 2,
  },
  // CELO
  celo: {
    PROVIDER_COOLDOWN: BETWEEN_REQUESTS_COOLDOWN,
    PROVIDER_URL: QUIKNODE_CELO,
    UPDATE_INTERVAL: QUIKNODE_UPDATE_INTERVAL,
    CHAIN_ID: BigInt(chainIds.celo),
    BLOCK_BATCHSIZE: 8,
    SAFE_BLOCK_DELAY: 2,
  },
  // POLYGON ZK-EVM
  polygon_zkevm: {
    PROVIDER_COOLDOWN: BETWEEN_REQUESTS_COOLDOWN,
    PROVIDER_URL: QUIKNODE_POLYGON_ZKEVM,
    UPDATE_INTERVAL: QUIKNODE_UPDATE_INTERVAL,
    CHAIN_ID: BigInt(chainIds.polygon_zkevm),
    BLOCK_BATCHSIZE: 8,
    SAFE_BLOCK_DELAY: 2,
  },
  // SCROLL
  scroll: {
    PROVIDER_COOLDOWN: BETWEEN_REQUESTS_COOLDOWN,
    PROVIDER_URL: QUIKNODE_SCROLL,
    UPDATE_INTERVAL: QUIKNODE_UPDATE_INTERVAL,
    CHAIN_ID: BigInt(chainIds.scroll),
    BLOCK_BATCHSIZE: 8,
    SAFE_BLOCK_DELAY: 2,
  },
  // ZKSYNC
  zksync: {
    PROVIDER_COOLDOWN: BETWEEN_REQUESTS_COOLDOWN,
    PROVIDER_URL: QUIKNODE_ZKSYNC,
    UPDATE_INTERVAL: QUIKNODE_UPDATE_INTERVAL,
    CHAIN_ID: BigInt(chainIds.zksync),
    BLOCK_BATCHSIZE: 1,
    SAFE_BLOCK_DELAY: 2,
  },
  // LUKSO
  lukso: {
    PROVIDER_COOLDOWN: BETWEEN_REQUESTS_COOLDOWN,
    PROVIDER_URL: QUIKNODE_LUKSO,
    UPDATE_INTERVAL: 15000,
    CHAIN_ID: BigInt(chainIds.lukso),
    BLOCK_BATCHSIZE: 8,
    SAFE_BLOCK_DELAY: 2,
  },
  // HARDHAT (LOCAL)
  hardhat: {
    PROVIDER_COOLDOWN: BETWEEN_REQUESTS_COOLDOWN,
    PROVIDER_URL: `http://hardhat:8545`,
    UPDATE_INTERVAL: 5000,
    CHAIN_ID: BigInt(chainIds.hardhat),
    BLOCK_BATCHSIZE: 10,
    SAFE_BLOCK_DELAY: 0,
  },
  // SOKOL (TESTNET)
  sokol: {
    PROVIDER_COOLDOWN: BETWEEN_REQUESTS_COOLDOWN,
    PROVIDER_URL: `https://sokol.poa.network`,
    UPDATE_INTERVAL: 15000,
    CHAIN_ID: BigInt(chainIds.sokol),
    BLOCK_BATCHSIZE: 10,
    SAFE_BLOCK_DELAY: 0,
  },
}

const settings = Object.freeze({
  ...chains,
  BAN_TIME,
  MAX_QUEUED_REQUESTS,
  DEFAULT_REQUEST_TIMEOUT,
  DEFAULT_PROVIDER_TIMEOUT,
  MAX_REQUESTS_PER_SECOND,
  NUM_BACKEND_WORKERS,
  WARN_RETRIES,
  MAX_RETRIES,
});

export default settings;

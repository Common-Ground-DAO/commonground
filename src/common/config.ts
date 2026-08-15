// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { getInstanceConfig } from './instance';

export const APP_VERSION = '0.9.9' as const;

/**
 * NEVER EVER PUT SECRETS IN THIS FILE!
 */

const AVAILABLE_CHAINS = {
  arbitrum: {
    title: 'Arbitrum',
    link: (address: Common.Address) => `https://arbiscan.io/token/${address}`
  },
  arbitrum_nova: {
    title: 'Arbitrum Nova',
    link: (address: Common.Address) => `https://nova.arbiscan.io/token/${address}`
  },
  avax: {
    title: 'Avalanche',
    link: (address: Common.Address) => `https://snowtrace.io/token/${address}`
  },
  base: {
    title: 'Base',
    link: (address: Common.Address) => `https://base.blockscout.com/token/${address}`
  },
  bsc: {
    title: 'Binance Smart Chain',
    link: (address: Common.Address) => `https://bscscan.com/token/${address}`
  },
  celo: {
    title: 'Celo',
    link: (address: Common.Address) => `https://celoscan.io/token/${address}`
  },
  eth: {
    title: 'Ethereum',
    link: (address: Common.Address) => `https://etherscan.io/token/${address}`
  },
  fantom: {
    title: 'Fantom',
    link: (address: Common.Address) => `https://ftmscan.com/token/${address}`
  },
  xdai: {
    title: 'Gnosis',
    link: (address: Common.Address) => `https://gnosis.blockscout.com/token/${address}`
  },
  linea: {
    title: 'Linea',
    link: (address: Common.Address) => `https://lineascan.build/token/${address}`
  },
  lukso: {
    title: 'Lukso',
    link: (address: Common.Address) => `https://explorer.execution.mainnet.lukso.network/address/${address}`
  },
  optimism: {
    title: 'Optimism',
    link: (address: Common.Address) => `https://optimistic.etherscan.io/token/${address}`
  },
  matic: {
    title: 'Polygon',
    link: (address: Common.Address) => `https://polygonscan.com/token/${address}`
  },
  polygon_zkevm: {
    title: 'Polygon zkEVM',
    link: (address: Common.Address) => `https://zkevm.polygonscan.com/token/${address}`
  },
  scroll: {
    title: 'Scroll',
    link: (address: Common.Address) => `https://scrollscan.com/token/${address}`
  },
  zksync: {
    title: 'zkSync',
    link: (address: Common.Address) => `https://explorer.zksync.io/address/${address}`
  },
} as const;
type ChainIdentifier = keyof typeof AVAILABLE_CHAINS;

let DEPLOYMENT: 'prod' | 'staging' | 'dev' = 'prod';
let foundDeployment = false;
const that: any = globalThis;
const instance = getInstanceConfig();
// deployment settings

// self-hosted instances declare their mode at serve time via window.__CG_INSTANCE__,
// independent of which domain they run on
if (instance?.deployment) {
  foundDeployment = true;
  DEPLOYMENT = instance.deployment;
}
// browser environment
else if (
  'location' in that &&
  'href' in that.location &&
  typeof that.location.href === 'string'
) {
  foundDeployment = true;
  if (that.location.href.startsWith('https://app.cg')) {
    DEPLOYMENT = 'prod';
  }
  else if (that.location.href.startsWith('https://staging.app.cg')) {
    DEPLOYMENT = 'staging';
  }
  else {
    DEPLOYMENT = 'dev';
  }
}

// node environment
if (
  'process' in that &&
  'env' in that.process &&
  'DEPLOYMENT' in that.process.env
) {
  foundDeployment = true;
  DEPLOYMENT = that.process.env.DEPLOYMENT;
}

if (!foundDeployment) {
  console.error('Deployment not found, will run in production mode to be safe');
}

const DEFAULT_ACTIVE_CHAINS: ChainIdentifier[] =
  // prod chains
  DEPLOYMENT === 'prod' ? ["eth", "arbitrum", "xdai", "base", "matic", "lukso"]
  : // staging chains
  DEPLOYMENT === 'staging' ? ["eth", "xdai", "lukso"]
  : // dev chains
  ["eth", "arbitrum", "xdai", "base", "matic", "lukso", ("hardhat" as ChainIdentifier)];

// instances can restrict/extend the chain set to what their RPC endpoints
// actually support: browser via instance config, backend via CG_ACTIVE_CHAINS
// (comma-separated). Unknown chain keys are ignored.
function resolveActiveChains(): ChainIdentifier[] {
  let requested: string[] | undefined;
  if (instance?.activeChains) {
    requested = instance.activeChains;
  }
  else if (
    'process' in that &&
    'env' in that.process &&
    typeof that.process.env.CG_ACTIVE_CHAINS === 'string' &&
    that.process.env.CG_ACTIVE_CHAINS.length > 0
  ) {
    requested = that.process.env.CG_ACTIVE_CHAINS.split(',').map((c: string) => c.trim());
  }
  if (!requested) {
    return DEFAULT_ACTIVE_CHAINS;
  }
  const valid = requested.filter(
    (c): c is ChainIdentifier => c in AVAILABLE_CHAINS || c === 'hardhat'
  );
  return valid.length > 0 ? valid : DEFAULT_ACTIVE_CHAINS;
}

const ACTIVE_CHAINS: ChainIdentifier[] = resolveActiveChains();

// backend-only env vars (browser builds fall back to the defaults; the
// browser decides via IMAGE_FILTER_ENABLED below, never via these)
function nodeEnv(name: string): string | undefined {
  if ('process' in that && 'env' in that.process) {
    return that.process.env[name];
  }
  return undefined;
}

function parseModerationThreshold(raw: string | undefined): number {
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1) {
    return parsed;
  }
  // never silently ignore a value the operator explicitly set (a common slip
  // is "80" meaning percent — valid values are (0, 1])
  if (raw) {
    console.warn(`Invalid IMAGE_MODERATION_THRESHOLD "${raw}" — using default 0.8`);
  }
  return 0.8;
}

const config = {
  // general settings
  APP_VERSION: APP_VERSION,
  APP_VERSION_CHECK_INTERVAL: 60000 as const,
  MESSAGE_MAX_CHARS: 2000 as const,
  ITEMLIST_BATCH_SIZE: 30 as const,
  GROUPS_BATCH_SIZE: 20 as const,
  ARTICLES_BATCH_SIZE: 20 as const,
  BLOGS_BATCH_SIZE: 20 as const,
  NOTIFICATIONS_BATCH_SIZE: 30 as const,
  EVENTS_BATCH_SIZE: 30 as const,
  CALLS_BATCH_SIZE: 6 as const,
  MAX_LINKED_ADDRESSES: 5 as const,
  MAX_TALKERS_FOR_SILENT_JOIN: 5 as const,
  SNACKBAR_DURATION: 6 as const,
  SECRET_COOKIE: 'commonground.secret' as const,
  IDB_PREFIX: 'commonGroundDB' as const,
  MAX_VOICECHANNEL_USERS: 1000 as const,
  ONCHAIN_QUERY_TIMEOUT: 15000 as const,
  WEBSOCKET_RECONNECT_COOLDOWN: 15000 as const,
  IMAGE_UPLOAD_SIZE_LIMIT: 8388608 as const,
  // server-side NSFW filter (srv/moderation/imageFilter.ts): master switch,
  // model directory (Transformers.js layout: config.json,
  // preprocessor_config.json, onnx/model_quantized.onnx) and the nsfw
  // probability above which an image is rejected
  IMAGE_MODERATION_ENABLED: nodeEnv('IMAGE_MODERATION_ENABLED') !== 'false',
  IMAGE_MODERATION_MODEL_PATH: nodeEnv('IMAGE_MODERATION_MODEL_PATH') || '/models/nsfw',
  IMAGE_MODERATION_THRESHOLD: parseModerationThreshold(nodeEnv('IMAGE_MODERATION_THRESHOLD')),
  COMMUNITY_CONTRACT: '0x64d27cBcA4eD4B21Ee5F1f396059B22E9B46c96C',
  COMMUNITY_CONTRACT_CHAIN: 'xdai',
  FRACTAL_TEXT: "I authorize Common Ground (EqjSwxLh1Q8ZZpXXE7gBwxFVvYIZxhZuG0ykhTvxFsE) to get a proof from Fractal that:\n- I passed KYC level uniqueness+wallet" as const,
  FRACTAL_SIGNER: '0xacD08d6714ADba531beFF582e6FD5DA1AFD6bc65' as const,
  // note: SVG's MIME type is image/svg+xml — the bare image/svg here meant
  // the file dialog never actually offered SVGs
  ACCEPTED_IMAGE_FORMATS: 'image/png, image/jpeg, image/gif, image/webp, image/avif, image/tiff, image/svg+xml' as const,
  MINIMUM_REPORTS_TO_FLAG_PLUGIN: 3 as const,

  COMMUNITY_CREATION_ARTICLE_DEV: undefined, // only use for testing, never commit an id here because it would break "clean" dev envs
  COMMUNITY_CREATION_ARTICLE_STAGING: '3ce42aae-7046-4e37-a2cf-e62be94a2548' as const,
  COMMUNITY_CREATION_ARTICLE_PROD: '110ed3f1-2135-4924-b09d-bd2a771b344a' as const,

  // mediasoup / callserver settings
  END_CALL_AFTER_EMPTY_PERIOD: 10000 as const,
  CALLSERVER_UPDATE_DATA_INTERVAL: 2000 as const,
  CALLSERVER_UPDATE_TRAFFIC_INTERVAL: 10000 as const,
  CALLSERVER_STALE_AFTER_MILLISECONDS: 10000 as const, // period in which a callserver must have updated it's entry to not be stale

  // url settings
  URL_USER: 'u' as const,
  URL_ARTICLE: 'article' as const,
  URL_COMMUNITY: 'c' as const,
  URL_BROWSE_COMMUNITIES: 'communities' as const,
  URL_CHANNEL: 'channel' as const,
  URL_CHATS: 'chats' as const,
  URL_NOTIFICATIONS: 'notifications' as const,
  URL_PROFILE: 'profile' as const,
  URL_FEED: 'feed' as const,
  URL_CALL: 'call' as const,
  URL_EVENT: 'event' as const,
  URL_PLUGIN: 'plugin' as const,
  URL_APPSTORE: 'store' as const,

  // deployment settings
  DEPLOYMENT,
  CONTINUOUS_ONCHAIN_CHECK: true,
  NEW_ACCOUNT_REFERRAL_REQUIRED: false,
  COMMUNITY_NFT_REQUIRED: true,
  NOTIFICATIONS_PAGE_ENABLED: true,
  TOKEN_CREATION_ENABLED: false,

  // premium settings
  PREMIUM: {
    YEARLY_DISCOUNT_PERCENT: 20 as const,

    COMMUNITY_FREE: {
      MONTHLY_PRICE: 0 as const,
      ROLE_LIMIT: 5 as const,
      TOKEN_LIMIT: 2 as const,
      CALL_HD: 50 as const,
      CALL_STANDARD: 50 as const,
      CALL_AUDIO: 50 as const,
      BROADCASTERS_SLOTS: 3 as const,
      BROADCAST_HD: 50 as const,
      BROADCAST_STANDARD: 50 as const,
      BROADCAST_AUDIO: 50 as const,
      PLUGIN_LIMIT: 50 as const,
    } as const,
    COMMUNITY_BASIC: {
      MONTHLY_PRICE: 6_999 as const,
      ROLE_LIMIT: 10 as const,
      TOKEN_LIMIT: 5 as const,
      CALL_HD: 50 as const,
      CALL_STANDARD: 50 as const,
      CALL_AUDIO: 50 as const,
      BROADCASTERS_SLOTS: 4 as const,
      BROADCAST_HD: 100 as const,
      BROADCAST_STANDARD: 100 as const,
      BROADCAST_AUDIO: 200 as const,
      PLUGIN_LIMIT: 50 as const,
    } as const,
    COMMUNITY_PRO: {
      MONTHLY_PRICE: 19_999 as const,
      ROLE_LIMIT: 20 as const,
      TOKEN_LIMIT: 10 as const,
      CALL_HD: 50 as const,
      CALL_STANDARD: 50 as const,
      CALL_AUDIO: 50 as const,
      BROADCASTERS_SLOTS: 7 as const,
      BROADCAST_HD: 200 as const,
      BROADCAST_STANDARD: 200 as const,
      BROADCAST_AUDIO: 500 as const,
      PLUGIN_LIMIT: 50 as const,
    } as const,
    COMMUNITY_ENTERPRISE: {
      MONTHLY_PRICE: 79_999 as const,
      ROLE_LIMIT: 50 as const,
      TOKEN_LIMIT: 20 as const,
      CALL_HD: 50 as const,
      CALL_STANDARD: 50 as const,
      CALL_AUDIO: 50 as const,
      BROADCASTERS_SLOTS: 7 as const,
      BROADCAST_HD: 300 as const,
      BROADCAST_STANDARD: 300 as const,
      BROADCAST_AUDIO: 1_000 as const,
      PLUGIN_LIMIT: 50 as const,
    } as const,

    USER_SUPPORTER_1: {
      MONTHLY_PRICE: 1_000 as const,
    } as const,
    USER_SUPPORTER_2: {
      MONTHLY_PRICE: 5_000 as const,
    } as const,
    URL_CHANGE: {
      ONETIME_PRICE: 5_000 as const,
    } as const,
  } as const,

  // Google reCAPTCHA v2 (self-hosted instances provide their own key via instance config)
  GOOGLE_RECAPTCHA_SITE_KEY: instance?.recaptchaSiteKey ?? '6Lc_EBspAAAAAAPbsmkudhzCyuBoDFgxAar9wWtW',
  // Which captcha widget to render. The backend declares the provider it
  // verifies against via instance config; when absent (official app.cg / local
  // dev) fall back to reCAPTCHA if a site key is present, otherwise ALTCHA.
  CAPTCHA_PROVIDER: (instance?.captchaProvider
    ?? ((instance?.recaptchaSiteKey ?? '6Lc_EBspAAAAAAPbsmkudhzCyuBoDFgxAar9wWtW') ? 'recaptcha' : 'altcha')
  ) as 'altcha' | 'recaptcha' | 'off',

  // capability flags: self-hosted instances disable features whose backing
  // service isn't configured (see src/common/instance.ts); official
  // instances have everything on
  EMAIL_ENABLED: instance?.features?.email ?? true,
  TWITTER_AUTH_ENABLED: instance?.features?.twitterAuth ?? true,
  // voice/video calls need the mediasoup service; self-hosters can leave it
  // undeployed, in which case the call UI is hidden instead of failing
  CALLS_ENABLED: instance?.features?.calls ?? true,
  // whether this instance runs the server-side NSFW image filter; the client
  // only loads its pre-upload warning model when the server actually filters
  IMAGE_FILTER_ENABLED: instance?.features?.imageFilter ?? true,
  // the server's own IMAGE_MODERATION_THRESHOLD, so the browser pre-check
  // warns at the confidence this instance actually rejects at (see
  // src/moderation/imagePrecheck.ts). The fallback matches
  // parseModerationThreshold's default above; a client that never received an
  // instance config is an official deployment, which runs the default.
  IMAGE_FILTER_THRESHOLD: instance?.imageFilterThreshold ?? 0.8,
  // per-instance third-party keys (CG defaults are locked to the official domains)
  GIPHY_API_KEY: instance?.giphyApiKey ?? (instance ? '' : 'ir89rjdyvl6GNuHNHO71QldCPQzSAjI4'),
  WALLETCONNECT_PROJECT_ID: instance?.walletConnectProjectId ?? 'a58ac26ec0960773dad148a0585ef011',

  STATUS_COLORS: {
    online: '#27AE60',
    away: '#FFD600',
    dnd: '#FF0000',
    offline: '#F9F9F9',
    invisible: '#F9F9F9'
  },
  AVAILABLE_CHAINS,
  ACTIVE_CHAINS,
  REACTION_EMOJIS: ["👍", "👎", "❤", "😂", "👏"],
  EMAIL_WAIT_INTERVAL_MINUTES: 6 * 24 * 60
};

if (config.DEPLOYMENT !== 'prod') {
  (config.AVAILABLE_CHAINS as any).sokol = {
    title: 'Sokol Testnet',
    link: (address: Common.Address) => `https://blockscout.com/poa/sokol/token/${address}`
  };
  config.EMAIL_WAIT_INTERVAL_MINUTES = 1;
}

// make config changes depending on deployment
if (config.DEPLOYMENT === 'dev') {
  (config.AVAILABLE_CHAINS as any).hardhat = {
    title: 'Local hardhat chain',
    link: (address: Common.Address) => address
  };
  config.COMMUNITY_CONTRACT = '0x54B089305b3763f7bEd47cBcb2A234f7E968C4A3';
  config.COMMUNITY_CONTRACT_CHAIN = 'hardhat';
  config.CONTINUOUS_ONCHAIN_CHECK = false;
  config.COMMUNITY_NFT_REQUIRED = false;
}

if (config.DEPLOYMENT === 'staging') {
  config.COMMUNITY_CONTRACT = '0x5b9C4a130B783AAE5c61Ead467B5fB100ac31874';
  config.COMMUNITY_CONTRACT_CHAIN = 'sokol';
  config.COMMUNITY_NFT_REQUIRED = true;
}

export default Object.freeze(config);
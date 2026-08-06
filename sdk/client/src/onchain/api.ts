/**
 * Onchain — contract metadata, staking positions, Spark/points, premium,
 * wallets, token-gated role claims.
 *
 * Contract: srv/api/contracts.ts (public, no wallet), srv/api/staking.ts
 * (login), plus point/premium/wallet routes on User and the role-claim routes
 * on Community. Design note: staking lock/unlock happen client-side against
 * the CgStaking contract (wagmi); the API only reads INDEXED state. Spark is
 * `OwnData.pointBalance` (off-chain), spent on premium.
 *
 * On a blockchain-disabled instance (conformance default): contract metadata
 * reads work for cached/known contracts (else NOT_FOUND), staking getConfig
 * returns null, getPositions returns [], and the onchain-evaluated role
 * checks fail fast with SERVICE_UNAVAILABLE.
 */

import type { HttpTransport } from "../transport/http.js";

export type ChainIdentifier =
  | "eth" | "optimism" | "arbitrum" | "arbitrum_nova" | "xdai" | "matic" | "bsc"
  | "fantom" | "avax" | "base" | "celo" | "polygon_zkevm" | "scroll" | "zksync"
  | "linea" | "lukso" | "hardhat";

export type OnchainData =
  | { type: "ERC20"; name: string; symbol: string; decimals: number }
  | { type: "ERC721"; name: string; symbol: string }
  | { type: "ERC1155"; name?: string; symbol?: string; withMetadataURI?: boolean }
  | { type: "LSP7"; name: string; symbol: string; decimals: number; tokenType: unknown }
  | { type: "LSP8"; name: string; symbol: string; tokenType: unknown };

export interface ContractData {
  id: string;
  address: string;
  chain: ChainIdentifier;
  data: OnchainData;
}

export interface StakingConfig {
  chain: ChainIdentifier;
  tokenAddress: string;
  contractAddress: string;
  baseRate: number;
  minLockDays: number;
  maxLockDays: number;
}

export interface StakingPosition {
  id: string;
  chain: ChainIdentifier;
  contractAddress: string;
  walletAddress: string;
  positionId: string;
  /** token base units, decimal string */
  amount: string;
  stakedAt: string;
  unlockAt: string;
  unstakedAt: string | null;
  accruedSpark: number;
  totalSpark: number;
}

export interface Wallet {
  id: string;
  userId: string;
  type: "cg_evm" | "evm" | "contract_evm";
  walletIdentifier: string;
  loginEnabled: boolean;
  visibility: "public" | "followed" | "private";
  chain: ChainIdentifier;
  [extra: string]: unknown;
}

export class ContractApi {
  constructor(private readonly transport: HttpTransport) {}

  /** POST /Contract/getContractData (public). NOT_FOUND for unknown contracts
   * on a chain that can't be live-fetched. */
  async getData(chain: ChainIdentifier, address: string): Promise<ContractData> {
    return this.transport.call("Contract/getContractData", { chain, address });
  }

  /** POST /Contract/getContractDataByIds (public, pure DB — always safe). */
  async getByIds(contractIds: string[]): Promise<ContractData[]> {
    return this.transport.call("Contract/getContractDataByIds", { contractIds });
  }
}

export class StakingApi {
  constructor(private readonly transport: HttpTransport) {}

  /** POST /Staking/getConfig (login). null when staking is unconfigured. */
  async getConfig(): Promise<{ config: StakingConfig | null }> {
    return this.transport.call("Staking/getConfig");
  }

  /** POST /Staking/getPositions (login). Indexed positions across all the
   * user's wallets; [] without an indexed chain. */
  async getPositions(): Promise<StakingPosition[]> {
    return this.transport.call("Staking/getPositions");
  }
}

export class WalletApi {
  constructor(private readonly transport: HttpTransport) {}

  /** POST /User/getWallets (login, self only). */
  async list(userId?: string): Promise<Wallet[]> {
    return this.transport.call("User/getWallets", userId !== undefined ? { userId } : {});
  }

  /** POST /User/addPreparedWallet — consumes a prior signature-challenge
   * (session.preparedCredential); a wallet is added from that. */
  async addPrepared(loginEnabled: boolean, visibility: "public" | "followed" | "private"): Promise<void> {
    await this.transport.call("User/addPreparedWallet", { loginEnabled, visibility });
  }

  async update(id: string, changes: { loginEnabled?: boolean; visibility?: "public" | "followed" | "private" }): Promise<void> {
    await this.transport.call("User/updateWallet", { id, ...changes });
  }

  async delete(id: string): Promise<void> {
    await this.transport.call("User/deleteWallet", { id });
  }
}

export type PremiumTransaction = {
  id: string;
  userId: string;
  communityId: string | null;
  amount: number;
  createdAt: string;
  data: Record<string, unknown>;
};

export class PointsApi {
  constructor(private readonly transport: HttpTransport) {}

  /** POST /User/getTransactionData (login) — the Spark/point ledger. */
  async getLedger(): Promise<PremiumTransaction[]> {
    return this.transport.call("User/getTransactionData");
  }

  /** POST /User/buyUserPremiumFeature — spends Spark (pointBalance). */
  async buyUserPremium(
    featureName: "SUPPORTER_1" | "SUPPORTER_2",
    duration: "month" | "year" | "upgrade",
  ): Promise<void> {
    await this.transport.call("User/buyUserPremiumFeature", { featureName, duration });
  }

  async setUserPremiumAutoRenew(
    featureName: "SUPPORTER_1" | "SUPPORTER_2",
    autoRenew: "MONTH" | "YEAR" | null,
  ): Promise<void> {
    await this.transport.call("User/setPremiumFeatureAutoRenew", { featureName, autoRenew });
  }
}

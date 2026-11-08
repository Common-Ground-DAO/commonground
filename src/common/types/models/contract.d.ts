// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare namespace Models {
  namespace Contract {
    type ChainIdentifier =
      'eth' |
      'optimism' |
      'arbitrum' |
      'arbitrum_nova' |
      'xdai' | 
      'matic' |
      'bsc' |
      'fantom' |
      'avax' |
      'base' |
      'celo' |
      'polygon_zkevm' |
      'scroll' |
      'zksync' |
      'linea' |
      'lukso';

    type ERC721Data = {
      type: "ERC721";
      name: string;
      symbol: string;
    };
    type ERC20Data = {
      type: "ERC20";
      name: string;
      symbol: string;
      decimals: number;
    };
    type ERC1155Data = {
      type: "ERC1155";
      name?: string;
      symbol?: string;
      withMetadataURI?: boolean;
    };
    type LSP7Data = {
      type: "LSP7";
      name: string;
      symbol: string;
      decimals: number;
      tokenType: number;
    };
    type LSP8Data = {
      type: "LSP8";
      name: string;
      symbol: string;
      tokenType: number;
    };

    type OnchainData =
      ERC20Data |
      ERC721Data |
      ERC1155Data |
      LSP7Data |
      LSP8Data;

    type WalletBalance = {
      walletId: string;
      contractId: string;
      balance: {
        type: "ERC20";
        blockHeight: number;
        amount: `${number}`;
      } | {
        type: "ERC721";
        blockHeight: number;
        amount: `${number}`;
        tokenIds?: string[];
      } | {
        type: "ERC1155";
        data: {
          blockHeight: number;
          tokenId: string;
          amount: `${number}`;
        }[];
      } | {
        type: "LSP7";
        blockHeight: number;
        amount: `${number}`;
      } | {
        type: "LSP8";
        blockHeight: number;
        amount: `${number}`;
        tokenIds?: string[];
      };
    }
    
    type Data = {
      id: string;
      address: Common.Address;
      chain: ChainIdentifier;
      data: OnchainData;
    };

    type TransferEvent = {
      type: "ERC20";
      contractAddress: Common.Address;
      blockNumber: number;
      from: Common.Address;
      to: Common.Address;
      amount: bigint;
    } | {
      type: "ERC721";
      contractAddress: Common.Address;
      blockNumber: number;
      from: Common.Address;
      to: Common.Address;
      tokenId: bigint;
      // Todo
      // maybe add tokenIds: string[] - but would only work for enumerable contracts?
    } | {
      type: "ERC1155";
      contractAddress: Common.Address;
      blockNumber: number;
      from: Common.Address;
      to: Common.Address;
      tokenIds: bigint[];
      values: bigint[];
    } | {
      type: "LSP7";
      contractAddress: Common.Address;
      blockNumber: number;
      from: Common.Address;
      to: Common.Address;
      amount: bigint;
    } | {
      type: "LSP8";
      contractAddress: Common.Address;
      blockNumber: number;
      from: Common.Address;
      to: Common.Address;
      tokenId: string;
    };

    type SaleContractType = 'cg_tokensale_v1';
    type SaleInvestmentEventJson = {
      type: Extract<SaleContractType, 'cg_tokensale_v1'>;
      userId: string;
      bigint_investedAmount: string;
      bigint_saleProgressBefore: string;
      investmentId: number;
      blockNumber: number;
      dateIsoString_timestamp: string;
      txHash: string;
    };
  }
}
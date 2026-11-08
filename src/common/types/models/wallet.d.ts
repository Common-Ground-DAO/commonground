// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare namespace Models {
  namespace Wallet {
    type Visibility = "public" | "followed" | "private";
    type Type = "cg_evm" | "evm" | "contract_evm";
    type WalletIdentifier = Common.Address;
    type ContractWalletType = 'universal_profile';
    type ContractWalletData = {
      type: ContractWalletType;
    };

    type Wallet = {
      id: string;
      userId: string;
      type: Type;
      walletIdentifier: WalletIdentifier;
      loginEnabled: boolean;
      visibility: Visibility;
      chain: Models.Contract.ChainIdentifier | null;
      signatureData: {
        data: API.User.SignableWalletData | null;
        legacyData?: any;
        contractData?: ContractWalletData;
        signature: string;
      };
    };

    type ProfileWalletData = {
      type: Type;
      visibility: Visibility;
      walletIdentifier: WalletIdentifier;
      chain: Models.Contract.ChainIdentifier | null;
    }
  }
}
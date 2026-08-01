// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare namespace Models {
  namespace Wallet {
    type Visibility = "public" | "followed" | "private";
    // `fuel` and `aeternity` are legacy stored types: their login/connect flows were
    // removed (2026-08-01), but existing `wallets` rows keep the type and are still listed.
    type Type = "cg_evm" | "evm" | "fuel" | "aeternity" | "contract_evm";
    type WalletIdentifier = Common.Address | Common.FuelAddress | Common.AeternityAddress;
    type ContractWalletType = 'universal_profile';
    type ContractWalletData = {
      type: ContractWalletType;
    };

    type Wallet = {
      id: string;
      userId: string;
      loginEnabled: boolean;
      visibility: Visibility;
      chain: Models.Contract.ChainIdentifier | null;
      signatureData: {
        data: API.User.SignableWalletData | null;
        legacyData?: any;
        contractData?: ContractWalletData;
        signature: string;
      };
    } & ({
      type: Extract<Type, "fuel">;
      walletIdentifier: Common.FuelAddress;
    } | {
      type: Extract<Type, "evm" | "cg_evm" | "contract_evm">;
      walletIdentifier: Common.Address;
    } | {
      type: Extract<Type, "aeternity">;
      walletIdentifier: Common.AeternityAddress;
    });

    type ProfileWalletData = {
      type: Type;
      visibility: Visibility;
      walletIdentifier: WalletIdentifier;
      chain: Models.Contract.ChainIdentifier | null;
    }
  }
}
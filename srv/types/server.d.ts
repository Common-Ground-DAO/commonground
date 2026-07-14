// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare {
    namespace API {
        namespace Server {
            interface InterServerEvents { // Events both listened to and sent by the server
                "getContractData": (
                    data: {
                        chainId: Models.Contract.ChainIdentifier,
                        address: Common.Address,
                    },
                    callback: (data: Models.Contract.Data) => void,
                ) => Promise<void>,
                "checkRoleAccess": (
                    data: {
                        userId: string,
                        roleId: string,
                    },
                    callback: (allowed: boolean) => void,
                ) => Promise<void>,
            }

            interface SocketData {
                userId?: string;
                deviceId?: string;
                botTokenId?: string;
                signableSecret?: string;
                temporaryCommunityId?: string;
                walletRequestId?: string;
            }
        }
    }

    namespace Models {
        namespace Server {
            interface OnchainLogs {
                gainedToken: {
                    wallet: Address;
                    contract: Address;
                }[] = [];
                reducedToken: {
                    wallet: Address;
                    contract: Address;
                }[] = [];
            }

            interface OnchainConnector {
                watchContract: (
                    contractData: Omit<Models.Contract.Data, "id"> & Partial<Pick<Models.Contract.Data, "id">>
                ) => void;
                watchSpecialContract: (
                    data: Models.Wallet.ContractWalletData,
                    address: Common.Address,
                ) => void;
                contractData: (
                    contractAddress: Address,
                    priority: number,
                ) => Promise<Omit<Models.Contract.Data, 'id'>>;
                getBalance: (
                    address: Address,
                    contractData: Models.Contract.Data,
                    gatingRule: GatingRule,
                    priority: number,
                ) => Promise<{
                    balance: bigint;
                    blockHeight: number;
                }>;
                startEventListener: () => void;
            }

            namespace Session {
                type PreparedCredential = {
                    type: "wallet";
                    preWallet?: Omit<Models.Wallet.Wallet, "id" | "userId">;
                    result: API.User.prepareWalletAction.Response;
                    ownerId?: string;
                }
            }
        }
    }
}

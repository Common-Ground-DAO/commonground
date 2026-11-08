// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare namespace Models {
    namespace Premium {
        type TransactionFeatureName = Models.Community.PremiumName | "VISIBILITY" | "TOKENS_ROLES_1" | "TOKENS_ROLES_2" | "CALLS_1" | "CALLS_2" | "COSMETICS_1" | "URL_CHANGE";

        type TransactionData = {
            type: 'user-onchain-buy';
            chain: Models.Contract.ChainIdentifier;
            senderIdentifier: string;
            txHash: string;
            blockNumber: number;
        } | {
            type: 'user-spend';
            featureName: Models.User.PremiumFeatureName;
            triggeredBy: Common.PremiumRenewal | 'MANUAL';
        } | {
            type: 'user-donate-community';
        } | {
            type: 'community-spend';
            featureName: TransactionFeatureName;
            triggeredBy: Common.PremiumRenewal | 'MANUAL';
        } | {
            type: 'platform-donation';
            emoji: string;
            text: string;
        } | {
            type: 'staking-accrual';
            chain: Models.Contract.ChainIdentifier;
            contractAddress: string;
            /** Onchain per-owner position id. */
            positionId: string;
            /** Timestamp the pro-rata accrual target was computed at. */
            periodEnd: string;
        };

        type Transaction = {
            id: string;
            userId: string | null;
            communityId: string | null;
            amount: number;
            createdAt: Date;
            data: TransactionData;
        };

        type TransactionFromApi = Omit<Transaction, "createdAt"> & {
            createdAt: string;
        }
    }
}
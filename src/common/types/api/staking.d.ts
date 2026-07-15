// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare global {
    namespace API {
        namespace Staking {
            type Config = {
                chain: Models.Contract.ChainIdentifier;
                tokenAddress: string;
                contractAddress: string;
                /** Spark per CG token per 365 days. */
                baseRate: number;
                minLockDays: number;
                maxLockDays: number;
            };

            type PositionView = {
                id: string;
                chain: Models.Contract.ChainIdentifier;
                contractAddress: string;
                walletAddress: string;
                /** Onchain per-owner position id. */
                positionId: string;
                /** Token base units as decimal string. */
                amount: string;
                stakedAt: string;
                unlockAt: string;
                unstakedAt: string | null;
                /** Spark credited so far. */
                accruedSpark: number;
                /** Total Spark this position earns over its full lock. */
                totalSpark: number;
            };

            namespace getConfig {
                type Request = undefined;
                type Response = { config: Config | null };
            }

            namespace getPositions {
                type Request = undefined;
                type Response = PositionView[];
            }
        }
    }
}

export {};

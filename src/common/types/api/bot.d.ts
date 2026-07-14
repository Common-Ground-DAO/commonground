// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare global {
    namespace API {
        namespace Bot {
            type ProtocolVersion = '1';

            type PlatformPresence = {
                mode: Models.User.BotPlatformPresenceMode;
                communityIds: string[];
            };

            type BotView = {
                userId: string;
                deviceId: string;
                ownerType: Models.User.BotOwnerType;
                ownerId: string | null;
                owner: Models.User.BotOwnerSummary;
                username: string;
                imageId: string | null;
                description: string | null;
                platformPresence: PlatformPresence | null;
                communityIds: string[];
                createdAt: string;
                updatedAt: string;
                disabledAt: string | null;
            };

            type TokenView = {
                id: string;
                botUserId: string;
                name: string | null;
                lastUsedAt: string | null;
                createdAt: string;
                revokedAt: string | null;
            };

            type CommunityBotView = Pick<BotView,
                'userId' | 'ownerType' | 'ownerId' | 'owner' | 'username' | 'imageId' | 'description'
            > & {
                roleIds: string[];
            };

            type InstallableUserBotView = Pick<BotView, 'userId' | 'username' | 'imageId' | 'description'> & {
                ownerUserId: string;
                ownerUsername: string;
            };

            type Owner = {
                ownerType: Models.User.BotOwnerType;
                ownerId: string | null;
            };

            namespace listBots {
                type Request = Owner;
                type Response = BotView[];
            }

            namespace listCommunityBots {
                type Request = { communityId: string };
                type Response = CommunityBotView[];
            }

            namespace listInstallableUserBots {
                type Request = {
                    communityId: string;
                    query: string | null;
                    cursor: string | null;
                    limit: number;
                };
                type Response = {
                    items: InstallableUserBotView[];
                    nextCursor: string | null;
                };
            }

            namespace createBot {
                type Request = Owner & {
                    username: string;
                    imageId: string | null;
                    description: string | null;
                    platformPresence?: PlatformPresence;
                };
                type Response = BotView;
            }

            namespace updateBot {
                type Request = {
                    botUserId: string;
                    username?: string;
                    imageId?: string | null;
                    description?: string | null;
                    platformPresence?: PlatformPresence;
                };
                type Response = BotView;
            }

            namespace disableBot {
                type Request = { botUserId: string };
                type Response = void;
            }

            namespace installBot {
                type Request = {
                    botUserId: string;
                    communityId: string;
                    roleIds: string[];
                };
                type Response = void;
            }

            namespace removeBot {
                type Request = {
                    botUserId: string;
                    communityId: string;
                };
                type Response = void;
            }

            namespace setBotRoles {
                type Request = {
                    botUserId: string;
                    communityId: string;
                    roleIds: string[];
                };
                type Response = void;
            }

            namespace setAllowUserBots {
                type Request = {
                    communityId: string;
                    allowUserBots: boolean;
                };
                type Response = void;
            }

            namespace issueToken {
                type Request = { botUserId: string; name: string | null };
                type Response = { token: string; tokenData: TokenView };
            }

            namespace listTokens {
                type Request = { botUserId: string };
                type Response = TokenView[];
            }

            namespace revokeToken {
                type Request = { botUserId: string; tokenId: string };
                type Response = void;
            }

            namespace whoami {
                type Request = undefined;
                type Response = {
                    protocolVersion: ProtocolVersion;
                    userId: string;
                    deviceId: string;
                    tokenId: string;
                };
            }
        }
    }
}

export { };

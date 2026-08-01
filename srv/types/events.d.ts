// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare {
    namespace Events {
        type ClientEvent = (
            Events.Bot.Event |
            Events.Community.Event |
            Events.Message.Event |
            Events.Notification.Event |
            Events.User.Event |
            Events.Chat.Event |
            Events.Calls.Event |
            Events.Channel.Event |
            Events.CgId.Event
        );

        namespace PgNotify {
            type UserDataChange = {
                type: 'userdatachange';
                userId: string;
                onlineStatus: Models.User.OnlineStatus;
                displayAccount: Models.User.ProfileItemType | null;
                platformBan: Models.User.PlatformBan | null;
                accounts: {
                    displayName: string;
                    type: Models.User.ProfileItemType;
                }[];
            };
            type UserRoleChange = {
                type: 'userrolechange';
                userId: string;
                roleId: string;
                hasRole: boolean;
            };
            type CommunityRoleChange = {
                type: 'rolechange';
                roleId: string;
                communityId: string;
                title: string;
                roleType: Common.RoleType;
                deleted: boolean;
            };
            type ChannelRolePermissionChange = {
                type: 'channelrolepermissionchange';
                communityId: string;
                roleId: string;
                channelId: string;
                permissions: Common.ChannelPermission[];
            };

            type CallChange = {
                type: 'callchange';
                id: string;
                communityId: string;
                channelId: string;
                callServerId: string;
                title: string;
                description: string | null;
                previewUserIds: string[];
                slots: number;
                stageSlots: number;
                highQuality: boolean;
                audioOnly: boolean;
                startedAt: string;
                updatedAt: string;
                endedAt: string | null;
                action: 'INSERT' | 'UPDATE';
            };
            type CallMemberChange = {
                type: 'callmemberchange';
                id: string;
                callId: string;
                userId: string;
                joinedAt: string;
                leftAt: string | null;
                action: 'INSERT' | 'UPDATE';
            };
            type CallServerChange = {
                type: 'callserverchange';
                id: string;
                status: Models.Server.CallServerStatus;
                url: string;
                updatedAt: string;
                deletedAt: string | null;
                action: 'INSERT' | 'UPDATE';
            };
            type CallServerCallUpdate = {
                type: `callservercallupdate_${string}`; // callServerId
                callId: string;
                slots: number;
                stageSlots: number;
                highQuality: boolean;
                audioOnly: boolean;
            };

            type ContractChange = {
                type: 'contractchange';
                id: string;
                address: Common.Address;
                chain: Models.Contract.ChainIdentifier;
                data: Models.Contract.OnchainData;
                action: 'INSERT' | 'UPDATE';
            };
            type WalletChange = {
                type: 'walletchange';
                id: string;
                userId: string;
                chain: Models.Contract.ChainIdentifier | null;
                walletIdentifier: Models.Wallet.WalletIdentifier;
                walletType: Models.Wallet.Wallet["type"];
                signatureData: Models.Wallet.Wallet["signatureData"];
                updatedAt: string;
                deletedAt: string | null;
                action: 'INSERT' | 'UPDATE';
            };
        }
    }
}

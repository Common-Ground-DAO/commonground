// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare namespace Models {
    namespace ItemList {
        type Item = {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            sendStatus?: "sending" | "error-send" | "error-update";
        };

        type ItemListInitOptions = {
            minimumItemCount?: number;
        } & ({
            type: "recent";
        } | {
            type: "atItemId";
            itemId: string;
        } | {
            type: "atDate";
            date: Date;
        });

        type ItemListState<T extends Item> = {
            items: T[];
            isDestroyed: boolean;
            ready: boolean;
            rangeStart: Date | null;
            rangeEnd: Date | null;
            hasNextItemsLocally: boolean;
            hasNextItemsOnRemote: boolean;
            hasPreviousItemsLocally: boolean;
            hasPreviousItemsOnRemote: boolean;
            withStartOfList: boolean;
            withEndOfList: boolean;
            isEmpty: boolean;
        }
    }
}
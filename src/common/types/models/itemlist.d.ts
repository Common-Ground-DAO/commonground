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

        type Chunk = {
            chunkId?: number;
            __dbName: string;
            startDate: Date;
            endDate: Date;
            itemCount: number;
            lastUpdate: Date;
            lastAccessed: Date;
            nextChunk: Chunk | null | 'end-of-list';
            previousChunk: Chunk | null | 'end-of-list';
        };

        type ChunkFromDb = {
            chunkId: number;
            __dbName: string;
            startDate: Date;
            endDate: Date;
            itemCount: number;
            lastUpdate: Date;
            lastAccessed: Date;
            nextChunkId: number | null | 'end-of-list';
            previousChunkId: number | null | 'end-of-list';
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

        type ItemListUpdateOptions = ({
            growStart?: number;
            shrinkStart?: number;
            growEnd?: number;
            shrinkEnd?: number;
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

        type ItemListUpdateListener<T extends Item> = (data: ItemListState<T>) => void;

        interface ItemList<T extends Item> {
            items: T[];
            state: ItemListState<T>;
            ready: Promise<void>;
            init(options: ItemListInitOptions): Promise<number>;
            addUpdateListener: (listener: ItemListUpdateListener<T>) => void;
            removeUpdateListener: (listener: ItemListUpdateListener<T>) => void;
            destroy(notify?: boolean): void;
            update(options: ItemListUpdateOptions): Promise<void>;
            chunksChangedListener(allChunks: Chunk[]): void;
        };

        type ItemRangeUpdateJob = {
            rangeStart: Date;
            rangeEnd: Date;
            updatedAfter: Date;
        };

        type ItemRangeUpdateResult<T extends Item> = {
            updated: T[];
            deleted: string[];
            job: ItemRangeUpdateJob;
        };
    }
}
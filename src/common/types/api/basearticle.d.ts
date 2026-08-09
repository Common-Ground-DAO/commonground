// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare global {
    namespace API {
        namespace BaseArticle {
            type getArticleListRequest = {
                order?: 'ASC' | 'DESC';
                orderBy?: 'updatedAt' | 'published'; // defaults to published
                updatedAfter?: string;
                updatedBefore?: string;
                publishedAfter?: string;
                publishedBefore?: string;
                // Cursor tiebreakers for the selected orderBy field, to page
                // deterministically through rows sharing a timestamp. Pair with
                // the matching timestamp bound: beforeId with publishedBefore/
                // updatedBefore (DESC), afterId with publishedAfter/updatedAfter
                // (ASC). The timestamp-only form remains valid.
                beforeId?: string;
                afterId?: string;
                limit: number; // max 30, see validator
                tags?: string[];
                drafts?: true;
                verification?: "verified" | "unverified" | "both" | "following"; // defaults to both
                ids?: string[];
            };
        }
    }
}

export { };
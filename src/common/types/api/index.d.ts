// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare global {
    namespace API {
        type AjaxResponse<T> = {
            error: string;
            status: "ERROR";
            /**
             * RATE_LIMIT_EXCEEDED only: seconds until the limit lets the
             * next attempt through (also sent as the Retry-After header)
             */
            retryAfterSeconds?: number;
            /**
             * RATE_LIMIT_EXCEEDED only: what was limited — accounts from the
             * network, mails, or attempts (srv/util/rateLimitError.ts)
             */
            limit?: "accounts" | "mail" | "attempts";
        } | (T extends void | undefined ? {
            status: "OK";
        } : {
            data: T;
            status: "OK";
        });
    }
}

export { };
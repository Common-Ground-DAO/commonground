// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare global {
    namespace API {
        namespace Accounts {
            namespace Farcaster {
                namespace verifyLogin {
                    type Request = {
                        message: string;
                        signature: string;
                    };
                    type Response = {
                        readyForLogin: boolean;
                        readyForCreation: boolean;
                        fid: number;
                        displayName: string;
                        username: string;
                        bio?: string;
                        url?: string;
                        imageId: string | null;
                    };
                }
            }
        }
    }
}

export { };
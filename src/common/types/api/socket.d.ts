// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare global {
    namespace API {
        namespace Socket {
            namespace getSignableSecret {
                type Request = undefined;
                type Response = string;
            }

            namespace login {
                type Request = {
                    secret: string;
                    deviceId: string,
                    base64Signature: string;
                };
                type Response = "OK" | "ERROR";
            }

            namespace logout {
                type Request = undefined;
                type Response = void;
            }

            namespace joinCommunityVisitorRoom {
                type Request = {
                    communityId: string;
                };
                type Response = void;
            }

            namespace setTyping {
                type Request = {
                    access: API.Messages.MessageAccess;
                    isTyping: boolean;
                };
                type Response = void;
            }

            namespace leaveCommunityVisitorRoom {
                type Request = undefined;
                type Response = void;
            }

            namespace prepareWalletRequest {
                type Request = undefined;
                type Response = {
                    requestId: string;
                };
            }
        }
    }
}

export { };
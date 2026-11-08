// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare global {
    namespace API {
        namespace Chat {
            namespace startChat {
                type Request = {
                    otherUserId: string;
                }
                type Response = Models.Chat.ChatFromApi;
            }

            namespace closeChat {
                type Request = {
                    chatId: string;
                }
                type Response = void
            }

            namespace getChats {
                type Request = undefined;
                type Response = Models.Chat.ChatFromApi[];
            }
        }
    }
}

export { };
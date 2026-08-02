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

            type AssistantTemplate = 'community_v1' | 'user_v1';

            type AssistantQueueData = {
                ownPriority: number;
                ownScore: number;
                queuedBefore: [number, number][];
            };

            namespace getOwnAssistantChats {
                type Request = {
                    type: 'community';
                    communityId: string;
                } | {
                    type: 'user';
                };
                type Response = {
                    dialogId: string;
                    model: Assistant.ModelName;
                    createdAt: string;
                    updatedAt: string;
                }[];
            }

            namespace loadAssistantChat {
                type Request = {
                    dialogId: string;
                };
                type Response = {
                    model: Assistant.ModelName;
                    messages: Assistant.Message[];
                };
            }

            namespace startAssistantChat {
                type Request = {
                    template: Extract<AssistantTemplate, 'community_v1'>;
                    model: Assistant.ModelName;
                    communityId: string;
                    message: string;
                } | {
                    template: Extract<AssistantTemplate, 'user_v1'>;
                    model: Assistant.ModelName;
                    message: string;
                };
                type Response = {
                    dialogId: string;
                    createdAt: string;
                    queueData: AssistantQueueData;
                };
            }

            namespace continueAssistantChat {
                type Request = {
                    dialogId: string;
                    message: string;
                };
                type Response = {
                    queueData: AssistantQueueData;
                };
            }

            namespace deleteAssistantChat {
                type Request = {
                    dialogId: string;
                };
                type Response = void;
            }

            namespace getAssistantQueueData {
                type Request = {
                    ownPriority: number;
                    ownScore: number;
                    model: Assistant.ModelName;
                };
                type Response = AssistantQueueData;
            }

            namespace getAssistantAvailability {
                type Request = undefined;
                type Response = {
                    assistants: {
                        modelName: Assistant.ModelName;
                        title: string;
                        isAvailable: boolean;
                    }[];
                };
            }
        }
    }
}

export { };
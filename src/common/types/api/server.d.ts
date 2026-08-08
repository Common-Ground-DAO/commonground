// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare global {
    namespace API {
        namespace Server {
            interface ServerToClientEvents { // Events listened to on the server
                "getSignableSecret": (
                    callback: (secret: string) => void
                ) => void,
                "cgPing": (
                    callback: (timestamp: number) => void
                ) => void,
                "login": (
                    data: API.Socket.login.Request,
                    callback: (data: API.Socket.login.Response) => void,
                ) => Promise<void>,
                "logout": () => void,
                "joinCommunityVisitorRoom": (
                    data: { communityId: string },
                ) => void,
                "leaveCommunityVisitorRoom": () => void,
                "setTyping": (
                    data: API.Socket.setTyping.Request,
                ) => void,
                "prepareWalletRequest": (
                    callback: (requestId: string) => void,
                ) => void,
            }
            type ClientToServerEvents = { // Events sent by the server
                [T in (Events.ClientEvent["type"] | "buildId")]:
                T extends "buildId"
                ? (
                    buildId: string,
                    time: number
                ) => void
                : (
                    event: Omit<Events.ClientEvent & { type: typeof T }, "type">
                ) => void
            }
        }
    }
}

export { };
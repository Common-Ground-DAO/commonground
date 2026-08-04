// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import {
    type AuthenticationResponseJSON,
    type PublicKeyCredentialCreationOptionsJSON,
    type PublicKeyCredentialRequestOptionsJSON,
    type RegistrationResponseJSON,
    type AuthenticatorTransportFuture
} from "@simplewebauthn/browser";

declare global {
    namespace API {
        namespace CgId {
            namespace ensureSession {
                type Request = undefined;
                type Response = undefined;
            }

            namespace getLoggedInUserData {
                type Request = undefined;
                type Response = {
                    userId: string;
                    passkeys: {
                        credentialID: string;
                        credentialDeviceType: string;
                        credentialBackedUp: any;
                        transports?: AuthenticatorTransportFuture[];
                    }[];
                } | null;
            }

            namespace generateRegistrationOptions {
                type Request = {
                    timezone: string;
                };
                type Response = PublicKeyCredentialCreationOptionsJSON;
            }

            namespace generateAuthenticationOptions {
                type Request = {
                    userId?: string;
                };
                type Response = PublicKeyCredentialRequestOptionsJSON;
            }

            namespace verifyRegistrationResponse {
                type Request = {
                    frontendRequestId: string;
                    registrationResponse: RegistrationResponseJSON;
                };
                type Response = boolean;
            }

            namespace verifyAuthenticationResponse {
                type Request = {
                    frontendRequestId: string;
                    authenticationResponse: AuthenticationResponseJSON;
                };
                type Response = boolean;
            }
        }
    }
}

export { };
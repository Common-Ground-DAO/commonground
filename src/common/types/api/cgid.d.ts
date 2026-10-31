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

// Legacy CG ID app (srv/api/cgid.ts): only served by a process running with
// CG_LEGACY_CGID=true, and there only ensureSession, generateAuthenticationOptions
// and verifyAuthenticationResponse. getLoggedInUserData and the registration
// pair have no backend any more; their types stay until the CG ID app
// (src/cgid) is deleted.
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
                type Request = Record<string, never>;
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
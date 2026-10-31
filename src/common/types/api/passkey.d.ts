// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import {
    type PublicKeyCredentialCreationOptionsJSON,
    type PublicKeyCredentialRequestOptionsJSON,
    type RegistrationResponseJSON,
} from "@simplewebauthn/browser";

// Passkeys on the instance's own origin (srv/api/passkeys.ts,
// docs/auth-identity §7). Not mounted on a legacy CG ID (gateway) process.
declare global {
    namespace API {
        namespace Passkey {
            namespace registrationOptions {
                type Request = {
                    /** anonymous (sign-up) callers: the profile name the passkey is labelled with */
                    displayName?: string;
                };
                type Response = PublicKeyCredentialCreationOptionsJSON;
            }

            namespace verifyRegistration {
                type Request = {
                    registrationResponse: RegistrationResponseJSON;
                    /** optional label; defaults to the browser and OS */
                    name?: string;
                };
                type Response = {
                    /** logged in: the passkey was added to the account */
                    status: 'attached';
                    passkeys: Models.Passkey.Info[];
                } | {
                    /** sign-up: kept in the session until User/createUser {usePreparedPasskey} */
                    status: 'pending';
                };
            }

            namespace authenticationOptions {
                type Request = {
                    /** login: anonymous, discoverable credentials only; stepup: the session user's credentials */
                    purpose: 'login' | 'stepup';
                    /** conditional mediation (autofill) */
                    conditional?: boolean;
                };
                type Response = PublicKeyCredentialRequestOptionsJSON;
            }

            namespace list {
                type Request = Record<string, never>;
                type Response = Models.Passkey.Info[];
            }

            namespace rename {
                type Request = {
                    id: string;
                    name: string;
                };
                type Response = void;
            }

            namespace remove {
                type Request = {
                    id: string;
                };
                type Response = void;
            }
        }
    }
}

export { };

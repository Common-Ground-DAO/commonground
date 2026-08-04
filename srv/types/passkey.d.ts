// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import {
    type PublicKeyCredentialCreationOptionsJSON,
    type PublicKeyCredentialRequestOptionsJSON,
    type RegistrationResponseJSON,
    type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";

declare global {    
    namespace Models {
        namespace Passkey {
            type FullData = {
                webAuthnUserID: string;
                credentialID: string;
                credentialPublicKeyBase64: string;
                credentialDeviceType: string;
                credentialBackedUp: boolean;
                transports?: AuthenticatorTransportFuture[];
                debugData?: {
                    registrationOptions: PublicKeyCredentialCreationOptionsJSON;
                    registrationResponse: RegistrationResponseJSON;
                    deviceInfo: any;
                };
            };
        }
    }
}
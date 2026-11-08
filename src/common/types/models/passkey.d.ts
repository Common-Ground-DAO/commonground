// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare namespace Models {
    namespace Passkey {
        type Data = {
            credentialID: string;
            credentialBackedUp: boolean;
            credentialDeviceType: string;
            createdAt: string;
            updatedAt: string;
        };

        /** One credential of the session user on this instance's relying party (Passkey/list). */
        type Info = {
            id: string;
            credentialID: string;
            /** WebAuthn user handle (base64url) the credential was created with; for browser signals */
            userHandle: string;
            name: string | null;
            credentialDeviceType: string;
            credentialBackedUp: boolean;
            transports?: ("ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb")[];
            createdAt: string;
            lastUsedAt: string | null;
        };
    }
}
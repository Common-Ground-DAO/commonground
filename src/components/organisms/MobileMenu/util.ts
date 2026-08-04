// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Determine the mobile operating system.
 * This function returns one of 'iOS', 'Android', 'Windows Phone', or 'unknown'.
 *
 * @returns {String}
 */
export function getMobileOperatingSystem() {
    var userAgent = navigator.userAgent;

    if (/android/i.test(userAgent)) {
        return "Android";
    }

    // iOS detection from: http://stackoverflow.com/a/9039885/177710
    // (`MSStream` is an old IE-on-Windows-Phone global; it was only typed here
    // by an ambient declaration `@metamask/sdk` happened to ship, which stopped
    // being in scope when that direct dependency was dropped.)
    if (/iPad|iPhone|iPod/.test(userAgent) && !(window as any).MSStream) {
        return "iOS";
    }

    return "unknown";
}
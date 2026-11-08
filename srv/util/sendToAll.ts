// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Sends one mail per recipient and never rejects: failures are logged (via
 * `describe`, so no addresses end up in the log) and counted. The notification
 * jobs mark an article/event as sent either way — failing the whole batch would
 * re-send it to everyone who already got it on the next run (they run every
 * minute), while a failed recipient only misses this one notification.
 */
export async function sendToAll<T>(
    label: string,
    recipients: T[],
    describe: (recipient: T, index: number) => string,
    send: (recipient: T) => Promise<unknown>,
): Promise<{ sent: number, failed: number }> {
    const results = await Promise.allSettled(recipients.map(recipient => send(recipient)));
    let failed = 0;
    results.forEach((result, i) => {
        if (result.status === 'rejected') {
            failed++;
            const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
            console.error(`${label}: sending to ${describe(recipients[i], i)} failed: ${reason}`);
        }
    });
    console.log(`${label}: ${results.length - failed} sent, ${failed} failed`);
    return { sent: results.length - failed, failed };
}

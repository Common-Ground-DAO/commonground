// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { createHash } from 'node:crypto';
import { isMainThread } from 'worker_threads';
import emailBounceHelper from '../repositories/emailBounces';
import { createBounceReceiver } from '../util/bounceReceiverServer';
import { bouncePolicyFromEnv } from '../util/bouncePolicy';
import { dsnMessageId, parseDsn, permanentlyFailed } from '../util/dsn';

// Bounce handling for the selfhost mail relay (docs/email-notifications,
// "Bounces"). The relay (docker/mail/maddy.conf) turns every permanent
// delivery failure into a delivery status notification and delivers it here,
// logging in with the same relay login the app submits with. Each permanent
// failure is recorded; srv/util/bouncePolicy.ts decides when an address is
// unverified (repeated bounces, never during a burst). Started by jobs.ts
// only with MAIL_BOUNCE_RECEIVER=true.

if (isMainThread) {
    throw new Error('bounceReceiver can only be run as a worker job');
}

// docker/mail/maddy.conf, target.smtp bounce_receiver
const BOUNCE_RECEIVER_PORT = 2525;

const user = process.env.SMTP_USER;
const password = process.env.SMTP_PASSWORD;
if (!user || !password) {
    // jobs.ts checks this before starting the worker
    throw new Error('bounceReceiver: SMTP_USER/SMTP_PASSWORD are not set');
}
const policy = bouncePolicyFromEnv(process.env);
// warn once per burst window, not once per report
let lastBurstWarning = 0;

const server = createBounceReceiver({
    user,
    password,
    relayHost: process.env.MAIL_RELAY_HOST || 'mail',
    onMessage: async (raw) => {
        const recipients = parseDsn(raw);
        if (!recipients) {
            console.warn('bounceReceiver: received a message that is not a delivery status report, ignored');
            return;
        }
        const failed = permanentlyFailed(recipients);
        // e.g. "30× failed 5.0.0, 1× delayed 4.0.0"
        const counts = new Map<string, number>();
        for (const r of recipients) {
            const key = `${r.action} ${r.status}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const statuses = [...counts].map(([key, n]) => `${n}× ${key}`).join(', ');
        if (failed.length === 0) {
            console.log(`bounceReceiver: report with ${recipients.length} recipient(s) [${statuses}], no permanent failure`);
            return;
        }
        // one report per failed message; a report without Message-ID is
        // identified by its content, so a re-delivery is still recognized
        const reportId = dsnMessageId(raw) ?? `sha256:${createHash('sha256').update(raw).digest('hex').slice(0, 40)}`;
        // throws on DB errors -> 451 -> the relay keeps the report queued and retries
        const result = await emailBounceHelper.recordReport(reportId, failed, policy);

        if (result.burst.global || result.burst.domains.length > 0) {
            const now = Date.now();
            if (now - lastBurstWarning > policy.burstWindowMs) {
                lastBurstWarning = now;
                const diagnostics = await emailBounceHelper.recentDiagnostics(policy.burstWindowMs);
                const what = result.burst.global
                    ? `${result.burst.addresses} different addresses bounced`
                    : `more than ${policy.burstDomainAddresses} addresses of ${result.burst.domains.join(', ')} bounced`;
                const spared = result.burst.global ? 'no address is marked unverified' : `no address of ${result.burst.domains.join(', ')} is marked unverified`;
                console.error(`!!! bounceReceiver: ${what} within ${policy.burstWindowMs / 60_000} minutes. `
                    + `This looks like a problem of this server — blocklisted IP, SPF/DKIM/DMARC or PTR records — not of the addresses, `
                    + `so these bounces don't count and ${spared}. Check "./selfhost/selfhost.sh mail-dns" and the relay log. `
                    + `Latest answers from the receiving servers: ${diagnostics.map(d => JSON.stringify(d)).join(' | ') || '(none given)'} !!!`);
            }
        }
        console.log(`bounceReceiver: report with ${recipients.length} recipient(s) [${statuses}]: `
            + `${result.recorded} bounce(s) recorded, ${result.unverify.length} address(es) past the policy, `
            + `${result.usersUnverified} user(s) marked unverified`
            + (result.burst.global ? ' (burst: none counted)'
                : result.burst.domains.length ? ` (burst in ${result.burst.domains.join(', ')}: not counted there)` : ''));
    },
});

// smtp-server also reports single client errors here (the wrapper logs
// them); only a failure to listen ends the worker (jobs.ts restarts it)
server.on('error', (e: NodeJS.ErrnoException) => {
    if (e?.code === 'EADDRINUSE' || e?.code === 'EACCES') {
        console.error('bounceReceiver: cannot listen', e);
        process.exit(1);
    }
});
server.listen(BOUNCE_RECEIVER_PORT, '0.0.0.0', () => {
    console.log(`bounceReceiver: listening on port ${BOUNCE_RECEIVER_PORT} for the mail relay's bounce reports`);
});

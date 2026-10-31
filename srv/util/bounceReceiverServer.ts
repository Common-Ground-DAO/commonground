// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { lookup as dnsLookup } from 'node:dns/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { SMTPServer, type SMTPServerAuthentication, type SMTPServerSession } from 'smtp-server';

// SMTP listener for exactly one client: the selfhost mail relay, which
// delivers the bounce reports it generates here (srv/jobs/bounceReceiver.ts,
// docker/mail/maddy.conf). Built on smtp-server; this wrapper narrows it down:
//   - connections from any address other than the relay host's are refused
//     (the job-runner sits on the shared `cryptogram` network too),
//   - AUTH PLAIN with the relay login is required before MAIL; the third
//     failed attempt closes the connection,
//   - no STARTTLS (internal network only), 1 MB per message, few clients,
//     short timeouts and an absolute limit per connection.

export type BounceReceiverOptions = {
    user: string;
    password: string;
    /** host name of the relay (compose service `mail`); resolved on every connection */
    relayHost: string;
    /** called once per received message; a rejection answers 451 (the relay retries) */
    onMessage: (raw: string) => Promise<void>;
    maxMessageBytes?: number;
    maxClients?: number;
    idleTimeoutMs?: number;
    sessionLimitMs?: number;
    /** for tests: resolves a host name to its addresses */
    lookup?: (host: string) => Promise<string[]>;
};

const MAX_AUTH_FAILURES = 3;

const defaultLookup = async (host: string) => (await dnsLookup(host, { all: true })).map(a => a.address);

// IPv4-mapped IPv6 (::ffff:a.b.c.d) and plain IPv4 compare equal
const normalizeIp = (ip: string) => ip.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');

// constant-time compare of fixed-length digests, so neither content nor length leaks
const digest = (s: string) => createHash('sha256').update(s).digest();
const sameSecret = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

function smtpError(message: string, responseCode: number): Error {
    return Object.assign(new Error(message), { responseCode });
}

export function createBounceReceiver(options: BounceReceiverOptions): SMTPServer {
    const maxBytes = options.maxMessageBytes ?? 1024 * 1024;
    const lookup = options.lookup ?? defaultLookup;
    const sessionLimitMs = options.sessionLimitMs ?? 5 * 60_000;
    const authFailures = new Map<string, number>();
    const sessionTimers = new Map<string, NodeJS.Timeout>();

    const server: SMTPServer = new SMTPServer({
        secure: false,
        disabledCommands: ['STARTTLS'],
        authMethods: ['PLAIN'],
        allowInsecureAuth: true,
        size: maxBytes,
        maxClients: options.maxClients ?? 10,
        socketTimeout: options.idleTimeoutMs ?? 60_000,
        closeTimeout: 5_000,
        maxAllowedUnauthenticatedCommands: 5,
        banner: 'bounce receiver',
        logger: false,

        onConnect(session, callback) {
            const remote = normalizeIp(session.remoteAddress || '');
            lookup(options.relayHost).then(addresses => {
                if (!addresses.map(normalizeIp).includes(remote)) {
                    console.warn(`bounce receiver: refused a connection from ${remote} (not the mail relay)`);
                    return callback(smtpError('Not allowed', 554));
                }
                // absolute limit per connection, on top of the idle timeout;
                // a 421 reply makes smtp-server close the connection
                const connections = (server as unknown as { connections: Set<{ id: string, send: (code: number, msg: string) => void }> }).connections;
                const connection = [...connections].find(c => c.id === session.id);
                if (connection) {
                    const timer = setTimeout(() => connection.send(421, 'Session time limit reached'), sessionLimitMs);
                    timer.unref();
                    sessionTimers.set(session.id, timer);
                }
                callback();
            }, () => {
                // relay host not resolvable (relay not running): nobody else gets in
                callback(smtpError('Not allowed', 554));
            });
        },

        onAuth(auth: SMTPServerAuthentication, session: SMTPServerSession, callback) {
            if (auth.method === 'PLAIN'
                && sameSecret(auth.username || '', options.user)
                && sameSecret(auth.password || '', options.password)) {
                authFailures.delete(session.id);
                return callback(null, { user: options.user });
            }
            const failures = (authFailures.get(session.id) ?? 0) + 1;
            authFailures.set(session.id, failures);
            if (failures >= MAX_AUTH_FAILURES) {
                // 421 makes smtp-server close the connection
                return callback(smtpError('Too many failed logins', 421));
            }
            return callback(smtpError('Authentication failed', 535));
        },

        onClose(session) {
            clearTimeout(sessionTimers.get(session.id));
            sessionTimers.delete(session.id);
            authFailures.delete(session.id);
        },

        onData(stream, session, callback) {
            const chunks: Buffer[] = [];
            stream.on('data', (chunk: Buffer) => {
                if (!stream.sizeExceeded) {
                    chunks.push(chunk);
                }
            });
            stream.on('end', () => {
                if (stream.sizeExceeded) {
                    return callback(smtpError('Message too big', 552));
                }
                options.onMessage(Buffer.concat(chunks).toString('utf8')).then(
                    () => callback(),
                    (e) => {
                        console.error('bounce receiver: could not process a message:', e instanceof Error ? e.message : e);
                        callback(smtpError('Could not process the message, try again later', 451));
                    },
                );
            });
        },
    });
    server.on('error', (e) => console.error('bounce receiver: SMTP error:', e?.message || e));
    return server;
}

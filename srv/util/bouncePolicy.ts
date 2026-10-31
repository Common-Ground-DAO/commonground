// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

// When a permanent bounce makes an address "undeliverable" (docs/
// email-notifications, "Bounces"). Pure decisions; srv/repositories/
// emailBounces.ts feeds them from the email_bounces table.
//
// A 5xx answer does not prove the mailbox is gone: a receiver that rejects
// *this server* (blocklisted IP, failing SPF/DKIM/DMARC, missing PTR) answers
// 5xx as well, and the relay (maddy 0.9.6) reports every permanent failure as
// 5.0.0, so the status can't tell the two apart. Hence:
//   - an address only becomes unverified after `minBounces` permanent
//     bounces from separate messages at least `minSpanMs` apart;
//   - a burst — more than `burstAddresses` distinct addresses within
//     `burstWindowMs`, or more than `burstDomainAddresses` of one recipient
//     domain — is treated as a problem on the sending side: those bounces are
//     flagged and never count, and nobody (in that domain) is unverified.

export type BouncePolicy = {
    minBounces: number;
    minSpanMs: number;
    burstWindowMs: number;
    burstAddresses: number;
    burstDomainAddresses: number;
};

const HOUR = 60 * 60 * 1000;

function positiveInt(value: string | undefined, fallback: number): number {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function bouncePolicyFromEnv(env: Record<string, string | undefined>): BouncePolicy {
    return {
        minBounces: 2,
        minSpanMs: 24 * HOUR,
        burstWindowMs: HOUR,
        burstAddresses: positiveInt(env.MAIL_BOUNCE_BURST_ADDRESSES, 25),
        burstDomainAddresses: positiveInt(env.MAIL_BOUNCE_BURST_DOMAIN_ADDRESSES, 10),
    };
}

export const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1);

export type Burst = {
    /** too many addresses overall: nobody is unverified */
    global: boolean;
    /** recipient domains with too many bouncing addresses */
    domains: string[];
    /** distinct addresses in the window */
    addresses: number;
};

/** @param windowAddresses addresses with a permanent bounce within the burst window (duplicates allowed) */
export function detectBurst(windowAddresses: string[], policy: BouncePolicy): Burst {
    const distinct = new Set(windowAddresses);
    const perDomain = new Map<string, number>();
    for (const address of distinct) {
        const domain = domainOf(address);
        perDomain.set(domain, (perDomain.get(domain) ?? 0) + 1);
    }
    return {
        global: distinct.size > policy.burstAddresses,
        domains: [...perDomain].filter(([, n]) => n > policy.burstDomainAddresses).map(([d]) => d),
        addresses: distinct.size,
    };
}

/** whether an address falls under a detected burst */
export function inBurst(address: string, burst: Burst): boolean {
    return burst.global || burst.domains.includes(domainOf(address));
}

/**
 * Addresses to mark unverified.
 * @param history bounce times per address that count (not flagged as sender-side), this report's included
 */
export function addressesToUnverify(
    reported: string[],
    history: Map<string, Date[]>,
    burst: Burst,
    policy: BouncePolicy,
): string[] {
    return reported.filter(address => {
        if (inBurst(address, burst)) {
            return false;
        }
        const times = (history.get(address) ?? []).map(d => d.getTime());
        if (times.length < policy.minBounces) {
            return false;
        }
        return Math.max(...times) - Math.min(...times) >= policy.minSpanMs;
    });
}

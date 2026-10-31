// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

// Reads delivery status notifications (RFC 3464 / RFC 3462) as the mail relay
// generates them: a multipart/report; report-type=delivery-status message
// whose message/delivery-status part holds one field block per message and
// one per recipient. Only that part is read — the returned original headers
// that follow it are ignored, so nothing quoted from the bounced mail can
// pose as a status field.

export type DsnRecipient = {
    /** lower-cased address from Final-Recipient (rfc822 type only) */
    address: string;
    /** Action field, lower-cased: failed, delayed, delivered, relayed, expanded */
    action: string;
    /**
     * Status field, e.g. 5.1.1. Note: maddy 0.9.6 reports every permanent
     * failure as 5.0.0 and every give-up after temporary failures as 4.0.0,
     * whatever the receiving server said — the class is all that's reliable.
     */
    status: string;
    /** Diagnostic-Code field (the receiving server's answer), if any */
    diagnostic: string | null;
};

/** Message-ID of the report (without angle brackets), or null */
export function dsnMessageId(raw: string): string | null {
    const end = headerEnd(raw);
    const id = parseFields(end < 0 ? raw : raw.slice(0, end)).get('message-id');
    const m = id?.match(/^<?([^<>\s]{1,250})>?$/);
    return m ? m[1] : null;
}

const unfold = (block: string) => block.replace(/\r?\n[ \t]+/g, ' ');

function parseFields(block: string): Map<string, string> {
    const fields = new Map<string, string>();
    for (const line of unfold(block).split(/\r?\n/)) {
        const m = line.match(/^([A-Za-z0-9-]+)\s*:\s*(.*)$/);
        if (m) {
            fields.set(m[1].toLowerCase(), m[2].trim());
        }
    }
    return fields;
}

function headerEnd(text: string, from = 0): number {
    const m = /\r?\n\r?\n/.exec(text.slice(from));
    return m ? from + m.index + m[0].length : -1;
}

/**
 * Per-recipient results of a DSN, or null when the message is not a
 * delivery-status report.
 */
export function parseDsn(raw: string): DsnRecipient[] | null {
    const topEnd = headerEnd(raw);
    if (topEnd < 0) {
        return null;
    }
    const top = parseFields(raw.slice(0, topEnd));
    const contentType = top.get('content-type') || '';
    if (!/^multipart\/report\s*;/i.test(contentType) || !/report-type\s*=\s*"?delivery-status"?/i.test(contentType)) {
        return null;
    }
    const boundary = contentType.match(/boundary\s*=\s*(?:"([^"]+)"|([^\s;]+))/i);
    if (!boundary) {
        return null;
    }
    const delimiter = `--${boundary[1] ?? boundary[2]}`;

    // walk the parts and take the first message/delivery-status one
    const body = raw.slice(topEnd);
    const lines = body.split(/\r?\n/);
    const parts: string[][] = [];
    let current: string[] | null = null;
    for (const line of lines) {
        const trimmed = line.trimEnd();
        if (trimmed === delimiter || trimmed === `${delimiter}--`) {
            if (current) {
                parts.push(current);
            }
            if (trimmed !== delimiter) {
                break; // closing delimiter
            }
            current = [];
        } else if (current) {
            current.push(line);
        }
    }
    for (const part of parts) {
        const text = part.join('\r\n');
        const end = headerEnd(text);
        if (end < 0) {
            continue;
        }
        const headers = parseFields(text.slice(0, end));
        if (!/^message\/(global-)?delivery-status\b/i.test(headers.get('content-type') || '')) {
            continue;
        }
        const encoding = (headers.get('content-transfer-encoding') || '7bit').toLowerCase();
        let status = text.slice(end);
        if (encoding === 'base64') {
            status = Buffer.from(status.replace(/\s+/g, ''), 'base64').toString('utf8');
        } else if (encoding === 'quoted-printable') {
            return null; // never produced by the relay; not worth decoding
        }
        // first block: per-message fields; the rest: one per recipient
        const blocks = status.split(/\r?\n\s*\r?\n/).filter(b => b.trim());
        const recipients: DsnRecipient[] = [];
        for (const block of blocks.slice(1)) {
            const fields = parseFields(block);
            const final = fields.get('final-recipient') || '';
            const m = final.match(/^rfc822\s*;\s*<?([^<>\s]+@[^<>\s]+)>?$/i);
            if (!m) {
                continue;
            }
            recipients.push({
                address: m[1].toLowerCase(),
                action: (fields.get('action') || '').toLowerCase(),
                status: fields.get('status') || '',
                diagnostic: fields.get('diagnostic-code') || null,
            });
        }
        return recipients;
    }
    return null;
}

/**
 * Recipients a DSN reports as permanently undeliverable (Action failed,
 * Status 5.x.x), one per address. Temporary results (4.x.x — maddy also sends
 * one when it gives up after its last retry) are left out.
 */
export function permanentlyFailed(recipients: DsnRecipient[]): DsnRecipient[] {
    const byAddress = new Map<string, DsnRecipient>();
    for (const r of recipients) {
        if (r.action === 'failed' && /^5\.\d{1,3}\.\d{1,3}/.test(r.status) && !byAddress.has(r.address)) {
            byAddress.set(r.address, r);
        }
    }
    return [...byAddress.values()];
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { dsnMessageId, parseDsn, permanentlyFailed } from '../util/dsn';

const report = (statusPart: string, extraParts = '') => [
  'From: MAILER-DAEMON@cg.example.org',
  'To: no-reply@cg.example.org',
  'Subject: Undelivered Mail Returned to Sender',
  'Message-ID: <bd9fbcd8@cg.example.org>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/report; report-type=delivery-status;',
  '\tboundary="BOUND"',
  '',
  '--BOUND',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Final-Recipient: rfc822; human-text@example.net',
  'Action: failed',
  'Status: 5.1.1',
  '',
  '--BOUND',
  'Content-Type: message/delivery-status',
  '',
  statusPart,
  extraParts,
  '--BOUND',
  'Content-Type: text/rfc822-headers',
  '',
  'From: no-reply@cg.example.org',
  '',
  'Final-Recipient: rfc822; quoted@example.net',
  'Action: failed',
  'Status: 5.1.1',
  '',
  '--BOUND--',
  '',
].join('\r\n');

const statusFields = [
  'Reporting-MTA: dns; cg.example.org',
  'Arrival-Date: Sat, 31 Oct 2026 12:00:00 +0000',
  '',
  'Final-Recipient: rfc822; Gone@Example.NET',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 User unknown',
  '',
  'Final-Recipient: rfc822; slow@example.org',
  'Action: failed',
  'Status: 4.4.7',
  '',
  'Final-Recipient: rfc822;<other@example.com>',
  'Action: delayed',
  'Status: 4.0.0',
  '',
].join('\r\n');

describe('parseDsn', () => {
  it('reads the per-recipient blocks of the delivery-status part only', () => {
    const recipients = parseDsn(report(statusFields));
    expect(recipients).toEqual([
      { address: 'gone@example.net', action: 'failed', status: '5.1.1', diagnostic: 'smtp; 550 5.1.1 User unknown' },
      { address: 'slow@example.org', action: 'failed', status: '4.4.7', diagnostic: null },
      { address: 'other@example.com', action: 'delayed', status: '4.0.0', diagnostic: null },
    ]);
  });

  it('only counts failed + 5.x.x as permanent, once per address', () => {
    const twice = statusFields + '\r\nFinal-Recipient: rfc822; gone@example.net\r\nAction: failed\r\nStatus: 5.0.0\r\n';
    expect(permanentlyFailed(parseDsn(report(twice))!).map(r => r.address)).toEqual(['gone@example.net']);
  });

  it('reads the report Message-ID', () => {
    expect(dsnMessageId(report(statusFields))).toBe('bd9fbcd8@cg.example.org');
    expect(dsnMessageId('Subject: x\r\n\r\nbody')).toBeNull();
  });

  it('decodes a base64 delivery-status part', () => {
    const raw = report(statusFields).replace(
      'Content-Type: message/delivery-status\r\n\r\n' + statusFields,
      'Content-Type: message/delivery-status\r\nContent-Transfer-Encoding: base64\r\n\r\n'
        + Buffer.from(statusFields).toString('base64').replace(/.{76}/g, '$&\r\n'),
    );
    expect(permanentlyFailed(parseDsn(raw)!).map(r => r.address)).toEqual(['gone@example.net']);
  });

  it('rejects messages that are not delivery-status reports', () => {
    expect(parseDsn('Subject: hi\r\nContent-Type: text/plain\r\n\r\nFinal-Recipient: rfc822; a@b.c\r\nAction: failed\r\nStatus: 5.1.1\r\n')).toBeNull();
    expect(parseDsn(report(statusFields).replace('report-type=delivery-status', 'report-type=disposition-notification'))).toBeNull();
    expect(parseDsn('no headers at all')).toBeNull();
  });

  it('ignores blocks without an rfc822 Final-Recipient', () => {
    const fields = 'Reporting-MTA: dns; x\r\n\r\nFinal-Recipient: x400; foo\r\nAction: failed\r\nStatus: 5.0.0\r\n';
    expect(parseDsn(report(fields))).toEqual([]);
  });
});

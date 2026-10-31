// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { createTransport } from 'nodemailer';
import type { SMTPServer } from 'smtp-server';
import { createBounceReceiver } from '../util/bounceReceiverServer';

const USER = 'cg-app';
const PASSWORD = 'relay-secret';

let server: SMTPServer;
let port: number;
let received: string[];
let failNext: boolean;
let relayAddresses: string[];

async function start(extra: { sessionLimitMs?: number } = {}) {
  server = createBounceReceiver({
    user: USER,
    password: PASSWORD,
    relayHost: 'mail',
    lookup: async () => relayAddresses,
    maxMessageBytes: 64 * 1024,
    ...extra,
    onMessage: async (raw) => {
      if (failNext) {
        failNext = false;
        throw new Error('db down');
      }
      received.push(raw);
    },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  port = ((server as unknown as { server: net.Server }).server.address() as AddressInfo).port;
}

beforeEach(async () => {
  received = [];
  failNext = false;
  relayAddresses = ['127.0.0.1'];
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  await start();
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  jest.restoreAllMocks();
});

const send = (pass = PASSWORD, text = 'line one\r\n.starts with a dot\r\nend') => createTransport({
  host: '127.0.0.1', port, secure: false, ignoreTLS: true,
  auth: { user: USER, pass },
}).sendMail({
  envelope: { from: '', to: 'no-reply@cg.example.org' },
  from: 'MAILER-DAEMON@cg.example.org',
  to: 'no-reply@cg.example.org',
  subject: 'report',
  text,
});

/** raw dialogue: writes the lines one by one, returns everything received until the server closes */
function dialogue(lines: string[], waitMs = 1500): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let out = '';
    socket.setEncoding('utf8');
    let i = 0;
    socket.on('data', (d: string) => {
      out += d;
      if (i < lines.length) {
        socket.write(lines[i++] + '\r\n');
      }
    });
    const done = () => resolve(out);
    socket.on('close', done);
    setTimeout(() => { socket.destroy(); done(); }, waitMs);
  });
}

const plain = (user: string, pass: string) => Buffer.from(`\0${user}\0${pass}`).toString('base64');

describe('bounce receiver (smtp-server)', () => {
  it('accepts a message from the relay after AUTH PLAIN', async () => {
    await send();
    expect(received).toHaveLength(1);
    expect(received[0]).toContain('Subject: report');
    expect(received[0]).toContain('\r\n.starts with a dot\r\n');
  });

  it('refuses a wrong password', async () => {
    await expect(send('wrong')).rejects.toMatchObject({ responseCode: 535 });
    expect(received).toHaveLength(0);
  });

  it('closes the connection after the third failed login', async () => {
    const out = await dialogue([
      'EHLO test',
      `AUTH PLAIN ${plain(USER, 'a')}`,
      `AUTH PLAIN ${plain(USER, 'b')}`,
      `AUTH PLAIN ${plain(USER, 'c')}`,
      `AUTH PLAIN ${plain(USER, PASSWORD)}`,
    ]);
    expect(out.match(/^535 /gm)).toHaveLength(2);
    expect(out).toMatch(/^421 .*Too many failed logins/m);
    expect(out).not.toMatch(/^235 /m);
  });

  it('answers 451 when processing fails, so the relay retries', async () => {
    failNext = true;
    await expect(send()).rejects.toMatchObject({ responseCode: 451 });
    await send();
    expect(received).toHaveLength(1);
  });

  it('refuses oversized messages', async () => {
    await expect(send(undefined, 'x'.repeat(70 * 1024))).rejects.toMatchObject({ responseCode: 552 });
    expect(received).toHaveLength(0);
  });

  it('requires authentication before MAIL and offers no STARTTLS', async () => {
    const out = await dialogue(['EHLO test', 'MAIL FROM:<>', 'QUIT']);
    expect(out).toMatch(/^220 /);
    expect(out).toMatch(/^250[- ]AUTH PLAIN$/m);
    expect(out).not.toContain('STARTTLS');
    expect(out).toMatch(/^530 /m);
  });

  it('refuses connections from anything but the relay', async () => {
    relayAddresses = ['172.19.0.2'];
    const out = await dialogue(['EHLO test']);
    expect(out).toMatch(/^554 /m);
    expect(out).not.toMatch(/^250/m);
    await expect(send()).rejects.toMatchObject({ responseCode: 554 });
    expect(received).toHaveLength(0);
  });

  it('treats IPv4-mapped IPv6 as the same address', async () => {
    relayAddresses = ['::ffff:127.0.0.1'];
    await send();
    expect(received).toHaveLength(1);
  });

  it('ends a connection after the absolute session limit', async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await start({ sessionLimitMs: 300 });
    const out = await dialogue(['EHLO test'], 2000);
    expect(out).toMatch(/^421 .*Session time limit/m);
  });
});

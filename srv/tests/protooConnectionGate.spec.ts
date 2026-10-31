// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { EventEmitter } from 'events';
import { authenticateProtooTransport, connectionSourceKey, PendingConnectionLimiter } from '../mediasoup/connectionGate';

const PEER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

/**
 * Mimics protoo-server's WebSocketTransport: frames arrive on `_connection`,
 * text frames that parse as JSON are re-emitted as 'message'.
 */
class FakeTransport extends EventEmitter {
  _connection?: EventEmitter;
  constructor(withConnection = true) {
    super();
    if (withConnection) {
      const connection = new EventEmitter();
      connection.on('message', (frame: any) => {
        if (frame.type !== 'utf8') return;
        let parsed: any;
        try {
          parsed = JSON.parse(frame.utf8Data);
        } catch {
          return;
        }
        if (this.listenerCount('message') > 0) this.emit('message', parsed);
      });
      this._connection = connection;
    }
  }
  closed = false;
  sent: any[] = [];
  send = jest.fn(async (message: any) => {
    this.sent.push(message);
  });
  close = jest.fn(() => {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  });
  toString() {
    return 'fake';
  }
  request(id: number, method: string, data: any = {}) {
    const message = { request: true, id, method, data };
    if (this._connection) {
      this._connection.emit('message', { type: 'utf8', utf8Data: JSON.stringify(message) });
    } else {
      this.emit('message', message);
    }
  }
  frame(frame: { type: string; utf8Data?: string; binaryData?: Buffer }) {
    this._connection!.emit('message', frame);
  }
  responseTo(id: number) {
    return this.sent.find((m) => m.response && m.id === id);
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function start(transport: FakeTransport, verify: (data: any, secret: string) => Promise<string>, timeoutMs = 1000) {
  const outcome = authenticateProtooTransport(transport as any, PEER, { timeoutMs, verify });
  // keep unhandled-rejection noise out of tests that only inspect the transport
  outcome.catch(() => { });
  return outcome;
}

describe('authenticateProtooTransport', () => {
  it('answers other requests with LOGIN_REQUIRED until logged in', async () => {
    const transport = new FakeTransport();
    const verify = jest.fn();
    start(transport, verify);
    transport.request(1, 'join', {});
    transport.request(2, 'getRouterRtpCapabilities');
    await flush();
    expect(transport.responseTo(1)).toMatchObject({ ok: false, errorReason: 'LOGIN_REQUIRED' });
    expect(transport.responseTo(2)).toMatchObject({ ok: false, errorReason: 'LOGIN_REQUIRED' });
    expect(verify).not.toHaveBeenCalled();
    expect(transport.closed).toBe(false);
  });

  it('logs in as the peerId and answers "OK" only once confirmed', async () => {
    const transport = new FakeTransport();
    const verify = jest.fn().mockResolvedValue(PEER);
    const outcome = start(transport, verify);

    transport.request(1, 'getSignableSecret');
    await flush();
    const secret = transport.responseTo(1).data;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);

    transport.request(2, 'login', { secret, deviceId: 'd', base64Signature: 's' });
    const connection = await outcome;
    expect(verify).toHaveBeenCalledWith({ secret, deviceId: 'd', base64Signature: 's' }, secret);
    expect(transport.responseTo(2)).toBeUndefined();

    connection.confirm();
    await flush();
    expect(transport.responseTo(2)).toMatchObject({ ok: true, data: 'OK' });

    // From here on the room peer owns the transport; the login limits no
    // longer apply.
    expect(transport._connection!.listenerCount('message')).toBe(1);
    for (let i = 3; i < 20; i++) transport.request(i, 'join', {});
    transport.frame({ type: 'utf8', utf8Data: 'x'.repeat(10_000) });
    await flush();
    expect(transport.responseTo(3)).toBeUndefined();
    expect(transport.closed).toBe(false);
  });

  it('closes a connection that logs in as a different user', async () => {
    const transport = new FakeTransport();
    const outcome = start(transport, jest.fn().mockResolvedValue(OTHER));
    transport.request(1, 'getSignableSecret');
    await flush();
    transport.request(2, 'login', { secret: transport.responseTo(1).data });
    await expect(outcome).rejects.toThrow();
    expect(transport.responseTo(2)).toMatchObject({ ok: true, data: 'ERROR' });
    expect(transport.closed).toBe(true);
  });

  it('closes a connection whose signature does not verify', async () => {
    const transport = new FakeTransport();
    const outcome = start(transport, jest.fn().mockRejectedValue(new Error('invalid signature')));
    transport.request(1, 'getSignableSecret');
    await flush();
    transport.request(2, 'login', { secret: transport.responseTo(1).data });
    await expect(outcome).rejects.toThrow();
    expect(transport.responseTo(2)).toMatchObject({ ok: true, data: 'ERROR' });
    expect(transport.closed).toBe(true);
  });

  it('refuses a login without a previously issued secret', async () => {
    const transport = new FakeTransport();
    const verify = jest.fn().mockResolvedValue(PEER);
    const outcome = start(transport, verify);
    transport.request(1, 'login', { secret: 'x' });
    await expect(outcome).rejects.toThrow();
    expect(verify).not.toHaveBeenCalled();
    expect(transport.closed).toBe(true);
  });

  it('closes connections that do not log in in time', async () => {
    const transport = new FakeTransport();
    const outcome = start(transport, jest.fn(), 20);
    await expect(outcome).rejects.toThrow('login timeout');
    expect(transport.closed).toBe(true);
  });

  it.each([
    ['with', true],
    ['without', false],
  ])('closes connections that flood requests before login (%s raw frame access)', async (_label, withConnection) => {
    const transport = new FakeTransport(withConnection);
    const outcome = start(transport, jest.fn());
    for (let i = 0; i < 20; i++) transport.request(i, 'getSignableSecret');
    await expect(outcome).rejects.toThrow('too many messages before login');
    expect(transport.closed).toBe(true);
  });

  it('counts frames protoo ignores (binary, unparsable)', async () => {
    const transport = new FakeTransport();
    const outcome = start(transport, jest.fn());
    for (let i = 0; i < 5; i++) transport.frame({ type: 'binary', binaryData: Buffer.alloc(10) });
    for (let i = 0; i < 5; i++) transport.frame({ type: 'utf8', utf8Data: 'not json' });
    await expect(outcome).rejects.toThrow('too many messages before login');
    expect(transport.closed).toBe(true);
  });

  it('closes on an oversized frame before login', async () => {
    const transport = new FakeTransport();
    const verify = jest.fn();
    const outcome = start(transport, verify);
    transport.request(1, 'getSignableSecret');
    await flush();
    const secret = transport.responseTo(1).data;
    transport.request(2, 'login', { secret, padding: 'x'.repeat(5000) });
    await expect(outcome).rejects.toThrow('message too large before login');
    expect(verify).not.toHaveBeenCalled();
    expect(transport.closed).toBe(true);
  });

  it('rejects when the client goes away', async () => {
    const transport = new FakeTransport();
    const outcome = start(transport, jest.fn());
    transport.close();
    await expect(outcome).rejects.toThrow();
  });
});

describe('connectionSourceKey', () => {
  it('uses the peer address unless the proxy is trusted', () => {
    expect(connectionSourceKey('203.0.113.7', '198.51.100.1', false)).toBe('203.0.113.7');
    expect(connectionSourceKey('10.0.0.2', '198.51.100.1', true)).toBe('198.51.100.1');
  });

  it('takes the entry the proxy appended, not client-supplied ones', () => {
    expect(connectionSourceKey('10.0.0.2', '1.2.3.4, 198.51.100.1', true)).toBe('198.51.100.1');
    expect(connectionSourceKey('10.0.0.2', ['1.2.3.4', '198.51.100.1'], true)).toBe('198.51.100.1');
  });

  it('falls back to the peer address without a header', () => {
    expect(connectionSourceKey('203.0.113.7', undefined, true)).toBe('203.0.113.7');
  });

  it('groups IPv6 sources by /64 and unwraps v4-mapped addresses', () => {
    const a = connectionSourceKey('2001:db8:1:2:aaaa::1', undefined, false);
    const b = connectionSourceKey('2001:db8:1:2:bbbb::2', undefined, false);
    const c = connectionSourceKey('2001:db8:1:3::1', undefined, false);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(connectionSourceKey('::ffff:203.0.113.7', undefined, false)).toBe('203.0.113.7');
  });
});

describe('PendingConnectionLimiter', () => {
  it('limits per source and in total, and frees slots on release', () => {
    const limiter = new PendingConnectionLimiter(3, 2);
    const a1 = limiter.tryAcquire('a');
    const a2 = limiter.tryAcquire('a');
    expect(a1).not.toBeNull();
    expect(a2).not.toBeNull();
    expect(limiter.tryAcquire('a')).toBeNull();
    const b1 = limiter.tryAcquire('b');
    expect(b1).not.toBeNull();
    expect(limiter.tryAcquire('c')).toBeNull();

    a1!();
    a1!(); // releasing twice is harmless
    expect(limiter.size).toBe(2);
    expect(limiter.tryAcquire('a')).not.toBeNull();
    expect(limiter.tryAcquire('c')).toBeNull();
  });
});

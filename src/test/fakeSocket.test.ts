// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeIo, FakeSocket, NO_ACK } from './fakeSocket';
import { deferred, flushMicrotasks } from './deferred';

/** A socket that waits for the test to accept, already asked to connect. */
function connecting(options: ConstructorParameters<typeof FakeSocket>[0] = {}) {
  return new FakeSocket({ autoAccept: false, ...options }).connect();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('FakeSocket', () => {
  it('connects on a microtask, assigns a new id per connection and fires connect/disconnect', async () => {
    const socket = new FakeSocket({ idPrefix: 's' });
    const events: string[] = [];
    socket.on('connect', () => events.push(`connect ${socket.id}`));
    socket.on('disconnect', (reason: string, description?: unknown) => events.push(`disconnect ${reason}${description ? ` (${String(description)})` : ''}`));

    socket.connect();
    expect(socket.connected).toBe(false);
    await flushMicrotasks();
    expect(socket.connected).toBe(true);

    socket.drop('ping timeout', 'no pong');
    expect(socket.active).toBe(true);
    socket.accept();
    socket.disconnect();
    expect(socket.active).toBe(false);
    expect(events).toEqual([
      'connect s-1', 'disconnect ping timeout (no pong)', 'connect s-2', 'disconnect io client disconnect',
    ]);
  });

  it('with autoAccept false waits for accept() and reports refused attempts', () => {
    const socket = connecting();
    const errors: string[] = [];
    socket.on('connect_error', (e: Error) => errors.push(e.message));
    socket.refuse(new Error('nope'));
    expect(socket.connected).toBe(false);
    expect(socket.active).toBe(true);
    socket.accept();
    expect(socket.connected).toBe(true);
    expect(errors).toEqual(['nope']);
  });

  it('flushes the send buffer before the connect listeners run (socket.io onconnect order)', () => {
    const socket = connecting();
    const order: string[] = [];
    socket.on('connect', () => order.push(`connect, sent so far: ${socket.sent.map(p => p.event).join(',')}`));
    socket.emit('joinRoom', 'a');
    socket.volatile.emit('typing', true);
    socket.accept();
    expect(order).toEqual(['connect, sent so far: joinRoom']);
    expect(socket.sendBuffer).toHaveLength(0);
  });

  it('stays dead after a client disconnect, a server disconnect or a middleware error until connect()', () => {
    const socket = connecting();
    socket.accept();
    socket.disconnect();
    expect(() => socket.accept()).toThrow(/inactive/);
    expect(() => socket.refuse()).toThrow(/inactive/);

    socket.connect().accept();
    socket.drop('io server disconnect');
    expect(socket.active).toBe(false);
    expect(() => socket.accept()).toThrow(/inactive/);

    socket.connect();
    const errors: string[] = [];
    socket.on('connect_error', (e: Error) => errors.push(e.message));
    socket.refuse(new Error('not authorized'), { middleware: true });
    expect(socket.active).toBe(false);
    expect(errors).toEqual(['not authorized']);
    expect(() => socket.accept()).toThrow(/inactive/);
    socket.connect().accept();
    expect(socket.connected).toBe(true);
  });

  it('fires Manager reconnect events on socket.io around a reconnect after a drop', () => {
    const socket = connecting();
    const events: string[] = [];
    for (const type of ['open', 'close', 'error', 'reconnect_attempt', 'reconnect_error', 'reconnect']) {
      socket.io.on(type, (arg?: unknown) => events.push(`${type}${arg instanceof Error ? ` ${arg.message}` : arg !== undefined ? ` ${String(arg)}` : ''}`));
    }
    socket.on('connect', () => events.push('connect'));
    socket.accept();
    socket.drop();
    socket.refuse(new Error('down'));
    socket.accept();
    expect(events).toEqual([
      'open', 'connect',
      'close transport close',
      'reconnect_attempt 1', 'error down', 'reconnect_error down',
      'reconnect_attempt 2', 'open', 'reconnect 2', 'connect',
    ]);
  });

  it('treats the accept after a refused first connect as a reconnect, and closes the Manager on disconnect()', () => {
    const socket = connecting();
    const events: string[] = [];
    for (const type of ['open', 'close', 'error', 'reconnect_attempt', 'reconnect_error', 'reconnect']) {
      socket.io.on(type, (arg?: unknown) => events.push(`${type}${arg instanceof Error ? ` ${arg.message}` : arg !== undefined ? ` ${String(arg)}` : ''}`));
    }
    socket.on('disconnect', (reason: string) => events.push(`disconnect ${reason}`));
    socket.refuse(new Error('down'));
    socket.accept();
    socket.disconnect();
    expect(events).toEqual([
      'error down',
      'reconnect_attempt 1', 'open', 'reconnect 1',
      'close forced close', 'disconnect io client disconnect',
    ]);
  });

  it('delivers server events to on() and onAny() listeners only while connected', () => {
    const socket = connecting();
    const seen: unknown[] = [];
    const listener = (data: unknown) => seen.push(data);
    socket.on('cliMessageEvent', listener);
    socket.onAny((event, data) => seen.push(`${event}:${String(data)}`));
    expect(socket.deliver('cliMessageEvent', 'lost')).toBe(false);
    socket.accept();
    expect(socket.deliver('cliMessageEvent', 1)).toBe(true);
    socket.off('cliMessageEvent', listener);
    socket.deliver('cliMessageEvent', 2);
    expect(seen).toEqual(['cliMessageEvent:1', 1, 'cliMessageEvent:2']);
  });

  it('delivers server events with an ack the client answers', async () => {
    const socket = connecting().accept();
    socket.on('askClient', (question: string, ack: (answer: string) => void) => ack(`re: ${question}`));
    expect(await socket.deliverWithAck('askClient', 'hi')).toEqual(['re: hi']);

    socket.off('askClient');
    socket.on('askClient', () => undefined);
    const unanswered = socket.deliverWithAck('askClient', 'still there?');
    socket.drop();
    await expect(unanswered).rejects.toThrow(/disconnected/);
  });

  it('runs the default login handshake and answers acks asynchronously', async () => {
    const socket = new FakeSocket();
    socket.connect();
    await flushMicrotasks();
    const secret = await socket.emitWithAck('getSignableSecret');
    expect(secret).toBe(socket.lastSecret);

    const ack = vi.fn();
    socket.emit('login', { secret }, ack);
    expect(ack).not.toHaveBeenCalled();
    await socket.settle();
    expect(ack).toHaveBeenCalledWith('OK');
    expect(socket.loggedIn).toBe(true);
    expect(socket.sentOf('login')[0]).toMatchObject({ args: [{ secret }], hasAck: true, socketId: socket.id });

    socket.drop();
    expect(socket.loggedIn).toBe(false);
    socket.accept();
    socket.loginResult = 'SECURITY_STEP_REQUIRED';
    expect(await socket.emitWithAck('login', {})).toBe('SECURITY_STEP_REQUIRED');
    expect(socket.loginCount).toBe(2);
    expect(socket.loggedIn).toBe(false);
  });

  it('drops a plain ack silently and rejects emitWithAck when the connection goes away', async () => {
    const socket = connecting().accept();
    const gate = deferred<string>();
    socket.handle('login', () => gate.promise);
    const ack = vi.fn();
    socket.emit('login', {}, ack);
    const withAck = socket.emitWithAck('login', {});
    socket.drop();
    await expect(withAck).rejects.toThrow('socket has been disconnected');
    socket.accept();
    gate.resolve('OK');
    await socket.settle();
    expect(ack).not.toHaveBeenCalled();
  });

  it('clears the ack of a sent packet on disconnect and answers one buffered across the reconnect', async () => {
    const socket = connecting();
    const answer = socket.emitWithAck('getSignableSecret');
    socket.accept();
    socket.drop();
    socket.accept();
    // the packet was sent on the first connection, so its ack was cleared
    await expect(answer).rejects.toThrow(/disconnected/);

    socket.drop();
    const buffered = socket.emitWithAck('getSignableSecret');
    socket.accept();
    expect(await buffered).toMatch(/^secret-/);
  });

  it('timeout(ms) errors an unanswered ack and drops a still-buffered packet', async () => {
    vi.useFakeTimers();
    const socket = connecting().accept();
    const late = vi.fn();
    socket.timeout(1000).emit('getChanges', { cursor: 1 }, late);
    vi.advanceTimersByTime(1000);
    expect(late).toHaveBeenCalledWith(new Error('operation has timed out'));

    socket.drop();
    const buffered = socket.timeout(500).emitWithAck('getChanges', { cursor: 2 });
    vi.advanceTimersByTime(500);
    await expect(buffered).rejects.toThrow('operation has timed out');
    socket.accept();
    expect(socket.sentOf('getChanges')).toHaveLength(1);

    const answered = socket.timeout(1000).emitWithAck('cgPing');
    await vi.advanceTimersByTimeAsync(0);
    expect(typeof await answered).toBe('number');
  });

  it('keeps unhandled acks pending until respond(), and NO_ACK never answers', async () => {
    const socket = connecting().accept();
    const ack = vi.fn();
    socket.emit('getChanges', { cursor: 1 }, ack);
    expect(socket.pendingAcks).toHaveLength(1);
    socket.respond('getChanges', { changes: [] });
    await flushMicrotasks();
    expect(ack).toHaveBeenCalledWith({ changes: [] });
    expect(() => socket.respond('getChanges')).toThrow(/no pending ack/);

    const silent = vi.fn();
    socket.handle('ping', () => NO_ACK).emit('ping', silent);
    await socket.settle();
    expect(silent).not.toHaveBeenCalled();
  });

  it('once() fires a single time and rejects reserved emits', () => {
    const socket = connecting();
    const listener = vi.fn();
    socket.once('connect', listener);
    socket.accept();
    socket.drop();
    socket.accept();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(() => socket.emit('connect')).toThrow(/reserved/);
  });
});

describe('createFakeIo', () => {
  it('creates and auto-connects sockets like io()', async () => {
    const fake = createFakeIo();
    const socket = fake.io('wss://example.test', { path: '/api/ws/' });
    const lazy = fake.io('wss://example.test', { autoConnect: false, ackTimeout: 5000 });
    await flushMicrotasks();
    expect(socket.connected).toBe(true);
    expect(lazy.connected).toBe(false);
    expect(lazy.active).toBe(false);
    expect(lazy.options.ackTimeout).toBe(5000);
    expect(fake.last).toBe(lazy);
    expect(fake.calls[0]).toEqual({ url: 'wss://example.test', opts: { path: '/api/ws/' } });
  });
});

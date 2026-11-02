// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it, vi } from 'vitest';
import { createFakeIo, FakeSocket, NO_ACK } from './fakeSocket';
import { deferred, flushMicrotasks } from './deferred';

describe('FakeSocket', () => {
  it('connects on a microtask, assigns a new id per connection and fires connect/disconnect', async () => {
    const socket = new FakeSocket({ idPrefix: 's' });
    const events: string[] = [];
    socket.on('connect', () => events.push(`connect ${socket.id}`));
    socket.on('disconnect', (reason: string) => events.push(`disconnect ${reason}`));

    socket.connect();
    expect(socket.connected).toBe(false);
    await flushMicrotasks();
    expect(socket.connected).toBe(true);

    socket.drop('ping timeout');
    expect(socket.active).toBe(true);
    socket.accept();
    socket.disconnect();
    expect(socket.active).toBe(false);
    expect(events).toEqual([
      'connect s-1', 'disconnect ping timeout', 'connect s-2', 'disconnect io client disconnect',
    ]);
  });

  it('with autoAccept false waits for accept() and reports refused attempts', () => {
    const socket = new FakeSocket({ autoAccept: false });
    const errors: string[] = [];
    socket.on('connect_error', (e: Error) => errors.push(e.message));
    socket.connect();
    socket.refuse(new Error('nope'));
    expect(socket.connected).toBe(false);
    socket.accept();
    expect(socket.connected).toBe(true);
    expect(errors).toEqual(['nope']);
  });

  it('buffers emits while disconnected and flushes them after the connect listeners', async () => {
    const socket = new FakeSocket({ autoAccept: false });
    const order: string[] = [];
    socket.on('connect', () => order.push(`connect, sent so far: ${socket.sent.length}`));
    socket.emit('joinRoom', 'a');
    socket.volatile.emit('typing', true);
    socket.accept();
    expect(order).toEqual(['connect, sent so far: 0']);
    expect(socket.sent.map(p => p.event)).toEqual(['joinRoom']);
  });

  it('delivers server events to on() and onAny() listeners only while connected', () => {
    const socket = new FakeSocket({ autoAccept: false });
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

  it('lets the test hold an ack and drops it when its connection is gone', async () => {
    const socket = new FakeSocket();
    socket.connect();
    await flushMicrotasks();
    const gate = deferred<string>();
    socket.handle('login', () => gate.promise);
    const ack = vi.fn();
    socket.emit('login', {}, ack);
    socket.drop();
    socket.accept();
    gate.resolve('OK');
    await socket.settle();
    expect(ack).not.toHaveBeenCalled();
  });

  it('keeps unhandled acks pending until respond(), and NO_ACK never answers', async () => {
    const socket = new FakeSocket();
    socket.connect();
    await flushMicrotasks();
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
    const socket = new FakeSocket({ autoAccept: false });
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
    const lazy = fake.io('wss://example.test', { autoConnect: false });
    await flushMicrotasks();
    expect(socket.connected).toBe(true);
    expect(lazy.connected).toBe(false);
    expect(fake.last).toBe(lazy);
    expect(fake.calls[0]).toEqual({ url: 'wss://example.test', opts: { path: '/api/ws/' } });
  });
});

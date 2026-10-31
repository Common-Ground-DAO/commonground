// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { WebSocketTransport } from 'protoo-server';
import { realRandomHexString } from '../util';
import errors from '../common/errors';
import { classifyForwardedIp } from '../util/ipPrefix';

/**
 * Login phase of a protoo connection.
 *
 * A new WebSocket connection first has to complete the `getSignableSecret` /
 * `login` exchange (the same requests the client always sent first) before it
 * is attached to a call room. Until then it holds no room, no Router and no
 * peer slot, and it cannot affect existing peers with the same id. The answer
 * to the `login` request is held back until the caller has attached the
 * connection to its room (`confirm`), so the client's next request already
 * reaches the room peer.
 */

type ProtooMessage = {
  request?: boolean;
  response?: boolean;
  notification?: boolean;
  id?: number;
  method?: string;
  data?: any;
};

/** Frame as delivered by the underlying websocket connection. */
type RawFrame = { type?: string; utf8Data?: string; binaryData?: Buffer };

type RawConnection = {
  prependListener(event: 'message', listener: (frame: RawFrame) => void): void;
  removeListener(event: 'message', listener: (frame: RawFrame) => void): void;
};

type EventedTransport = WebSocketTransport & {
  /** protoo-server 4's websocket connection (not part of its typings). */
  _connection?: RawConnection;
  on(event: 'message', listener: (message: ProtooMessage) => void): void;
  on(event: 'close', listener: () => void): void;
  off(event: 'message', listener: (message: ProtooMessage) => void): void;
  off(event: 'close', listener: () => void): void;
};

/** Verifies a `login` payload against the issued secret; returns the user id. */
export type ProtooLoginVerifier = (data: unknown, secret: string) => Promise<string>;

export type AuthenticatedProtooConnection = {
  /** Answers the pending `login` request with "OK". */
  confirm(): void;
  /** Answers the pending `login` request with an error and closes. */
  refuse(reason: string): void;
};

/** Messages (of any kind) a client may send before it has logged in. */
const MAX_PRE_LOGIN_MESSAGES = 8;
/** Largest message accepted before login; a login request is far below. */
const MAX_PRE_LOGIN_MESSAGE_SIZE = 4096;

function successResponse(id: number, data: unknown) {
  return { response: true, id, ok: true, data };
}

function errorResponse(id: number, errorCode: number, errorReason: string) {
  return { response: true, id, ok: false, errorCode, errorReason };
}

export function authenticateProtooTransport(
  protooTransport: WebSocketTransport,
  peerId: string,
  options: { timeoutMs: number; verify: ProtooLoginVerifier },
): Promise<AuthenticatedProtooConnection> {
  const transport = protooTransport as EventedTransport;
  // Every frame is counted and size-checked on the raw connection, including
  // binary and unparsable ones that protoo drops silently. Without access to
  // it, parsed protoo messages are counted instead.
  const connection = transport._connection;
  const countsRawFrames = typeof connection?.prependListener === 'function';

  return new Promise((resolve, reject) => {
    let secret: string | undefined;
    let messageCount = 0;
    let settled = false;

    const send = (message: object) => {
      transport.send(message).catch(() => { });
    };

    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      transport.off('message', onMessage);
      transport.off('close', onClose);
      if (countsRawFrames) {
        connection!.removeListener('message', onRawFrame);
      }
    };

    const fail = (reason: string) => {
      if (settled) return;
      cleanup();
      transport.close();
      reject(new Error(reason));
    };

    const onClose = () => {
      if (settled) return;
      cleanup();
      reject(new Error('connection closed before login'));
    };

    const countMessage = () => {
      if (++messageCount > MAX_PRE_LOGIN_MESSAGES) {
        fail('too many messages before login');
      }
    };

    const onRawFrame = (frame: RawFrame) => {
      if (settled) return;
      const size = frame?.type === 'binary'
        ? frame.binaryData?.length ?? 0
        : frame?.utf8Data?.length ?? 0;
      if (size > MAX_PRE_LOGIN_MESSAGE_SIZE) {
        fail('message too large before login');
        return;
      }
      countMessage();
    };

    const onMessage = (message: ProtooMessage) => {
      if (settled) return;
      if (!countsRawFrames) {
        countMessage();
        if (settled) return;
      }
      if (!message?.request || typeof message.id !== 'number') {
        return;
      }
      const requestId = message.id;

      if (message.method === 'getSignableSecret') {
        secret = realRandomHexString(32);
        send(successResponse(requestId, secret));
        return;
      }

      if (message.method !== 'login') {
        send(errorResponse(requestId, 403, errors.server.LOGIN_REQUIRED));
        return;
      }

      // One login attempt per secret, and one secret per connection attempt.
      const issuedSecret = secret;
      secret = undefined;
      if (!issuedSecret) {
        send(successResponse(requestId, 'ERROR'));
        fail('login without secret');
        return;
      }

      // Further messages wait for the outcome of this attempt.
      transport.off('message', onMessage);
      options.verify(message.data, issuedSecret).then(
        (userId) => {
          if (settled) return;
          if (userId !== peerId) {
            send(successResponse(requestId, 'ERROR'));
            fail('login identity does not match peerId');
            return;
          }
          cleanup();
          resolve({
            confirm: () => send(successResponse(requestId, 'OK')),
            refuse: (reason: string) => {
              transport.send(errorResponse(requestId, 500, reason))
                .catch(() => { })
                .finally(() => transport.close());
            },
          });
        },
        () => {
          if (settled) return;
          send(successResponse(requestId, 'ERROR'));
          fail('login verification failed');
        },
      );
    };

    const timer = setTimeout(() => fail('login timeout'), options.timeoutMs);
    if (countsRawFrames) {
      // ahead of protoo's own listener, so an oversized or surplus frame
      // closes the connection before the gate acts on it
      connection!.prependListener('message', onRawFrame);
    }
    transport.on('message', onMessage);
    transport.on('close', onClose);
  });
}

/**
 * Source key of a connection for the pre-login limits: the peer address, or,
 * behind a trusted proxy, the address that proxy appended to X-Forwarded-For
 * (the last entry; earlier ones are client-supplied). IPv4 keys on the
 * address, IPv6 on its /64, like the API rate limits.
 */
export function connectionSourceKey(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustProxy: boolean,
): string {
  let address = remoteAddress || '';
  if (trustProxy) {
    const value = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
    const last = value?.split(',').map((part) => part.trim()).filter(Boolean).pop();
    if (last) {
      address = last;
    }
  }
  return classifyForwardedIp(address).ipString || address || 'unknown';
}

/**
 * Bounds the number of connections that are still in the login phase, in
 * total and per source.
 */
export class PendingConnectionLimiter {
  private total = 0;
  private readonly perSource = new Map<string, number>();

  constructor(
    private readonly maxTotal: number,
    private readonly maxPerSource: number,
  ) { }

  /** Returns a release function, or `null` if a limit is reached. */
  tryAcquire(source: string): (() => void) | null {
    const current = this.perSource.get(source) ?? 0;
    if (this.total >= this.maxTotal || current >= this.maxPerSource) {
      return null;
    }
    this.total++;
    this.perSource.set(source, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total--;
      const remaining = (this.perSource.get(source) ?? 1) - 1;
      if (remaining > 0) {
        this.perSource.set(source, remaining);
      } else {
        this.perSource.delete(source);
      }
    };
  }

  get size() {
    return this.total;
  }
}

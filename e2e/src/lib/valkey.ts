// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import net from 'node:net';

/**
 * A minimal Valkey/Redis client (RESP over TCP, no dependency) for the one
 * thing the suite needs from the instance's state store: deleting a session
 * to emulate one that expired server-side. Only used with E2E_REDIS_URL (the
 * disposable instance sets it; a real instance's store is not reachable).
 */

function encode(args: string[]) {
  return `*${args.length}\r\n${args.map(arg => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join('')}`;
}

/** sends the commands in order and resolves with the raw replies (errors reject) */
export function valkeyCommands(url: string, commands: string[][], timeoutMs = 5000): Promise<string[]> {
  const parsed = new URL(url);
  const password = decodeURIComponent(parsed.password);
  const db = parsed.pathname.replace('/', '');
  const all = [
    ...(password ? [['AUTH', password]] : []),
    ...(db ? [['SELECT', db]] : []),
    ...commands,
  ];
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(parsed.port || 6379), parsed.hostname);
    let buffer = '';
    const replies: string[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('valkey: timeout'));
    }, timeoutMs);
    socket.on('connect', () => socket.write(all.map(encode).join('')));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      // every reply used here is a single line (+OK, :1, -ERR …)
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (line.startsWith('-')) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error(`valkey: ${line.slice(1)}`));
          return;
        }
        replies.push(line);
      }
      if (replies.length >= all.length) {
        clearTimeout(timer);
        socket.end();
        resolve(replies.slice(all.length - commands.length));
      }
    });
    socket.on('error', e => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** the express-session id inside a signed session cookie value (`s:<id>.<signature>`, URI-encoded) */
export function sessionIdFromCookie(value: string): string | null {
  const decoded = decodeURIComponent(value);
  const match = /^s:([^.]+)\./.exec(decoded);
  return match ? match[1] : null;
}

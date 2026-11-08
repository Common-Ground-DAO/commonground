// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The wsapi side of gateway mode and of the shared origin list
 * (srv/util/socketServer.ts, srv/util/gateway.ts, srv/util/origins.ts):
 * - the complete list of socket events, read from the code (every
 *   `socket.on("…")` in srv/wsapi.ts and every event the server declares in
 *   API.Server.ServerToClientEvents), against the gateway's event allowlist;
 * - a real Socket.IO server with the wsapi's request checks, driven over a
 *   raw WebSocket and HTTP long-polling: gateway events and refusals, token
 *   handshakes, and the origin checks of handshakes, polling requests and
 *   WebSocket upgrades.
 */

process.env.BASE_URL = 'https://cg.box';
process.env.DEPLOYMENT = 'prod';
delete process.env.CG_GATEWAY;
delete process.env.CG_LEGACY_CGID;

import fs from 'fs';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import { Server } from 'socket.io';
import { GATEWAY_SOCKET_EVENTS, isGatewaySocketEventAllowed } from '../util/gateway';
import { installSocketRequestChecks, socketServerOriginOptions } from '../util/socketServer';
import { allowedOrigins, socketOriginCheck } from '../util/origins';

const ORIGIN = 'https://cg.box';
const OTHER_ORIGIN = 'https://evil.example';

/** the events the wsapi handles, from its source */
function wsapiEvents(): string[] {
  const source = fs.readFileSync(path.join(__dirname, '../wsapi.ts'), 'utf8');
  const events = new Set<string>();
  for (const match of source.matchAll(/socket\.on\(\s*["'`]([A-Za-z0-9_]+)["'`]/g)) {
    events.add(match[1]);
  }
  // reserved events of a socket, not sent by clients
  for (const reserved of ['disconnect', 'disconnecting', 'error']) {
    events.delete(reserved);
  }
  return [...events];
}

/** the events the server declares it listens to (API.Server.ServerToClientEvents) */
function declaredEvents(): string[] {
  const source = fs.readFileSync(path.join(__dirname, '../common/types/api/server.d.ts'), 'utf8');
  const start = source.indexOf('interface ServerToClientEvents');
  const end = source.indexOf('type ClientToServerEvents');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return [...source.slice(start, end).matchAll(/^\s*"([A-Za-z0-9_]+)":/gm)].map(match => match[1]);
}

describe('the complete socket event list', () => {
  const events = [...new Set([...wsapiEvents(), ...declaredEvents()])];

  it('is read from the code', () => {
    expect(events.length).toBeGreaterThanOrEqual(9);
    for (const event of ['login', 'getSignableSecret', 'setTyping', 'joinCommunityVisitorRoom', 'watchCgIdRequest', 'cgPing']) {
      expect(events).toContain(event);
    }
  });

  it('every event is refused in gateway mode except the gateway events, which the wsapi handles', () => {
    for (const event of events) {
      expect({ event, allowed: isGatewaySocketEventAllowed(event) }).toEqual({ event, allowed: GATEWAY_SOCKET_EVENTS.includes(event) });
    }
    for (const event of GATEWAY_SOCKET_EVENTS) {
      expect(wsapiEvents()).toContain(event);
    }
    expect([...GATEWAY_SOCKET_EVENTS].sort()).toEqual(['cgPing', 'watchCgIdRequest']);
    expect(isGatewaySocketEventAllowed(undefined)).toBe(false);
    expect(isGatewaySocketEventAllowed('__proto__')).toBe(false);
  });
});

// --- a real server ------------------------------------------------------------

type Running = { server: http.Server; io: Server; port: number; handled: string[] };

async function startServer(gatewayMode: boolean, events: string[]): Promise<Running> {
  if (gatewayMode) {
    process.env.CG_GATEWAY = 'true';
    process.env.CG_LEGACY_CGID = 'true';
  }
  else {
    delete process.env.CG_GATEWAY;
    delete process.env.CG_LEGACY_CGID;
  }
  const origins = [ORIGIN];
  // like the wsapi: the server is created first and attached later
  const io = new Server({
    transports: ['polling', 'websocket'],
    path: '/api/ws/',
    ...socketServerOriginOptions(origins),
  });
  installSocketRequestChecks(io as never, origins);
  // stands in for the bot middleware of the wsapi: accepts any token
  io.use((socket, next) => {
    if (socket.handshake.auth?.token !== undefined) {
      socket.data.bot = true;
    }
    next();
  });
  const handled: string[] = [];
  io.on('connection', (socket) => {
    for (const event of events) {
      socket.on(event, (...args: unknown[]) => {
        handled.push(event);
        const ack = args[args.length - 1];
        if (typeof ack === 'function') {
          ack(`handled:${event}`);
        }
      });
    }
  });
  const server = http.createServer();
  io.attach(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  delete process.env.CG_GATEWAY;
  delete process.env.CG_LEGACY_CGID;
  return { server, io, port: (server.address() as AddressInfo).port, handled };
}

async function stopServer(running: Running) {
  running.io.close();
  await new Promise<void>(resolve => running.server.close(() => resolve()));
}

/** a Socket.IO client over a raw WebSocket (engine.io v4 framing) */
class RawSocketClient {
  private ws: WebSocket;
  private packets: string[] = [];
  private waiters: (() => void)[] = [];
  private ackId = 0;
  readonly opened: Promise<void>;
  readonly failed: Promise<number | 'closed'>;

  constructor(port: number, headers: Record<string, string>) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws/?EIO=4&transport=websocket`, { headers });
    this.ws.on('message', (data) => {
      const text = data.toString();
      if (text === '2') {
        this.ws.send('3');
        return;
      }
      this.packets.push(text);
      this.waiters.splice(0).forEach(wake => wake());
    });
    this.opened = new Promise(resolve => this.ws.once('open', () => resolve()));
    this.failed = new Promise(resolve => {
      this.ws.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
      this.ws.once('close', () => resolve('closed'));
    });
    this.ws.on('error', () => undefined);
  }

  async next(prefix: string, timeoutMs = 1500): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.packets.findIndex(packet => packet.startsWith(prefix));
      if (index >= 0) {
        return this.packets.splice(index, 1)[0];
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        return null;
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }

  /** CONNECT to the main namespace; resolves with the server's answer packet */
  async connect(auth?: Record<string, unknown>): Promise<string | null> {
    await this.opened;
    await this.next('0');
    this.ws.send(auth ? `40${JSON.stringify(auth)}` : '40');
    return this.next('4', 2000);
  }

  /** emits an event with an acknowledgement; resolves with the ack's arguments or null (none) */
  async emitWithAck(event: string, ...args: unknown[]): Promise<unknown[] | null> {
    const id = ++this.ackId;
    this.ws.send(`42${id}${JSON.stringify([event, ...args])}`);
    const answer = await this.next(`43${id}[`, 600);
    return answer === null ? null : JSON.parse(answer.slice(`43${id}`.length));
  }

  close() {
    this.ws.terminate();
  }
}

const ALL_EVENTS = [...new Set([...wsapiEvents(), ...declaredEvents()])];

describe('gateway wsapi', () => {
  let running: Running;
  beforeAll(async () => { running = await startServer(true, ALL_EVENTS); });
  afterAll(async () => { await stopServer(running); });

  it('hands only the gateway events to their handlers', async () => {
    const client = new RawSocketClient(running.port, { origin: ORIGIN });
    try {
      expect(await client.connect()).toMatch(/^40\{"sid":/);
      for (const event of ALL_EVENTS) {
        const answer = await client.emitWithAck(event, {});
        if (GATEWAY_SOCKET_EVENTS.includes(event)) {
          expect({ event, answer }).toEqual({ event, answer: [`handled:${event}`] });
        }
        else {
          // never reaches a handler, gets no acknowledgement
          expect({ event, answer }).toEqual({ event, answer: null });
        }
      }
      expect(running.handled.sort()).toEqual([...GATEWAY_SOCKET_EVENTS].sort());
    }
    finally {
      client.close();
    }
  });

  it('refuses token handshakes', async () => {
    const client = new RawSocketClient(running.port, {});
    try {
      const answer = await client.connect({ token: 'cgb_anything', protocolVersion: 1 });
      expect(answer).toMatch(/^44\{"message":"unauthorized"/);
    }
    finally {
      client.close();
    }
  });
});

describe('main wsapi (no gateway)', () => {
  let running: Running;
  beforeAll(async () => { running = await startServer(false, ALL_EVENTS); });
  afterAll(async () => { await stopServer(running); });

  it('hands every event to its handler', async () => {
    const client = new RawSocketClient(running.port, { origin: ORIGIN });
    try {
      expect(await client.connect()).toMatch(/^40\{"sid":/);
      for (const event of ALL_EVENTS) {
        expect({ event, answer: await client.emitWithAck(event, {}) }).toEqual({ event, answer: [`handled:${event}`] });
      }
    }
    finally {
      client.close();
    }
  });

  it('accepts token handshakes (bots)', async () => {
    const client = new RawSocketClient(running.port, {});
    try {
      expect(await client.connect({ token: 'cgb_anything', protocolVersion: 1 })).toMatch(/^40\{"sid":/);
    }
    finally {
      client.close();
    }
  });

  describe('origin checks', () => {
    async function upgrade(headers: Record<string, string>): Promise<'open' | number | 'closed'> {
      const client = new RawSocketClient(running.port, headers);
      try {
        return await Promise.race([client.opened.then(() => 'open' as const), client.failed]);
      }
      finally {
        client.close();
      }
    }

    function poll(headers: Record<string, string>, query = 'EIO=4&transport=polling'): Promise<{ status: number; body: string; allowOrigin?: string }> {
      return new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port: running.port, path: `/api/ws/?${query}`, headers }, (response) => {
          let body = '';
          response.on('data', chunk => { body += chunk; });
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body, allowOrigin: response.headers['access-control-allow-origin'] as string | undefined }));
        });
        request.on('error', reject);
        request.end();
      });
    }

    it('WebSocket upgrade: the listed origin passes, any other is refused', async () => {
      expect(await upgrade({ origin: ORIGIN })).toBe('open');
      expect(await upgrade({ origin: OTHER_ORIGIN })).toBe(400);
      expect(await upgrade({ origin: 'null' })).toBe(400);
      expect(await upgrade({ origin: `${ORIGIN}.evil.example` })).toBe(400);
    });

    it('WebSocket upgrade without an Origin passes (bots, the SDK with its cookie)', async () => {
      // non-browser clients (the SDK connects with its session cookie and no Origin)
      expect(await upgrade({ cookie: 'connect.sid=s%3Aabc.def' })).toBe('open');
      expect(await upgrade({})).toBe('open');
    });

    it('long-polling handshake: the listed origin passes (with CORS headers), any other is refused', async () => {
      const ok = await poll({ origin: ORIGIN });
      expect(ok.status).toBe(200);
      expect(ok.allowOrigin).toBe(ORIGIN);
      expect((await poll({ origin: OTHER_ORIGIN })).status).toBe(400);
      // the same-origin page's GET carries no Origin
      expect((await poll({ cookie: 'connect.sid=s%3Aabc.def' })).status).toBe(200);
    });

    it('the WebSocket upgrade of an existing polling session is checked as well', async () => {
      const handshake = await poll({ origin: ORIGIN });
      const sid = JSON.parse(handshake.body.slice(1)).sid as string;
      const ws = new WebSocket(`ws://127.0.0.1:${running.port}/api/ws/?EIO=4&transport=websocket&sid=${sid}`, { headers: { origin: OTHER_ORIGIN } });
      const result = await new Promise<number | 'open'>(resolve => {
        ws.once('open', () => resolve('open'));
        ws.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
        ws.on('error', () => undefined);
      });
      ws.terminate();
      expect(result).toBe(400);
    });

    it('allowRequest refuses a handshake with another origin (403)', async () => {
      const { allowRequest } = socketServerOriginOptions([ORIGIN]);
      const decide = (headers: Record<string, string>) => new Promise<boolean>(resolve => allowRequest!({ headers } as never, (_err, success) => resolve(success)));
      expect(await decide({ origin: ORIGIN })).toBe(true);
      expect(await decide({ origin: OTHER_ORIGIN })).toBe(false);
      expect(await decide({ upgrade: 'websocket', cookie: 'a=b' })).toBe(true);
      expect(await decide({ upgrade: 'websocket' })).toBe(true);
      expect(await decide({})).toBe(true);
    });
  });
});

describe('the origin list', () => {
  it('is the BASE_URL origin (plus the CG ID origin on a legacy CG ID process)', () => {
    expect(allowedOrigins({ BASE_URL: 'https://cg.box' })).toEqual(['https://cg.box']);
    expect(allowedOrigins({ BASE_URL: 'https://cg.box', CG_LEGACY_CGID: 'true', CGID_URL: 'https://id.app.cg' })).toEqual(['https://cg.box', 'https://id.app.cg']);
    expect(socketOriginCheck({ headers: { origin: 'https://id.app.cg' } }, allowedOrigins({ CG_LEGACY_CGID: 'true', CGID_URL: 'https://id.app.cg' }))).toBeNull();
  });
});

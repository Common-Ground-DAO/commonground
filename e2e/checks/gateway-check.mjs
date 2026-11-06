// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Server-side checks of a live gateway next to its instance (run by
 * e2e/checks/gateway.sh inside the backend image, on the instance's network;
 * it talks to the backends directly, as the edge would):
 *
 *   routes     every route of the api's complete route list (generated from
 *              the code by srv/tests/gatewayAllowlist.spec.ts) against the
 *              gateway api: refused unless allowlisted, allowlisted ones
 *              reached
 *   events     every socket event the deployed wsapi handles (read from its
 *              compiled code) against the gateway wsapi; token handshakes
 *   origins    the origin checks of both wsapi (WebSocket upgrade, polling)
 *              and both api
 *   wallet     wallet sign-in on the gateway (SIWE for the gateway's domain)
 *   passkey    the CG ID passkey assertion on the gateway (a credential of
 *              the CG ID domain's RP) and User/login {type:'passkey-success'}
 *   transfer   a transfer link minted on the gateway redeemed on the instance
 *   isolation  cookies of one instance are anonymous on the other
 *
 * Environment: GW_DOMAIN, GW_ID_DOMAIN, MAIN_DOMAIN, ROUTE_LIST (file),
 * WALLET_KEY (hex private key of the wallet gateway.sh linked), USER_ID,
 * PASSKEY_KEY_PEM (PKCS#8 of the credential gateway.sh inserted),
 * PASSKEY_CREDENTIAL_ID, PASSKEY_USER_HANDLE.
 */

import { readFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, randomBytes, sign, createPrivateKey } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire('/dist/package.json');
const WebSocket = require('ws');
const { ethers } = require('ethers');

const env = process.env;
const GW = 'http://gateway-api:4000';
const MAIN = 'http://api:4000';
const GW_ORIGIN = `https://${env.GW_DOMAIN}`;
const GW_ID_ORIGIN = `https://${env.GW_ID_DOMAIN}`;
const MAIN_ORIGIN = `https://${env.MAIN_DOMAIN}`;
let failures = 0;
const ok = (what) => console.log(`OK   ${what}`);
const bad = (what) => { console.log(`FAIL ${what}`); failures++; };
const check = (cond, what) => (cond ? ok(what) : bad(what));

/** a client of one backend: keeps its cookie like a browser would for that site */
function client(base, origin, clientIp) {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    set cookie(value) { cookie = value; },
    async call(method, path, body, extraHeaders = {}) {
      const headers = {
        'x-forwarded-proto': 'https',
        'x-forwarded-for': clientIp,
        ...(origin ? { origin } : {}),
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...extraHeaders,
      };
      const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(';');
        if (pair.startsWith('connect.sid=')) {
          cookie = /Expires=Thu, 01 Jan 1970/i.test(line) ? '' : pair;
        }
      }
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: response.status, json, text };
    },
  };
}

const ip = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0] % 254)}`;

function deviceKey() {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-384' });
  const jwk = publicKey.export({ format: 'jwk' });
  return { ...jwk, ext: true, key_ops: ['verify'] };
}

// --- routes -----------------------------------------------------------------

async function checkRoutes() {
  const lines = readFileSync(env.ROUTE_LIST, 'utf8').split('\n').filter(Boolean);
  const gw = client(GW, GW_ORIGIN, ip());
  let refused = 0;
  let reached = 0;
  for (const line of lines) {
    const [decision, method, route, sample] = line.split('\t');
    const result = await gw.call(method, sample, method === 'POST' ? {} : undefined);
    const isRefusal = result.status === 404 && result.json?.error === 'NOT_SUPPORTED';
    if (decision === 'ALLOW') {
      if (isRefusal) bad(`routes: allowlisted ${method} ${route} is refused`); else reached++;
    }
    else if (!isRefusal) {
      bad(`routes: ${method} ${route} (${sample}) is NOT refused: ${result.status} ${result.text.slice(0, 120)}`);
    }
    else {
      refused++;
    }
  }
  check(refused + reached === lines.length, `routes: ${lines.length} routes of the complete list — ${refused} refused, ${reached} allowlisted and reached`);
}

// --- socket events ----------------------------------------------------------

function wsapiEvents() {
  const source = readFileSync('/dist/wsapi.js', 'utf8');
  const events = new Set([...source.matchAll(/socket\.on\(\s*["'`]([A-Za-z0-9_]+)["'`]/g)].map(m => m[1]));
  for (const reserved of ['disconnect', 'disconnecting', 'error']) events.delete(reserved);
  return [...events];
}

function rawSocket(host, headers) {
  const ws = new WebSocket(`ws://${host}:4000/api/ws/?EIO=4&transport=websocket`, { headers });
  const packets = [];
  const waiters = [];
  ws.on('message', (data) => {
    const text = data.toString();
    if (text === '2') { ws.send('3'); return; }
    packets.push(text);
    waiters.splice(0).forEach(wake => wake());
  });
  ws.on('error', () => undefined);
  const opened = new Promise((resolve) => {
    ws.once('open', () => resolve('open'));
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.once('close', () => resolve('closed'));
  });
  const next = async (prefix, timeoutMs = 1500) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = packets.findIndex(p => p.startsWith(prefix));
      if (index >= 0) return packets.splice(index, 1)[0];
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise(resolve => { const timer = setTimeout(resolve, left); waiters.push(() => { clearTimeout(timer); resolve(); }); });
    }
  };
  let ackId = 0;
  return {
    opened,
    async connect(auth) {
      if (await opened !== 'open') return null;
      await next('0');
      ws.send(auth ? `40${JSON.stringify(auth)}` : '40');
      return next('4', 3000);
    },
    async emitWithAck(event, ...args) {
      const id = ++ackId;
      ws.send(`42${id}${JSON.stringify([event, ...args])}`);
      const answer = await next(`43${id}[`, 800);
      return answer === null ? null : JSON.parse(answer.slice(`43${id}`.length));
    },
    close() { ws.terminate(); },
  };
}

async function checkEvents() {
  const events = wsapiEvents();
  check(events.includes('login') && events.includes('watchCgIdRequest'), `events: ${events.length} events read from the deployed /dist/wsapi.js (${events.join(', ')})`);
  const allowed = ['cgPing', 'watchCgIdRequest'];
  const socket = rawSocket('gateway-wsapi', { origin: GW_ORIGIN });
  const connected = await socket.connect();
  check(/^40\{"sid":/.test(connected ?? ''), 'events: a socket connects to the gateway wsapi');
  // events that answer with an acknowledgement on the main wsapi
  const main = rawSocket('wsapi', { origin: MAIN_ORIGIN });
  await main.connect();
  for (const event of events) {
    // cgPing takes only the acknowledgement
    const args = event === 'cgPing' ? [] : [event === 'watchCgIdRequest' ? { frontendRequestId: 'abcdefghijklmnopqrst' } : {}];
    const answer = await socket.emitWithAck(event, ...args);
    if (event === 'cgPing') {
      check(Array.isArray(answer) && typeof answer[0] === 'number', 'events: cgPing answers on the gateway');
    }
    else if (allowed.includes(event)) {
      ok(`events: ${event} is served on the gateway (no acknowledgement by design)`);
    }
    else {
      check(answer === null, `events: ${event} gets no answer on the gateway`);
    }
  }
  const secret = await main.emitWithAck('getSignableSecret');
  check(Array.isArray(secret) && typeof secret[0] === 'string', 'events: the main wsapi still answers getSignableSecret');
  socket.close();
  main.close();

  const bot = rawSocket('gateway-wsapi', {});
  const botAnswer = await bot.connect({ token: 'cgb_not_a_token', protocolVersion: 1 });
  check(/^44/.test(botAnswer ?? ''), 'events: the gateway wsapi refuses token handshakes');
  bot.close();
}

// --- origins ----------------------------------------------------------------

async function checkOrigins() {
  for (const [host, own] of [['gateway-wsapi', GW_ORIGIN], ['wsapi', MAIN_ORIGIN]]) {
    const good = rawSocket(host, { origin: own });
    check(await good.opened === 'open', `origins: ${host} WebSocket upgrade from ${own} passes`);
    good.close();
    const other = own === GW_ORIGIN ? MAIN_ORIGIN : GW_ORIGIN;
    const cross = rawSocket(host, { origin: other });
    check(await cross.opened === 400, `origins: ${host} WebSocket upgrade from ${other} is refused`);
    cross.close();
    const evil = rawSocket(host, { origin: 'https://evil.example' });
    check(await evil.opened === 400, `origins: ${host} WebSocket upgrade from another site is refused`);
    evil.close();
    const cookieNoOrigin = rawSocket(host, { cookie: 'connect.sid=s%3Ax.y' });
    check(await cookieNoOrigin.opened === 'open', `origins: ${host} WebSocket upgrade without Origin (non-browser client with a cookie, like the SDK) passes`);
    cookieNoOrigin.close();
    const polling = await fetch(`http://${host}:4000/api/ws/?EIO=4&transport=polling`, { headers: { origin: 'https://evil.example' } });
    check(polling.status >= 400, `origins: ${host} polling handshake from another site is refused (${polling.status})`);
  }
  for (const [base, name, own] of [[GW, 'gateway api', GW_ORIGIN], [MAIN, 'api', MAIN_ORIGIN]]) {
    const evil = await client(base, 'https://evil.example', ip()).call('POST', '/User/checkLoginStatus', {});
    check(evil.status === 403 && evil.json?.error === 'NOT_ALLOWED', `origins: ${name} refuses another site's Origin (${evil.status})`);
    const preflight = await client(base, own, ip()).call('OPTIONS', '/User/login', undefined, { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-cg-socket-id' });
    check(preflight.status === 204, `origins: ${name} preflight with x-cg-socket-id passes (${preflight.status})`);
  }
  const cgid = await client(GW, GW_ID_ORIGIN, ip()).call('POST', '/CgId/ensureSession', {});
  check(cgid.status === 200, `origins: the gateway api serves the CG ID app's origin (${cgid.status})`);
  const cgidOnMain = await client(MAIN, GW_ID_ORIGIN, ip()).call('POST', '/User/checkLoginStatus', {});
  check(cgidOnMain.status === 403, `origins: the main api refuses the CG ID app's origin (${cgidOnMain.status})`);
}

// --- sign-in methods --------------------------------------------------------

async function walletLogin() {
  const gw = client(GW, GW_ORIGIN, ip());
  const wallet = new ethers.Wallet(env.WALLET_KEY);
  const secret = (await gw.call('POST', '/User/getSignableSecret', {})).json?.data;
  const message = [
    `${env.GW_DOMAIN} wants you to sign in with your Ethereum account:`,
    wallet.address,
    '',
    'Sign this to log into Common Ground.',
    '',
    `URI: ${GW_ORIGIN}`,
    'Version: 1',
    'Chain ID: 1',
    `Nonce: ${secret}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join('\n');
  const prepared = await gw.call('POST', '/User/prepareWalletAction', {
    type: 'evm',
    signature: await wallet.signMessage(message),
    data: { type: 'evm', address: wallet.address.toLowerCase(), secret, siweMessage: message },
  });
  check(prepared.json?.data?.readyForLogin === true, `wallet: the gateway accepts a SIWE message for its own domain (${prepared.text.slice(0, 160)})`);
  const login = await gw.call('POST', '/User/login', { type: 'wallet', device: { publicKey: deviceKey() } });
  check(login.json?.data?.ownData?.id === env.USER_ID, `wallet: signed in on the gateway with the wallet (${login.json?.error ?? 'ok'})`);
  check(Array.isArray(login.json?.data?.communities) && login.json.data.communities.length === 0 && login.json.data.chats.length === 0,
    'wallet: the gateway login answer carries no communities or chats');

  // a message signed for the main instance's domain is refused here
  const other = client(GW, GW_ORIGIN, ip());
  const secret2 = (await other.call('POST', '/User/getSignableSecret', {})).json?.data;
  const foreign = message.replace(`${env.GW_DOMAIN} wants`, `${env.MAIN_DOMAIN} wants`).replace(`URI: ${GW_ORIGIN}`, `URI: ${MAIN_ORIGIN}`).replace(/Nonce: .*/, `Nonce: ${secret2}`);
  const refused = await other.call('POST', '/User/prepareWalletAction', {
    type: 'evm',
    signature: await wallet.signMessage(foreign),
    data: { type: 'evm', address: wallet.address.toLowerCase(), secret: secret2, siweMessage: foreign },
  });
  check(refused.json?.status === 'ERROR' || refused.json?.data?.readyForLogin === false, `wallet: a SIWE message for ${env.MAIN_DOMAIN} is refused on the gateway (${refused.text.slice(0, 120)})`);
  return gw;
}

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

async function passkeyLogin() {
  const gw = client(GW, GW_ORIGIN, ip());
  // the CG ID app and the gateway share the session (cookie for .<gateway domain>)
  const cgid = client(GW, GW_ID_ORIGIN, ip());
  const opts = await cgid.call('POST', '/CgId/generateAuthenticationOptions', {});
  check(opts.json?.data?.rpId === env.GW_ID_DOMAIN, `passkey: assertion options for the CG ID RP ${env.GW_ID_DOMAIN} (${opts.json?.data?.rpId ?? opts.text.slice(0, 80)})`);
  const challenge = opts.json?.data?.challenge;
  const clientDataJSON = JSON.stringify({ type: 'webauthn.get', challenge, origin: GW_ID_ORIGIN, crossOrigin: false });
  const authData = Buffer.concat([createHash('sha256').update(env.GW_ID_DOMAIN).digest(), Buffer.from([0x05]), Buffer.from([0, 0, 0, 0])]);
  const key = createPrivateKey(env.PASSKEY_KEY_PEM);
  const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]), key);
  const verified = await cgid.call('POST', '/CgId/verifyAuthenticationResponse', {
    frontendRequestId: 'abcdefghijklmnopqrst',
    authenticationResponse: {
      id: env.PASSKEY_CREDENTIAL_ID,
      rawId: env.PASSKEY_CREDENTIAL_ID,
      type: 'public-key',
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: env.PASSKEY_USER_HANDLE,
      },
    },
  });
  check(verified.json?.data === true, `passkey: the gateway verifies the CG ID assertion (${verified.text.slice(0, 160)})`);
  // the main window: same session (same cookie, the gateway's own origin)
  gw.cookie = cgid.cookie;
  const login = await gw.call('POST', '/User/login', { type: 'passkey-success', device: { publicKey: deviceKey() } });
  check(login.json?.data?.ownData?.id === env.USER_ID, `passkey: User/login {passkey-success} signs in on the gateway (${login.json?.error ?? 'ok'})`);
  // the main instance has no CgId router and refuses passkey-success
  const onMain = await client(MAIN, MAIN_ORIGIN, ip()).call('POST', '/CgId/generateAuthenticationOptions', {});
  check(onMain.json?.status !== 'OK', `passkey: the main instance does not serve the CG ID passkey surface (${onMain.status})`);
  return gw;
}

async function transferAndIsolation(gw) {
  const link = await gw.call('POST', '/User/createTransferLink', { nextPath: '/c/somewhere/' });
  const url = link.json?.data?.url ?? '';
  check(url.startsWith(`${MAIN_ORIGIN}/transfer#`), `transfer: the gateway mints a link to ${MAIN_ORIGIN} (${url.replace(/#.*/, '#…')})`);
  const token = url.split('#')[1];
  const main = client(MAIN, MAIN_ORIGIN, ip());
  // the gateway's cookie on the instance: anonymous
  main.cookie = gw.cookie;
  const crossed = await main.call('POST', '/User/checkLoginStatus', {});
  check(crossed.json?.data?.userId === null, 'isolation: the gateway session cookie is anonymous on the instance');
  main.cookie = '';
  const redeemed = await main.call('POST', '/User/redeemTransferLink', { token, device: { publicKey: deviceKey() } });
  check(redeemed.json?.data?.ownData?.id === env.USER_ID && redeemed.json?.data?.nextPath === '/c/somewhere/', `transfer: redeemed on the instance, deep link kept (${redeemed.json?.error ?? redeemed.json?.data?.nextPath})`);
  const again = await client(MAIN, MAIN_ORIGIN, ip()).call('POST', '/User/redeemTransferLink', { token, device: { publicKey: deviceKey() } });
  check(again.json?.error === 'TRANSFER_LINK_INVALID', 'transfer: a link signs in once');
  // and the instance's cookie on the gateway: anonymous
  const back = client(GW, GW_ORIGIN, ip());
  back.cookie = main.cookie;
  const backStatus = await back.call('POST', '/User/checkLoginStatus', {});
  check(backStatus.json?.data?.userId === null, 'isolation: the instance session cookie is anonymous on the gateway');
  const onGateway = await client(GW, GW_ORIGIN, ip()).call('POST', '/User/redeemTransferLink', { token: 'x'.repeat(43), device: { publicKey: deviceKey() } });
  check(onGateway.status === 404 && onGateway.json?.error === 'NOT_SUPPORTED', 'transfer: the gateway does not redeem links');
}

// --- review additions --------------------------------------------------------

async function checkReviewItems() {
  // a bearer token is refused before it is looked up, also on an allowlisted route
  const bearer = await client(GW, GW_ORIGIN, ip()).call('POST', '/User/login', {}, { authorization: 'Bearer cgb_not_a_token' });
  check(bearer.status === 404 && bearer.json?.error === 'NOT_SUPPORTED', `bearer: a request with an Authorization header is refused on the gateway (${bearer.status})`);

  // clearLoginSession without a session creates none
  const fresh = client(GW, GW_ORIGIN, ip());
  const cleared = await fresh.call('POST', '/User/clearLoginSession', {});
  check(cleared.status === 200 && fresh.cookie === '', `clearLoginSession: answered without creating a session (cookie: ${fresh.cookie ? 'set' : 'none'})`);

  // one-click unsubscribe from a mail provider's origin is not refused by the origin check
  const unsubscribe = await fetch(`${MAIN}/User/emailUnsubscribe?token=not-a-token`, {
    method: 'POST',
    headers: { origin: 'https://mail.example', 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip(), 'x-forwarded-proto': 'https' },
    body: 'List-Unsubscribe=One-Click',
  });
  const unsubscribeText = await unsubscribe.text();
  check(unsubscribe.status !== 403 && /link|unsubscribe/i.test(unsubscribeText), `unsubscribe: a one-click POST with a foreign Origin reaches the endpoint (${unsubscribe.status}, the invalid-link page)`);
  const notExempt = await client(MAIN, 'https://mail.example', ip()).call('POST', '/User/checkLoginStatus', {});
  check(notExempt.status === 403, 'unsubscribe: the exemption covers that endpoint only');

  // LUKSO: the gateway reaches the onchain service like the instance does
  // (same answer for the same request; on this instance the blockchain
  // services may be off, then both say so)
  const lukso = async (base, origin) => {
    const c = client(base, origin, ip());
    const secret = (await c.call('POST', '/User/getSignableSecret', {})).json?.data;
    return c.call('POST', '/Lukso/PrepareLuksoAction', { address: '0x' + '22'.repeat(20), signature: '0x00', message: `sign in\nNonce: ${secret}` });
  };
  const onGateway = await lukso(GW, GW_ORIGIN);
  const onMain = await lukso(MAIN, MAIN_ORIGIN);
  check(onGateway.json?.error === onMain.json?.error && onGateway.json?.error !== 'NOT_SUPPORTED',
    `lukso: PrepareLuksoAction answers on the gateway like on the instance (${onGateway.json?.error} / ${onMain.json?.error})`);
}

const step = async (name, fn) => {
  try {
    return await fn();
  }
  catch (e) {
    bad(`${name}: ${e?.stack ?? e}`);
    return undefined;
  }
};

await step('routes', checkRoutes);
await step('events', checkEvents);
await step('origins', checkOrigins);
await step('review items', checkReviewItems);
const walletSession = await step('wallet', walletLogin);
const passkeySession = await step('passkey', passkeyLogin);
if (walletSession) await step('transfer', () => transferAndIsolation(walletSession));
if (passkeySession) await step('transfer (passkey session)', async () => {
  const link = await passkeySession.call('POST', '/User/createTransferLink', {});
  check(link.json?.data?.url?.startsWith(`${MAIN_ORIGIN}/transfer#`), 'transfer: a CG ID passkey session mints a link as well');
});
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

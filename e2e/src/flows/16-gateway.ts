// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { Page } from 'puppeteer';
import type { Flow, FlowContext } from '../lib/harness.ts';
import { signUp, waitLoggedIn } from '../lib/account.ts';
import { waitForCode } from '../lib/mailpit.ts';
import { assert, clickText, fill, hasText, until, waitText } from '../lib/ui.ts';

/**
 * The gateway of a moved instance (docs/auth-identity §12), next to the
 * instance it moved to (--gateway-url; the disposable instance runs one with
 * E2E_GATEWAY=1): an account of the instance signs in on the gateway as
 * before — email + password, then silently with the device key the gateway
 * stored, then with a code by email — and every time continues on the
 * instance with a one-time transfer link, which keeps the deep link the
 * gateway was opened with. The gateway offers no sign-up, and its session
 * cookie is worthless on the instance (and the other way round). At the old
 * app's worker URL the gateway serves a replacement worker, which replaces an
 * old worker: its caches go, and its page reloads once into the gateway page.
 *
 * What runs where the browser cannot go (the CG ID passkey popup, a wallet)
 * is covered by e2e/checks/gateway.sh at the API level.
 */

const DEEP_LINK = '/notifications/';

/** in the gateway's replacement worker (docker/caddy/gateway-service-worker.js) */
const REPLACEMENT_WORKER_MARKER = "const VERSION = 'gateway-sw-";

function gatewayUrl(t: FlowContext, path = '/') {
  return `${t.config.gatewayUrl}${path}`;
}

/** the "moved" page of the gateway, logged out */
async function openGateway(t: FlowContext, page: Page, path: string, targetHost: string) {
  await page.goto(gatewayUrl(t, path), { waitUntil: 'domcontentloaded' });
  await waitText(page, `Common Ground has moved to ${targetHost}`, 30_000);
}

/** follows the transfer link to the instance and confirms it there; returns the path it ends on */
async function confirmTransfer(t: FlowContext, page: Page, name: string, alreadySignedIn = false): Promise<string> {
  await until('the transfer link to open the instance', async () => {
    const url = new URL(page.url());
    return url.origin === t.origin && url.pathname === '/transfer' ? true : null;
  }, 30_000);
  // the token leaves the address bar as soon as the app starts (it is kept in memory only)
  await until('the transfer token to leave the address bar', async () => (page.url().includes('#') ? null : true), 15_000);
  const label = alreadySignedIn ? 'Continue' : `Continue as ${name}`;
  await waitText(page, alreadySignedIn ? `You're already signed in as ${name}` : `Continue as ${name}?`);
  // the button is enabled once the page knows whether someone is signed in
  await page.waitForFunction((text: string) => Array.from(document.querySelectorAll('button'))
    .some(b => b.innerText.trim() === text && !b.disabled), { timeout: 30_000, polling: 250 }, label);
  await clickText(page, label, { selector: 'button' });
  return until('the transfer to finish', async () => {
    const url = new URL(page.url());
    return url.origin === t.origin && url.pathname !== '/transfer' ? url.pathname : null;
  }, 30_000);
}

/** the session cookie the browser sends to an origin (host-only or a parent-domain cookie) */
async function sessionCookie(page: Page, origin: string): Promise<string | null> {
  const host = new URL(origin).hostname;
  const sentTo = (domain: string) => domain === host || (domain.startsWith('.') && (host === domain.slice(1) || host.endsWith(domain)));
  const cookies = await page.browserContext().cookies();
  const cookie = cookies.find(c => c.name === 'connect.sid' && sentTo(c.domain));
  return cookie ? `connect.sid=${cookie.value}` : null;
}

/** POST /User/checkLoginStatus on `origin` with `cookie` (from the runner, not the browser) */
async function loginStatus(origin: string, cookie: string): Promise<string | null> {
  const response = await fetch(`${origin}/api/v2/User/checkLoginStatus`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{}',
  });
  const body = await response.json() as { status: string; data?: { userId: string | null } };
  assert(body.status === 'OK', `checkLoginStatus on ${origin}: ${JSON.stringify(body)}`);
  return body.data?.userId ?? null;
}

export const gateway: Flow = {
  id: 'gateway',
  title: 'Gateway of a moved instance: old sign-in, transfer link, deep link kept',
  async run(t) {
    if (!t.config.gatewayUrl) {
      t.skip('no --gateway-url (the disposable instance runs a gateway with E2E_GATEWAY=1)');
    }
    const targetHost = new URL(t.config.baseUrl).host;

    // an account of the instance (the gateway shares its database)
    const home = await t.session('instance');
    const account = await t.step('an account exists on the instance', () => signUp(t, home, 'password', 'gwuser'));

    const gw = await t.session('gateway');
    await t.step(`a deep link on the gateway shows "moved to ${targetHost}" and only sign-in`, async () => {
      await openGateway(t, gw.page, DEEP_LINK, targetHost);
      await gw.page.waitForSelector('input[name=username]', { visible: true });
      assert(!await hasText(gw.page, 'Create an account'), 'the gateway offers a sign-up');
    });

    await t.step('the old worker URL serves the replacement worker (JavaScript, no-cache); the instance keeps its own', async () => {
      const response = await fetch(gatewayUrl(t, '/service-worker.js'));
      const body = await response.text();
      assert(response.status === 200, `gateway /service-worker.js: HTTP ${response.status}`);
      const type = response.headers.get('content-type') ?? '';
      assert(/^(text|application)\/javascript\b/.test(type), `gateway /service-worker.js: Content-Type ${type}`);
      const cacheControl = response.headers.get('cache-control') ?? '';
      assert(/\bno-(cache|store)\b/.test(cacheControl), `gateway /service-worker.js: Cache-Control ${cacheControl}`);
      assert(body.includes(REPLACEMENT_WORKER_MARKER), 'the gateway serves another worker than the replacement at /service-worker.js');
      const own = await (await fetch(`${t.origin}/service-worker.js`)).text();
      assert(!own.includes(REPLACEMENT_WORKER_MARKER) && own.includes('precache'), "the instance's own worker is not its precaching one");
    });

    const old = await t.session('gateway-old-worker');
    await t.step('an old worker on the gateway origin is replaced: its caches go, its page reloads once into the gateway page', async () => {
      const page = old.page;
      const gatewayOrigin = new URL(t.config.gatewayUrl!).origin;
      // counts the documents this tab loads on the gateway origin
      await page.evaluateOnNewDocument(() => {
        if (window.top !== window) return;
        try {
          sessionStorage.setItem('e2eDocuments', String(Number(sessionStorage.getItem('e2eDocuments') ?? '0') + 1));
        }
        catch {
          // no storage on this document
        }
      });
      // A stand-in for the old app's worker, registered from a page of the
      // origin that is not the app: the same file under another URL, so the
      // real URL is an update of it, as for an old app. It controls the
      // pages from here on; the old app's precache is seeded by hand.
      await page.goto(gatewayUrl(t, '/robots.txt'), { waitUntil: 'domcontentloaded' });
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.register('/service-worker.js?e2e=stand-in-for-the-old-worker', { scope: '/' });
        const deadline = Date.now() + 15_000;
        while (registration.active?.state !== 'activated') {
          if (Date.now() > deadline) throw new Error('the stand-in worker did not activate');
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const cache = await caches.open(`workbox-precache-v2-${location.origin}/`);
        await cache.put('/index.html', new Response('the old app'));
      });
      // the gateway page registers /service-worker.js — an update of the
      // stand-in; the new worker reloads the page the stand-in controls
      await page.goto(gatewayUrl(t, DEEP_LINK), { waitUntil: 'domcontentloaded' });
      const readState = () => page.evaluate(async () => ({
        documents: Number(sessionStorage.getItem('e2eDocuments') ?? '0'),
        caches: await caches.keys(),
        workers: (await navigator.serviceWorker.getRegistrations()).map(r => r.active?.scriptURL ?? null),
        controlled: !!navigator.serviceWorker.controller,
        path: location.pathname,
      }));
      await until('the replacement worker to reload the page', async () => {
        const now = await readState().catch(() => null);
        return now && now.documents >= 3 ? true : null;
      }, 30_000).catch(async (error: Error) => {
        throw new Error(`${error.message}; page state: ${JSON.stringify(await readState().catch(e => String(e)))}`);
      });
      await waitText(page, `Common Ground has moved to ${targetHost}`, 30_000);
      // no second reload: the reloaded page registers the same worker again
      await new Promise(resolve => setTimeout(resolve, 3_000));
      const state = await readState();
      assert(state.documents === 3, `the tab loaded ${state.documents} documents, expected robots.txt, the gateway page and one reload`);
      assert(state.caches.length === 0, `caches left: ${state.caches.join(', ')}`);
      assert(state.workers.length === 1 && state.workers[0] === `${gatewayOrigin}/service-worker.js`, `registered workers: ${state.workers.join(', ')}`);
      assert(state.controlled, 'the reloaded page has no controlling worker');
      assert(state.path === DEEP_LINK, `the reloaded page is on ${state.path}, expected ${DEEP_LINK}`);
    });

    await t.step('sign in on the gateway with email + password: the transfer link leads to the deep link on the instance', async () => {
      await fill(gw.page, 'input[name=username]', account.email);
      await fill(gw.page, 'input[type=password]', account.password!);
      await clickText(gw.page, 'Log in', { selector: 'form button' });
      const landed = await confirmTransfer(t, gw.page, account.name);
      assert(landed === DEEP_LINK, `landed on ${landed}, expected the deep link ${DEEP_LINK}`);
      assert(await waitLoggedIn(gw.page) === account.userId, 'signed in on the instance as another account');
    });

    await t.step('the cookies of the two do not cross: the gateway session is unknown to the instance and vice versa', async () => {
      const gatewayCookie = await sessionCookie(gw.page, t.config.gatewayUrl!);
      const instanceCookie = await sessionCookie(gw.page, t.origin);
      assert(!!gatewayCookie && !!instanceCookie, `missing session cookies (gateway ${!!gatewayCookie}, instance ${!!instanceCookie})`);
      assert(await loginStatus(t.config.gatewayUrl!, gatewayCookie!) === account.userId, 'the gateway cookie does not work on the gateway');
      assert(await loginStatus(t.origin, instanceCookie!) === account.userId, 'the instance cookie does not work on the instance');
      assert(await loginStatus(t.origin, gatewayCookie!) === null, 'the gateway cookie signs in on the instance');
      assert(await loginStatus(t.config.gatewayUrl!, instanceCookie!) === null, 'the instance cookie signs in on the gateway');
    });

    await t.step('the gateway page opened no data socket', async () => {
      // the page is on the instance by now; check a fresh gateway page instead
      const probe = await gw.context.newPage();
      try {
        await probe.goto(gatewayUrl(t, '/'), { waitUntil: 'domcontentloaded' });
        await waitText(probe, `Continue to ${targetHost}`, 30_000);
        const sockets = await probe.evaluate(() => performance.getEntriesByType('resource')
          .map(entry => entry.name).filter(name => name.includes('/api/ws/')));
        assert(sockets.length === 0, `the gateway page opened a socket: ${sockets.join(', ')}`);
      }
      finally {
        await probe.close();
      }
    });

    await t.step('back on the gateway: signed in silently with its device key, the link again', async () => {
      await gw.page.goto(gatewayUrl(t, '/'), { waitUntil: 'domcontentloaded' });
      await waitText(gw.page, `Continue to ${targetHost}`, 30_000);
      await clickText(gw.page, `Continue to ${targetHost}`, { selector: 'button' });
      const landed = await confirmTransfer(t, gw.page, account.name, true);
      t.note(`without a deep link the transfer ends on ${landed}`);
    });

    if (!t.config.mailpitUrl) {
      t.note('email-code sign-in on the gateway skipped: no --mailpit');
      return;
    }
    const code = await t.session('gateway-email-code');
    // a second gateway tab of that browser, side by side with the first
    const second = await t.tab(code, 'second', { window: true });
    await t.step('sign in on the gateway with a code by email; a second gateway tab takes the sign-in over and waits', async () => {
      await openGateway(t, second.page, '/', targetHost);
      await openGateway(t, code.page, '/', targetHost);
      await clickText(code.page, 'Email me a code instead', { selector: 'button' });
      await fill(code.page, 'input[name=email]', account.email);
      const since = Date.now();
      await clickText(code.page, 'Send code', { selector: 'button' });
      const mailed = await waitForCode(t.config.mailpitUrl!, account.email, since);
      await fill(code.page, 'input[name=code]', mailed);
      await clickText(code.page, 'Log in', { selector: 'form button' });
      const landed = await confirmTransfer(t, code.page, account.name);
      assert(landed === '/' || landed === '', `landed on ${landed}`);
      assert(await waitLoggedIn(code.page) === account.userId, 'signed in on the instance as another account');
      // the second tab takes the first one's sign-in over (no device login,
      // no local data — the guards would report any refused request) and
      // shows the button: only the tab that signed in continues by itself
      await waitText(second.page, `Continue to ${targetHost}`, 30_000);
      await new Promise(resolve => setTimeout(resolve, 3_000));
      const secondUrl = new URL(second.page.url());
      assert(secondUrl.origin === new URL(t.config.gatewayUrl!).origin, `the second gateway tab went on by itself to ${secondUrl.href}`);
      assert(await hasText(second.page, `Continue to ${targetHost}`), 'the second gateway tab no longer offers to continue');
    });
  },
};

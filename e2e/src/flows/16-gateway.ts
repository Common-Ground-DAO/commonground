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
 * cookie is worthless on the instance (and the other way round).
 *
 * What runs where the browser cannot go (the CG ID passkey popup, a wallet)
 * is covered by e2e/checks/gateway.sh at the API level.
 */

const DEEP_LINK = '/notifications/';

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

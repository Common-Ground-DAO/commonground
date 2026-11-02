// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { HTTPResponse } from 'puppeteer';
import type { Flow } from '../lib/harness.ts';
import { RELOAD_MODES, type ReloadMode } from '../lib/config.ts';
import { signUp } from '../lib/account.ts';
import { closeUserMenu, connectionState, createChannel, createCommunity, EDITOR, navigate, openChannel, openUserMenu, waitAppReady, waitMessageConfirmed } from '../lib/app.ts';
import { assert, sleep, until } from '../lib/ui.ts';
import { sessionIdFromCookie, valkeyCommands } from '../lib/valkey.ts';
import { coldServiceWorkerReload } from '../lib/cdp.ts';

/**
 * Reload robustness. Every page load of a logged-in app runs a device-key
 * login (User/login with the device id), which regenerates the session id.
 * Requests that overlap with it can fail with LOGIN_REQUIRED, and the
 * websocket can drop to "disconnected"/"offline".
 *
 * Each iteration reloads (plain reload, hard reload bypassing cache and
 * service worker, or a fresh navigation) and fires typical actions as soon
 * as the UI allows: send a message, open the user settings, and every few
 * iterations create a community.
 *
 * Three modes take turns:
 *   natural    the network as it is
 *   interrupted  the page is reloaded once more while the device login of
 *              the previous load is still out (a user hitting reload twice,
 *              or navigating right after opening the app): the server
 *              completes the aborted login and regenerates the session,
 *              but the browser never receives the new cookie
 *   reordered  the device login's response is held back briefly, and the
 *              responses of requests the app sent while it was out are
 *              delivered after it (CDP Fetch). Server-side processing is
 *              unchanged; only the delivery order is the unlucky one a slow
 *              or busy network produces now and then. This makes the overlap
 *              with the session-id change reproducible.
 *   cookie-cleared   the browser has no session cookie any more when the
 *              page loads (a cookie that expired or was cleared): the load
 *              starts anonymous and the device login creates the session
 *   session-expired  the session was deleted server-side (the `sess:<id>`
 *              key in Valkey; only with E2E_REDIS_URL, i.e. the disposable
 *              instance): the browser sends a cookie the server no longer
 *              knows
 *   force-reload-cold-sw  the service worker is stopped (CDP
 *              ServiceWorker.stopAllWorkers, as the browser does with an
 *              idle worker) and the page hard-reloaded (Page.reload
 *              ignoreCache, through the worker, which has to start cold);
 *              the indicator must show "connected" within 12 s of the
 *              reload — "hidden" (never connected since the load) counts
 *              as a failure in this mode
 * --reload-modes picks a subset; the default rotates through all available
 * (session-expired needs E2E_REDIS_URL).
 * The report has per-iteration results, the failure rate per mode, and as
 * diagnostics every Set-Cookie of the session cookie that arrived after the
 * device login had set a new session id ("cookie regressions").
 */

const SETTLE_MS = 12_000;
const MAX_HOLD_MS = 4_000;
const LOGIN_HOLD_MS = 800;
/** force-reload-cold-sw: "connected" within this time of the load */
const COLD_SW_CONNECT_MS = 12_000;

type Mode = ReloadMode;

type Iteration = {
  i: number;
  mode: Mode;
  reload: 'reload' | 'hard-reload-bypass-sw' | 'navigate' | 'cold-sw-reload';
  deviceLogins: number;
  heldResponses: number;
  loginRequired: string[];
  otherApiErrors: string[];
  indicatorStates: string[];
  finalState: string;
  actions: string[];
  failures: string[];
  /** diagnostics: Set-Cookie of the session cookie after the device login set a new one */
  cookieRegressions: string[];
  ms: number;
};

export const reload: Flow = {
  id: 'reload',
  title: 'Reload robustness: reload N times and act immediately (session race, offline indicator)',
  // setup + a failing iteration can take ~25 s (it waits for the lost message)
  timeoutMs: config => Math.max(config.flowTimeoutMs, 90_000 + config.reloadIterations * 25_000),
  async run(t) {
    const s = await t.session('reload');
    const page = s.page;

    // what the connection indicator showed, recorded inside each page load
    await page.evaluateOnNewDocument(() => {
      const w = window as unknown as { __e2eIndicator: string[] };
      w.__e2eIndicator = [];
      const started = performance.now();
      const watch = () => {
        const el = document.getElementById('cg-connection-indicator');
        if (!el) {
          return false;
        }
        const record = () => {
          const cls = Array.from(el.classList).find(c => c.startsWith('cg-connection-indicator-'))?.slice('cg-connection-indicator-'.length) ?? '?';
          const visible = getComputedStyle(el).opacity !== '0';
          const state = `${cls}${visible ? '' : '(hidden)'}`;
          if (w.__e2eIndicator[w.__e2eIndicator.length - 1]?.split(':')[1] !== state) {
            w.__e2eIndicator.push(`${Math.round(performance.now() - started)}ms:${state}`);
          }
        };
        record();
        new MutationObserver(record).observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
        return true;
      };
      const poll = setInterval(() => {
        if (watch()) {
          clearInterval(poll);
        }
      }, 50);
    });

    const account = await t.step('setup: sign up, community and channel', async () => {
      const a = await signUp(t, s, 'password', 'reload');
      const community = await createCommunity(t, page);
      const channel = await createChannel(t, page, community, 'reload-chat');
      await openChannel(t, page, channel);
      return { ...a, channel };
    });

    const iterations: Iteration[] = [];
    let current: Iteration | undefined;

    // --- the "reordered" mode. While the device login is out (request sent,
    // response not yet delivered), the app keeps talking to the server (API
    // calls, socket.io polling) with the pre-login session cookie. In this
    // mode the login's response is held back for LOGIN_HOLD_MS (more traffic
    // falls into the window), and every response to a request sent inside
    // the window is delivered only after the login's response.
    let reorder = false;
    let loginInFlight = false;
    let loginDelivered = false;
    const sentDuringLogin = new Set<string>();
    let releaseHeld: (() => void)[] = [];
    const releaseAll = () => {
      const held = releaseHeld;
      releaseHeld = [];
      held.forEach(release => release());
    };
    await s.cdp.send('Network.enable');
    s.cdp.on('Network.requestWillBeSent', ({ requestId, request }) => {
      if (request.url.includes('/api/v2/User/login')) {
        loginInFlight = true;
      }
      else if (loginInFlight && !loginDelivered) {
        sentDuringLogin.add(requestId);
      }
    });
    await s.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Response' }] });
    s.cdp.on('Fetch.requestPaused', async ({ requestId, networkId, request }) => {
      // every paused response is continued exactly once (finally)
      try {
        if (request.url.includes('/api/v2/User/login')) {
          if (reorder) {
            await sleep(LOGIN_HOLD_MS);
          }
          return;
        }
        if (reorder && networkId && sentDuringLogin.has(networkId) && !loginDelivered) {
          if (current) {
            current.heldResponses++;
          }
          await new Promise<void>(resolve => {
            releaseHeld.push(resolve);
            setTimeout(resolve, MAX_HOLD_MS);
          });
        }
      }
      finally {
        await s.cdp.send('Fetch.continueRequest', { requestId }).catch(() => undefined);
        if (request.url.includes('/api/v2/User/login')) {
          loginDelivered = true;
          loginInFlight = false;
          // a moment for the browser to store the new session cookie
          setTimeout(releaseAll, 50);
        }
      }
    });

    // --- diagnostics: the session cookie going back to an outdated id.
    // A response with a Set-Cookie of another session id that arrives after
    // the device login's response puts an outdated (or a fresh anonymous)
    // session id back into the browser. The server only sends the session
    // cookie when a session is created or changed, or for a logged-in session
    // (srv/util/sessionSetup.ts), so this should not happen any more.
    const requestUrls = new Map<string, string>();
    let sessionCookie: string | undefined;
    let loginSid: string | undefined;
    s.cdp.on('Network.requestWillBeSent', ({ requestId, request }) => {
      requestUrls.set(requestId, request.url);
    });
    s.cdp.on('Network.responseReceivedExtraInfo', ({ requestId, headers }) => {
      const it = current;
      const raw = headers['set-cookie'] ?? headers['Set-Cookie'];
      const url = requestUrls.get(requestId) ?? '?';
      if (!it || !raw) {
        return;
      }
      const isLogin = url.includes('/api/v2/User/login');
      for (const line of String(raw).split('\n')) {
        const match = /^([^=;\s]+)=([^;]*)/.exec(line.trim());
        if (!match || !match[2] || /Expires=Thu, 01 Jan 1970/i.test(line)) {
          continue;
        }
        const [, name, value] = match;
        if (isLogin) {
          sessionCookie ??= name;
          if (name === sessionCookie) {
            loginSid = value;
          }
        }
        else if (name === sessionCookie && loginSid && value !== loginSid) {
          it.cookieRegressions.push(`${url.startsWith('http') ? new URL(url).pathname : `request ${requestId}`} set ${name}=${value.slice(0, 12)}… after the device login set ${loginSid.slice(0, 12)}…`);
        }
      }
    });

    const onResponse = async (response: HTTPResponse) => {
      const it = current;
      const url = response.url();
      if (!it || !url.startsWith(`${t.origin}/api/`)) {
        return;
      }
      if (url.includes('/api/v2/User/login')) {
        it.deviceLogins++;
      }
      try {
        const body = JSON.parse(await response.text()) as { status?: string; error?: string };
        if (body.status === 'ERROR') {
          const entry = `${body.error} ${new URL(url).pathname}`;
          (body.error === 'LOGIN_REQUIRED' ? it.loginRequired : it.otherApiErrors).push(entry);
        }
      }
      catch {
        // no body (navigation abort)
      }
    };
    page.on('response', onResponse);

    const reloads = ['reload', 'hard-reload-bypass-sw', 'navigate'] as const;
    // --reload-modes and E2E_REDIS_URL are validated by parseArgs
    const modes = (t.config.reloadModes.length ? t.config.reloadModes : [...RELOAD_MODES])
      .filter(m => m !== 'session-expired' || !!t.config.redisUrl);
    t.note(`reload modes: ${modes.join(', ')}`);
    /** makes the server forget (session-expired) or the browser drop (cookie-cleared) the session */
    const expireSession = async (mode: Mode, it: Iteration) => {
      const cookies = await page.cookies(t.origin);
      // the cookie the device login sets (learned from its Set-Cookie)
      const cookie = cookies.find(c => c.name === (sessionCookie ?? 'connect.sid'));
      if (!cookie) {
        it.actions.push('no session cookie to expire');
        return;
      }
      if (mode === 'cookie-cleared') {
        await page.deleteCookie({ name: cookie.name, url: t.origin });
        it.actions.push('session cookie cleared');
        return;
      }
      const sid = sessionIdFromCookie(cookie.value);
      assert(sid, `cannot read the session id from the ${cookie.name} cookie`);
      const [deleted] = await valkeyCommands(t.config.redisUrl!, [['DEL', `sess:${sid}`]]);
      // ":1" — the key existed and is gone; anything else means the mode did not do what it says
      assert(deleted === ':1', `DEL sess:<id> answered ${deleted}, expected :1 (the session was not in the store)`);
      it.actions.push('session deleted server-side');
    };
    await t.step(`${t.config.reloadIterations} reloads with immediate actions`, async () => {
      for (let i = 0; i < t.config.reloadIterations; i++) {
        const it: Iteration = {
          i,
          mode: modes[i % modes.length],
          reload: modes[i % modes.length] === 'force-reload-cold-sw' ? 'cold-sw-reload' : reloads[Math.floor(i / modes.length) % 3],
          deviceLogins: 0,
          heldResponses: 0,
          loginRequired: [],
          otherApiErrors: [],
          indicatorStates: [],
          finalState: '',
          actions: [],
          failures: [],
          cookieRegressions: [],
          ms: 0,
        };
        const issuesBefore = t.issueCount();
        const started = Date.now();
        current = it;
        loginSid = undefined;
        loginInFlight = false;
        loginDelivered = false;
        sentDuringLogin.clear();
        reorder = it.mode === 'reordered';
        try {
          // a failed iteration may have left the page elsewhere (or broken):
          // every iteration starts from the channel
          if (new URL(page.url()).pathname !== account.channel) {
            await page.goto(t.url(account.channel), { waitUntil: 'domcontentloaded' });
            await waitAppReady(page);
            it.actions.push('back to the channel first');
          }
          if (it.mode === 'cookie-cleared' || it.mode === 'session-expired') {
            await expireSession(it.mode, it);
          }
          if (it.mode === 'interrupted') {
            // load once, and reload again the moment its device login is sent
            const loginRequest = page.waitForRequest(request => request.url().includes('/api/v2/User/login'), { timeout: 20_000 });
            await page.reload({ waitUntil: 'domcontentloaded' });
            await loginRequest;
            it.actions.push(`interrupted a device login@${Date.now() - started}ms`);
            loginInFlight = false;
            sentDuringLogin.clear();
          }
          if (it.reload === 'cold-sw-reload') {
            const workers = await coldServiceWorkerReload(page, s.cdp);
            it.actions.push(`stopped ${workers.versions} service worker version(s) (${workers.running.join(',') || '-'})`);
          }
          else if (it.reload === 'reload') {
            await page.reload({ waitUntil: 'domcontentloaded' });
          }
          else if (it.reload === 'hard-reload-bypass-sw') {
            await page.setBypassServiceWorker(true);
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
              s.cdp.send('Page.reload', { ignoreCache: true }),
            ]);
          }
          else {
            await page.goto(t.url(account.channel), { waitUntil: 'domcontentloaded' });
          }

          // act as soon as the UI lets us, without waiting for the device login
          await waitAppReady(page, { settleLogin: false });
          const editor = await page.waitForSelector(EDITOR, { visible: true, timeout: 30_000 });
          const text = `reload ${i} ${t.unique('m')}`;
          await editor!.click();
          await page.keyboard.type(text, { delay: 1 });
          await page.keyboard.press('Enter');
          it.actions.push(`send@${Date.now() - started}ms${loginDelivered ? '' : ' (device login still out)'}`);
          await openUserMenu(page);
          it.actions.push(`settings@${Date.now() - started}ms`);
          await closeUserMenu(page);
          await waitMessageConfirmed(page, text, 10_000).catch(() => {
            it.failures.push('the sent message was not confirmed by the server within 10 s');
          });
          if (i % 7 === 3) {
            await navigate(t, page, '/');
            await createCommunity(t, page);
            it.actions.push(`create-community@${Date.now() - started}ms`);
            await navigate(t, page, account.channel);
          }

          // settle: the indicator must end up connected (or hidden again;
          // with a cold service worker only connected counts)
          const settled = it.mode === 'force-reload-cold-sw' ? ['connected'] : ['connected', 'hidden'];
          it.finalState = await until('the connection to settle', async () => {
            const state = await connectionState(page);
            return settled.includes(state) ? state : null;
          }, SETTLE_MS).catch(async () => {
            const state = await connectionState(page);
            it.failures.push(`connection indicator still "${state}" ${SETTLE_MS / 1000}s after the reload`);
            return state;
          });
          await sleep(300);
        }
        catch (e) {
          it.failures.push(`action failed: ${(e as Error).message.split('\n')[0]}`);
          await page.screenshot({ path: `${t.outDir}/reload-iteration-${i}.png` }).catch(() => undefined);
        }
        finally {
          reorder = false;
          releaseAll();
          await page.setBypassServiceWorker(false).catch(() => undefined);
        }
        it.indicatorStates = await page.evaluate(() => (window as unknown as { __e2eIndicator?: string[] }).__e2eIndicator ?? []).catch(() => []);
        const shownBad = it.indicatorStates.filter(state => /:(offline|disconnected)$/.test(state));
        if (shownBad.length) {
          it.failures.push(`connection indicator showed ${shownBad.join(', ')}`);
        }
        if (it.mode === 'force-reload-cold-sw') {
          // "<ms since the load>ms:connected" must come within COLD_SW_CONNECT_MS
          const connectedAt = it.indicatorStates.map(state => /^(\d+)ms:connected/.exec(state)).find(Boolean);
          if (!connectedAt) {
            it.failures.push(`never connected after the cold service-worker reload (indicator: ${it.indicatorStates.join(' ') || '-'})`);
          }
          else if (Number(connectedAt[1]) > COLD_SW_CONNECT_MS) {
            it.failures.push(`connected only ${connectedAt[1]} ms after the cold service-worker reload (limit ${COLD_SW_CONNECT_MS} ms)`);
          }
        }
        if (it.loginRequired.length) {
          it.failures.push(`LOGIN_REQUIRED: ${it.loginRequired.join(', ')}`);
        }
        const newIssues = t.issueCount() - issuesBefore;
        if (newIssues > 0) {
          it.failures.push(`${newIssues} new guard issue(s)`);
        }
        it.ms = Date.now() - started;
        iterations.push(it);
        current = undefined;
        console.log(`      ${it.failures.length ? '✘' : '✔'} #${i} ${it.mode}/${it.reload} ${it.ms}ms logins=${it.deviceLogins}` +
          `${it.heldResponses ? ` held=${it.heldResponses}` : ''}` +
          `${it.cookieRegressions.length ? ` cookie-regressions=${it.cookieRegressions.length}` : ''}` +
          `${it.failures.length ? ` — ${it.failures.join('; ').slice(0, 400)}` : ''}`);
      }
    });
    page.off('response', onResponse);
    await s.cdp.send('Fetch.disable').catch(() => undefined);

    const failed = iterations.filter(it => it.failures.length);
    const byMode = (mode: Mode) => {
      const all = iterations.filter(it => it.mode === mode);
      return `${all.filter(it => it.failures.length).length}/${all.length}`;
    };
    const perMode = Object.fromEntries(modes.map(mode => [mode, byMode(mode)]));
    const perModeText = modes.map(mode => `${mode} ${perMode[mode]}`).join(', ');
    const rate = {
      total: `${failed.length}/${iterations.length}`,
      perMode,
      loginRequiredIterations: iterations.filter(it => it.loginRequired.length).length,
      messageLostIterations: iterations.filter(it => it.failures.some(f => f.includes('not confirmed'))).length,
      cookieRegressionIterations: iterations.filter(it => it.cookieRegressions.length).length,
      cookieRegressionsWithLoginRequired: iterations.filter(it => it.cookieRegressions.length && it.loginRequired.length).length,
      offlineOrDisconnectedShown: iterations.filter(it => it.indicatorStates.some(state => /:(offline|disconnected)$/.test(state))).length,
    };
    t.metric('reloadFailureRate', rate);
    t.metric('reloadIterations', iterations);
    t.note(`reload failures: ${rate.total} (${perModeText}); LOGIN_REQUIRED in ${rate.loginRequiredIterations}, ` +
      `message lost in ${rate.messageLostIterations}, cookie regressions in ${rate.cookieRegressionIterations}, offline/disconnected shown in ${rate.offlineOrDisconnectedShown}`);
    await t.step('no iteration failed', async () => {
      assert(failed.length === 0, `${rate.total} reload iterations failed (${perModeText}); first: #${failed[0]?.i} ${failed[0]?.failures.join('; ').slice(0, 300)}`);
    });
  },
};

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Browser, BrowserContext, CDPSession, Page, Target } from 'puppeteer';
import type { Config } from './config.ts';
import { allowlist } from '../allowlist.ts';

/**
 * The flow runner and the global guards (e2e/README.md).
 *
 * Every page a flow opens — through `t.session()`, and popups those pages
 * open — is watched for:
 *   pageerror       uncaught exceptions and unhandled rejections
 *   console-error   console.error / browser errors (incl. "App received an error")
 *   csp             Content-Security-Policy violations: the page's
 *                   `securitypolicyviolation` event, CDP Audits issues and the
 *                   browser's "Refused to ..." console messages
 *   api-error       an /api/ response `{ status: 'ERROR' }` the flow did not
 *                   declare as expected (t.expectApiErrors)
 *   http-5xx        a same-origin response with status >= 500
 *   request-failed  a same-origin request that failed below HTTP (not aborts)
 *   undefined-url   a same-origin request with an `undefined` or `null` path
 *                   segment — a URL built from a missing value (e.g. CSS
 *                   `url(undefined)`, resolved against the current path)
 *   error-screen    the React error boundary's "Error :'(" screen, checked
 *                   after every step
 * Anything not covered by src/allowlist.ts fails the flow; allowlisted
 * entries still go into the report.
 */

export type IssueKind = 'pageerror' | 'console-error' | 'csp' | 'api-error' | 'http-5xx' | 'request-failed' | 'undefined-url' | 'error-screen' | 'worker-error';

export type Issue = {
  kind: IssueKind;
  text: string;
  url?: string;
  session: string;
  step: string;
  at: string;
  /** allowlist reason, if allowed */
  allowed?: string;
  count: number;
};

export type StepResult = {
  name: string;
  /** 'running' until the step ends (stays so when the flow timed out inside it) */
  status: 'running' | 'pass' | 'fail' | 'skip';
  durationMs: number;
  error?: string;
  screenshots: string[];
};

export type FlowResult = {
  id: string;
  title: string;
  status: 'pass' | 'fail' | 'skip';
  durationMs: number;
  error?: string;
  skipReason?: string;
  steps: StepResult[];
  issues: Issue[];
  allowed: Issue[];
  expectedApiErrors: { code: string; url: string; session: string; step: string }[];
  notes: string[];
  metrics: Record<string, unknown>;
};

export type Flow = {
  id: string;
  title: string;
  run: (t: FlowContext) => Promise<void>;
  /** overrides --flow-timeout (e.g. when the flow's length depends on an option) */
  timeoutMs?: (config: Config) => number;
};

export class SkipFlow extends Error {}

/** a guard finding a flow provokes on purpose (t.expectFailures) */
export type ExpectedFailure = {
  /** the session's name; its tabs (`<name>/<tab>`) are included */
  session: string;
  kinds: IssueKind[];
  text: RegExp;
  /** why it is expected, e.g. "member offline" */
  reason: string;
};

export type SessionOptions = {
  colorScheme?: 'light' | 'dark';
  /** attach a CDP virtual WebAuthn authenticator to the page */
  authenticator?: boolean;
  viewport?: { width: number; height: number };
};

export type TabOptions = {
  /**
   * open the tab in a window of its own instead of next to the session's
   * other tabs: every window shows its front tab, so two windows are two
   * visible tabs side by side (split view). Tabs of one window take turns:
   * only the front tab is visible (`document.visibilityState`), the others
   * are hidden for real — also with the background-throttling flags of
   * src/main.ts, which only keep their timers running at full speed.
   */
  window?: boolean;
};

export class Session {
  name: string;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  authenticatorId?: string;
  /** further tabs of the same browser context (same user, cookies, storage, service worker): t.tab() */
  tabs: Session[] = [];
  /** the session a tab belongs to (undefined for a session's first page) */
  parent?: Session;
  constructor(name: string, context: BrowserContext, page: Page, cdp: CDPSession) {
    this.name = name;
    this.context = context;
    this.page = page;
    this.cdp = cdp;
  }
}

/**
 * Every page load of a logged-in app runs a device-key login (User/login)
 * that regenerates the session id. Flows other than the reload flow wait for
 * it to finish before they act (waitAppReady), so their own steps are not
 * hit by that race — the reload flow provokes it on purpose.
 */
type LoginTracker = { inFlight: number; lastDoneAt: number; loginsSinceLoad: number };
const loginTrackers = new WeakMap<Page, LoginTracker>();

function trackDeviceLogins(page: Page) {
  const tracker: LoginTracker = { inFlight: 0, lastDoneAt: 0, loginsSinceLoad: 0 };
  loginTrackers.set(page, tracker);
  // the device login, an interactive login, or a sign-up (which logs in)
  const isLogin = (url: string) => /\/api\/v2\/User\/(login|createUser)\b/.test(url);
  page.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      // a page load: whatever was in flight is abandoned, a new device login follows
      tracker.inFlight = 0;
      tracker.loginsSinceLoad = 0;
    }
    else if (isLogin(request.url())) {
      tracker.inFlight++;
      tracker.loginsSinceLoad++;
    }
  });
  const done = (url: string) => {
    if (isLogin(url)) {
      tracker.inFlight = Math.max(0, tracker.inFlight - 1);
      tracker.lastDoneAt = Date.now();
    }
  };
  page.on('requestfinished', request => done(request.url()));
  page.on('requestfailed', request => done(request.url()));
}

/**
 * Resolves once the device login of the current page load is done: when the
 * app has a stored user (CG_CURRENT_USER) and no login started since the load
 * yet, it waits for it to start first; then until none is in flight and none
 * finished within `quietMs`. An anonymous app has no device login to wait for.
 */
export async function waitLoginSettled(page: Page, quietMs = 1000, timeout = 20_000, options: { optionalLogin?: boolean } = {}) {
  const tracker = loginTrackers.get(page);
  if (!tracker) {
    return;
  }
  const started = Date.now();
  const hasStoredUser = () => page.evaluate(() => {
    const raw = localStorage.getItem('CG_CURRENT_USER');
    return !!raw && raw !== 'null';
  }).catch(() => false);
  while (tracker.loginsSinceLoad === 0 && await hasStoredUser()) {
    if (options.optionalLogin && Date.now() - started > 5_000) {
      // a further tab of a logged-in browser may take its login state from
      // another tab instead of logging in itself (t.tab)
      return;
    }
    if (Date.now() - started > timeout) {
      throw new Error(`no device login started within ${timeout} ms of the page load although the app has a stored user`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  while (tracker.inFlight > 0 || Date.now() - tracker.lastDoneAt < quietMs) {
    if (Date.now() - started > timeout) {
      throw new Error(`device login still in flight after ${timeout} ms`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

const ERROR_SCREEN_TEXT = "Error :'(";

export class FlowContext {
  readonly config: Config;
  readonly browser: Browser;
  readonly flowId: string;
  readonly outDir: string;
  readonly origin: string;
  readonly result: FlowResult;
  readonly sessions: Session[] = [];
  currentStep = '(setup)';
  /** contexts in which t.tab() is opening a page (it guards that page itself, not as a popup) */
  private openingTabs = new Map<BrowserContext, number>();
  private sessionOptions = new WeakMap<Session, SessionOptions>();
  private expectedFailures: ExpectedFailure[] = [];
  private issueIndex = new Map<string, Issue>();
  private expected: string[][] = [];
  private closed = false;

  constructor(config: Config, browser: Browser, flow: Flow, outDir: string) {
    this.config = config;
    this.browser = browser;
    this.flowId = flow.id;
    this.outDir = outDir;
    this.origin = new URL(config.baseUrl).origin;
    this.result = {
      id: flow.id,
      title: flow.title,
      status: 'pass',
      durationMs: 0,
      steps: [],
      issues: [],
      allowed: [],
      expectedApiErrors: [],
      notes: [],
      metrics: {},
    };
    mkdirSync(outDir, { recursive: true });
  }

  url(path = '/') {
    return `${this.config.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  /** a name that is unique per run: 3-30 chars of [a-z0-9_], as display names allow */
  unique(prefix: string) {
    const suffix = `${Date.now().toString(36).slice(-5)}${randomBytes(3).toString('hex')}`;
    return `${prefix.replace(/[^a-z0-9_]/gi, '').slice(0, 30 - suffix.length - 1)}_${suffix}`.toLowerCase();
  }

  note(message: string) {
    this.result.notes.push(message);
    console.log(`      · ${message}`);
  }

  metric(name: string, value: unknown) {
    this.result.metrics[name] = value;
  }

  skip(reason: string): never {
    throw new SkipFlow(reason);
  }

  /** a fresh browser context (own cookies, storage, service worker) with one guarded page */
  async session(name: string, options: SessionOptions = {}): Promise<Session> {
    this.assertOpen();
    const context = await this.browser.createBrowserContext();
    // what a user would allow once (a headless page is denied the screen
    // wake lock a call requests otherwise). Camera/microphone are answered by
    // the fake-media flags; notifications stay at "ask", so the onboarding
    // looks like for a first-time visitor.
    const browserCdp = await this.browser.target().createCDPSession();
    await browserCdp.send('Browser.grantPermissions', {
      origin: this.origin,
      browserContextId: context.id,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite', 'wakeLockScreen'],
    }).catch(e => console.log(`      (could not grant permissions: ${(e as Error).message})`));
    await browserCdp.detach().catch(() => undefined);
    const page = await context.newPage();
    const session = new Session(name, context, page, await page.createCDPSession());
    this.sessions.push(session);
    this.sessionOptions.set(session, options);
    await this.setupPage(session, options);
    // the disposable instance's edge maps this cookie to the client address
    // the backend's per-address limits see (e2e/Caddyfile.e2e); a real
    // instance ignores it
    const clientIp = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0] % 254)}`;
    await page.setCookie({ name: 'cg_e2e_client', value: clientIp, url: this.origin, secure: true, sameSite: 'Strict' });
    context.on('targetcreated', (target: Target) => this.onTarget(target, session));
    if (options.authenticator) {
      await session.cdp.send('WebAuthn.enable', { enableUI: false });
      const { authenticatorId } = await session.cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      session.authenticatorId = authenticatorId;
    }
    return session;
  }

  /** viewport, colour scheme, timeouts, guards and device-login tracking of a session's page or tab */
  private async setupPage(session: Session, options: SessionOptions) {
    const page = session.page;
    await page.setViewport(options.viewport ?? { width: 1366, height: 900 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: options.colorScheme ?? 'light' }]);
    page.setDefaultTimeout(20_000);
    page.setDefaultNavigationTimeout(45_000);
    await this.guardPage(page, session.cdp, session.name);
    trackDeviceLogins(page);
  }

  /**
   * Another tab of `session`: a second page in the same browser context, so
   * the same user with the same cookies, storage and service worker — what a
   * person gets with "open in new tab". Guarded and login-tracked like the
   * session's first page (issues are attributed to `<session>/<name>`), with
   * the same viewport and colour scheme; screenshots cover it (they take
   * every page of the context). It starts on about:blank: load the app with
   * openTab() (lib/tabs.ts).
   * A tab opens in front of the session's other tabs of that window (they
   * become hidden); `window: true` opens it in a window of its own instead
   * (both visible). showTab() (lib/tabs.ts) switches tabs.
   */
  async tab(session: Session, name: string, options: TabOptions = {}): Promise<Session> {
    this.assertOpen();
    const root = session.parent ?? session;
    const context = root.context;
    this.openingTabs.set(context, (this.openingTabs.get(context) ?? 0) + 1);
    let page: Page;
    try {
      page = await context.newPage(options.window ? { type: 'window' } : undefined);
    }
    finally {
      this.openingTabs.set(context, (this.openingTabs.get(context) ?? 1) - 1);
    }
    const tab = new Session(`${root.name}/${name}`, context, page, await page.createCDPSession());
    tab.parent = root;
    root.tabs.push(tab);
    await this.setupPage(tab, this.sessionOptions.get(root) ?? {});
    return tab;
  }

  private async onTarget(target: Target, session: Session) {
    try {
      if (target.type() === 'page') {
        if ((this.openingTabs.get(session.context) ?? 0) > 0) {
          return; // a tab t.tab() is opening: it sets up its own guards
        }
        const page = await target.page();
        const known = page === session.page || session.tabs.some(tab => tab.page === page);
        if (page && !known) {
          await this.guardPage(page, await page.createCDPSession(), `${session.name}/popup`);
        }
      }
      else if (target.type() === 'service_worker' || target.type() === 'shared_worker') {
        const worker = await target.worker();
        if (worker) {
          worker.on('console', msg => {
            if (msg.type() === 'error') {
              this.record('worker-error', msg.text(), session.name, target.url());
            }
          });
          worker.on('error', (err: Error) => this.record('worker-error', err.message, session.name, target.url()));
        }
      }
    }
    catch {
      // the target went away before it could be attached
    }
  }

  private async guardPage(page: Page, cdp: CDPSession, sessionName: string) {
    page.on('pageerror', (err: unknown) => {
      const e = err as Error;
      this.record('pageerror', `${e?.message ?? String(err)}${e?.stack ? `\n${e.stack.split('\n').slice(1, 6).join('\n')}` : ''}`, sessionName, page.url());
    });
    page.on('console', msg => {
      if (msg.type() !== 'error') {
        return;
      }
      const text = msg.text();
      const url = msg.location()?.url;
      const kind: IssueKind = /Content Security Policy|Content-Security-Policy/i.test(text) ? 'csp' : 'console-error';
      this.record(kind, text, sessionName, url);
    });
    page.on('response', async response => {
      const url = response.url();
      if (!url.startsWith(this.origin)) {
        return;
      }
      if (response.status() >= 500) {
        this.record('http-5xx', `HTTP ${response.status()} ${response.request().method()} ${url}`, sessionName, url);
        return;
      }
      if (!new URL(url).pathname.startsWith('/api/')) {
        return;
      }
      const type = response.headers()['content-type'] ?? '';
      if (!type.includes('json')) {
        return;
      }
      let body: { status?: string; error?: string } | undefined;
      try {
        body = JSON.parse(await response.text());
      }
      catch {
        return; // body unavailable (navigation, redirect) or not JSON
      }
      if (body?.status === 'ERROR') {
        const code = String(body.error ?? 'UNKNOWN');
        if (this.expected.some(codes => codes.includes(code) || codes.includes('*'))) {
          this.result.expectedApiErrors.push({ code, url, session: sessionName, step: this.currentStep });
        }
        else {
          this.record('api-error', `${code} from ${response.request().method()} ${new URL(url).pathname}`, sessionName, url);
        }
      }
    });
    page.on('request', request => {
      const url = request.url();
      if (url.startsWith(this.origin) && new URL(url).pathname.split('/').some(segment => segment === 'undefined' || segment === 'null')) {
        this.record('undefined-url', `${request.resourceType()} request ${request.method()} ${url}`, sessionName, url);
      }
    });
    page.on('requestfailed', request => {
      const url = request.url();
      const failure = request.failure()?.errorText ?? '';
      if (!url.startsWith(this.origin) || failure === 'net::ERR_ABORTED') {
        return;
      }
      this.record('request-failed', `${failure} ${request.method()} ${url}`, sessionName, url);
    });
    // CSP: the DOM event (reported by every frame of the page) ...
    await page.exposeFunction('__e2eReportCsp', (json: string) => {
      const v = JSON.parse(json) as { directive: string; blocked: string; source: string; doc: string };
      this.record('csp', `CSP ${v.directive} blocked ${v.blocked || '(inline)'}${v.source ? ` at ${v.source}` : ''}`, sessionName, v.doc);
    });
    await page.evaluateOnNewDocument(() => {
      document.addEventListener('securitypolicyviolation', ev => {
        const report = (window as unknown as { __e2eReportCsp?: (json: string) => void }).__e2eReportCsp;
        report?.(JSON.stringify({
          directive: ev.effectiveDirective || ev.violatedDirective,
          blocked: ev.blockedURI,
          source: ev.sourceFile ? `${ev.sourceFile}:${ev.lineNumber}` : '',
          doc: ev.documentURI,
        }));
      });
    });
    // ... and CDP's issue reporting, which also sees workers and report-only
    await cdp.send('Audits.enable').catch(() => undefined);
    cdp.on('Audits.issueAdded', ({ issue }) => {
      if (issue.code !== 'ContentSecurityPolicyIssue') {
        return;
      }
      const d = issue.details.contentSecurityPolicyIssueDetails;
      if (!d) {
        return;
      }
      this.record('csp', `CSP ${d.violatedDirective} blocked ${d.blockedURL || '(inline)'} [${d.contentSecurityPolicyViolationType}${d.isReportOnly ? ', report-only' : ''}]`, sessionName, d.sourceCodeLocation?.url ?? page.url());
    });
  }

  /** record a guard finding (deduplicated per session+kind+text) */
  record(kind: IssueKind, text: string, session: string, url?: string) {
    if (this.closed) {
      return;
    }
    const expected = this.expectedFailures.find(entry =>
      (session === entry.session || session.startsWith(`${entry.session}/`)) && entry.kinds.includes(kind) && entry.text.test(text));
    const key = `${session}\u0000${kind}\u0000${text}${expected ? '\u0000expected' : ''}`;
    const existing = this.issueIndex.get(key);
    if (existing) {
      existing.count++;
      return;
    }
    const issue: Issue = { kind, text: text.slice(0, 4000), url, session, step: this.currentStep, at: new Date().toISOString(), count: 1 };
    if (expected) {
      this.issueIndex.set(key, issue);
      issue.allowed = `expected while ${expected.reason}`;
      this.result.allowed.push(issue);
      return;
    }
    const allow = allowlist.find(entry => {
      const kinds = Array.isArray(entry.kind) ? entry.kind : [entry.kind];
      if (!kinds.includes(kind) || (entry.text && !entry.text.test(text))) {
        return false;
      }
      if (entry.url && !(url && entry.url.test(url))) {
        return false;
      }
      return true;
    });
    this.issueIndex.set(key, issue);
    if (allow) {
      issue.allowed = allow.reason;
      this.result.allowed.push(issue);
    }
    else {
      this.result.issues.push(issue);
      console.log(`      ! ${kind} [${session}] ${text.split('\n')[0].slice(0, 300)}`);
    }
  }

  /**
   * Failures a flow provokes on purpose (a page taken offline, a frozen tab
   * whose socket the browser closes): while `fn` runs, and `graceMs` after
   * it, guard findings of these kinds whose text matches, on that session
   * (or its tabs), go into `allowed` with the reason instead of failing the
   * flow. Keep the patterns as narrow as the provoked failure (lib/cdp.ts
   * has the ones for "offline" and "frozen").
   */
  async expectFailures<T>(entries: ExpectedFailure[], fn: () => Promise<T>, graceMs = 2_000): Promise<T> {
    this.expectedFailures.push(...entries);
    try {
      return await fn();
    }
    finally {
      await new Promise(resolve => setTimeout(resolve, graceMs));
      for (const entry of entries) {
        this.expectedFailures.splice(this.expectedFailures.indexOf(entry), 1);
      }
    }
  }

  /** API errors with these codes are expected while `fn` runs ('*' = any) */
  async expectApiErrors<T>(codes: string[], fn: () => Promise<T>): Promise<T> {
    this.expected.push(codes);
    try {
      return await fn();
    }
    finally {
      // late responses of the action still count as expected for a moment
      await new Promise(resolve => setTimeout(resolve, 300));
      this.expected.splice(this.expected.indexOf(codes), 1);
    }
  }

  /** guard issues recorded so far (not allowlisted) */
  issueCount(filter?: (issue: Issue) => boolean) {
    return filter ? this.result.issues.filter(filter).length : this.result.issues.length;
  }

  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const started = Date.now();
    this.currentStep = name;
    const step: StepResult = { name, status: 'running', durationMs: 0, screenshots: [] };
    this.result.steps.push(step);
    console.log(`    - ${name}`);
    try {
      const value = await fn();
      this.assertOpen();
      await this.checkErrorScreens();
      if (this.config.screenshotSteps) {
        step.screenshots = await this.screenshots(name);
      }
      step.status = 'pass';
      return value;
    }
    catch (e) {
      if (e instanceof SkipFlow) {
        step.status = 'skip';
        step.error = e.message;
        throw e;
      }
      step.status = 'fail';
      step.error = e instanceof Error ? e.message : String(e);
      // where in the suite it happened (the first frames in e2e/src)
      const where = e instanceof Error ? (e.stack ?? '').split('\n').filter(line => line.includes('/e2e/src/')).slice(0, 3).map(line => line.trim().replace(/^at /, '').replace(/file:\/\/\/dist\/e2e\//, '')) : [];
      if (where.length) {
        step.error += `\n  at ${where.join('\n  at ')}`;
      }
      if (!this.closed) {
        await this.checkErrorScreens();
        step.screenshots = await this.screenshots(`FAIL-${name}`);
        console.log(`      x ${step.error.split('\n')[0]}`);
      }
      throw e;
    }
    finally {
      step.durationMs = Date.now() - started;
    }
  }

  /** a flow that timed out keeps running in the background: stop it at its next step or session */
  private assertOpen() {
    if (this.closed) {
      throw new Error('the flow was closed (timed out)');
    }
  }

  /** the React error boundary's screen on any open page */
  async checkErrorScreens() {
    for (const session of this.sessions) {
      for (const page of await session.context.pages()) {
        const shown = await page.evaluate((marker: string) => {
          // the boundary (src/index.tsx) writes into the static preview
          // shell of index.html
          return document.getElementById('cg-preview-status')?.textContent?.trim() === marker;
        }, ERROR_SCREEN_TEXT).catch(() => false);
        if (shown) {
          this.record('error-screen', `React error boundary screen ("${ERROR_SCREEN_TEXT}") on ${page.url()}`, session.name, page.url());
        }
      }
    }
  }

  async screenshots(label: string): Promise<string[]> {
    const files: string[] = [];
    const safe = label.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 80);
    for (const session of this.sessions) {
      const pages = await session.context.pages().catch(() => [] as Page[]);
      for (const [i, page] of pages.entries()) {
        const file = `${this.outDir}/${String(this.result.steps.length).padStart(2, '0')}-${safe}-${session.name}${i ? `-${i}` : ''}.png`;
        try {
          await page.screenshot({ path: file as `${string}.png` });
          files.push(file);
        }
        catch {
          // page closed or crashed
        }
      }
    }
    return files;
  }

  async close() {
    await this.checkErrorScreens().catch(() => undefined);
    this.closed = true;
    for (const session of this.sessions) {
      await session.context.close().catch(() => undefined);
    }
  }
}

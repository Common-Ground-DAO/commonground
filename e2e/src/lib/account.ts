// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { ElementHandle, Page } from 'puppeteer';
import type { FlowContext, Session } from './harness.ts';
import { waitForCode } from './mailpit.ts';
import { clickText, fill, hasText, sleep, until, waitText } from './ui.ts';

/**
 * Accounts through the real UI: sign-up (/login?mode=signup), login, logout.
 * Every flow that needs a user creates its own with a unique name, so flows
 * never share state.
 */

export type Account = {
  name: string;
  email: string;
  password?: string;
  method: 'password' | 'passkey';
  userId?: string;
};

export type InstanceInfo = {
  deployment?: string;
  features?: { email?: boolean; calls?: boolean; passkeys?: boolean; imageFilter?: boolean };
  captchaProvider?: string;
  walletConnectProjectId?: string;
};

export async function instanceInfo(page: Page): Promise<InstanceInfo> {
  return page.evaluate(() => (window as unknown as { __CG_INSTANCE__?: InstanceInfo }).__CG_INSTANCE__ ?? {});
}

/** solves the ALTCHA widget on the page (proof of work runs in the browser) */
export async function solveAltcha(page: Page) {
  const box = await page.waitForSelector('altcha-widget >>> input[type=checkbox]', { visible: true, timeout: 15_000 });
  await box!.click();
  await page.waitForFunction(() => {
    const input = document.querySelector('altcha-widget input[name=altcha]') as HTMLInputElement | null;
    return !!input?.value;
  }, { timeout: 60_000, polling: 250 });
}

async function solveCaptchaIfShown(page: Page) {
  if (await page.$('altcha-widget')) {
    await solveAltcha(page);
  }
  else if (await page.$('iframe[src*="recaptcha"]')) {
    throw new Error('this instance uses reCAPTCHA, which an automated browser cannot solve');
  }
}

/**
 * Signs up a new account. With mail enabled the sign-up verifies the email
 * address first; the code is read from Mailpit (`--mailpit`), without it the
 * flow is skipped.
 */
export async function signUp(t: FlowContext, session: Session, method: 'password' | 'passkey' = 'password', prefix = 'e2e'): Promise<Account> {
  const page = session.page;
  const name = t.unique(prefix);
  const email = `${name}@example.org`;
  const password = method === 'password' ? `pw-${name}-Correct-Horse` : undefined;

  await page.goto(t.url('/login?mode=signup'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name=displayName]', { visible: true });
  const info = await instanceInfo(page);
  const mailCode = !!info.features?.email;
  if (mailCode && !t.config.mailpitUrl) {
    t.skip('the instance verifies sign-up emails and no --mailpit URL was given to read the code');
  }
  if (method === 'passkey' && !session.authenticatorId) {
    throw new Error('passkey sign-up needs a session with { authenticator: true }');
  }

  await fill(page, 'input[name=displayName]', name);
  await fill(page, 'input[name=email]', email);
  if (mailCode) {
    await solveAltcha(page);
  }
  const since = Date.now();
  await clickText(page, 'Continue');
  if (mailCode) {
    await waitText(page, 'Check your email');
    const code = await waitForCode(t.config.mailpitUrl!, email, since);
    await fill(page, 'input[name=code]', code);
    await clickText(page, 'Confirm email');
  }
  await waitText(page, 'How will you sign in?');
  if (method === 'password') {
    await clickText(page, 'Use a password');
    await waitText(page, 'Choose a password');
    await fill(page, 'input[name=password]', password!);
    await solveCaptchaIfShown(page);
    await clickText(page, 'Create account');
  }
  else {
    await solveCaptchaIfShown(page);
    await clickText(page, 'Create a passkey');
  }
  const userId = await waitLoggedIn(page, 30_000);
  // with mail, the newsletter offer follows the sign-up
  await dismissOnboarding(page, mailCode ? 12_000 : 3_000);
  return { name, email, password, method, userId };
}

/** the logged-in user id from the app's local state, once the login is done */
export async function waitLoggedIn(page: Page, timeout = 20_000): Promise<string> {
  return until('the app to be logged in', async () => page.evaluate(() => {
    const raw = localStorage.getItem('CG_CURRENT_USER');
    const user = raw ? JSON.parse(raw) as { userId?: string } | null : null;
    return user?.userId ?? null;
  }), timeout);
}

/**
 * Walks through the post-sign-up onboarding modal (the newsletter offer:
 * "Not now", then the welcome step: "Start exploring"), if it is shown.
 */
export async function dismissOnboarding(page: Page, waitMs = 6_000) {
  const deadline = Date.now() + waitMs;
  let handled = false;
  let lastHandledAt = 0;
  while (Date.now() < deadline) {
    const offer = await hasText(page, 'Turn on newsletters') ? 'Turn on newsletters'
      : await hasText(page, 'Turn on Push Notifications') ? 'Turn on Push Notifications' : null;
    if (offer) {
      // the modal's own "Not now" (the push banner behind it has one, too)
      const handle = await page.evaluateHandle((label: string) => {
        const turnOn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === label);
        let el: HTMLElement | null | undefined = turnOn?.parentElement;
        while (el && !Array.from(el.querySelectorAll('button')).some(b => b.innerText.trim() === 'Not now')) {
          el = el.parentElement;
        }
        return Array.from(el?.querySelectorAll('button') ?? []).find(b => b.innerText.trim() === 'Not now') ?? null;
      }, offer);
      const button = handle.asElement() as ElementHandle<Element> | null;
      if (button) {
        await button.click();
        handled = true;
        lastHandledAt = Date.now();
        await sleep(500);
        continue;
      }
    }
    if (await hasText(page, 'Start exploring')) {
      await clickText(page, 'Start exploring', { timeout: 3_000 }).catch(() => undefined);
      handled = true;
      lastHandledAt = Date.now();
      await sleep(500);
      continue;
    }
    // the next step of the modal can take a moment to appear
    if (handled && Date.now() - lastHandledAt > 2_500) {
      break;
    }
    await sleep(300);
  }
}

export async function loginWithPassword(t: FlowContext, page: Page, identifier: string, password: string) {
  await page.goto(t.url('/login'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name=username]', { visible: true });
  await fill(page, 'input[name=username]', identifier);
  await fill(page, 'input[type=password]', password);
  await clickText(page, 'Log in', { selector: 'form button' });
}

/**
 * After a password login the flow may first try to add a passkey quietly
 * (up to 8 s), then offer it once ("Sign in faster next time"): answers
 * "Not now", or returns when the login page was left without the offer.
 */
export async function skipPasskeyOffer(page: Page, timeout = 20_000) {
  const outcome = await until('the login to finish (or the passkey offer)', async () => {
    if (await hasText(page, 'Sign in faster next time')) {
      return 'offer';
    }
    return new URL(page.url()).pathname.startsWith('/login') ? null : 'left';
  }, timeout);
  if (outcome === 'offer') {
    await clickText(page, 'Not now', { selector: 'button' });
  }
}

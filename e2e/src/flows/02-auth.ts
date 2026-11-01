// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { Flow } from '../lib/harness.ts';
import { loginWithPassword, signUp, skipPasskeyOffer, waitLoggedIn } from '../lib/account.ts';
import { logout, waitAppReady } from '../lib/app.ts';
import { assert, clickText, waitText } from '../lib/ui.ts';

const WRONG_CREDENTIALS = "That email, username or password isn't right.";
const INVALID_IDENTIFIER = "Usernames have 3-30 letters, numbers, - and _.";

/**
 * Sign-up, logout and login with a password (ALTCHA + the mailed code) and
 * with a passkey (CDP virtual authenticator), plus the wrong-password message
 * and an input error caught in the form.
 */
export const auth: Flow = {
  id: 'auth',
  title: 'Sign-up/login/logout with password and passkey, wrong password',
  async run(t) {
    // --- password
    const pw = await t.session('password');
    const account = await t.step('sign up with a password', async () => {
      const a = await signUp(t, pw, 'password', 'pwuser');
      await waitAppReady(pw.page);
      await pw.page.waitForSelector('#user-settings-root .user-widget-content', { visible: true });
      return a;
    });
    await t.step('log out', () => logout(t, pw.page));
    await t.step('an identifier that is neither an email nor a username is caught in the form', async () => {
      // nothing reaches the server: a VALIDATION answer would fail the guards
      await loginWithPassword(t, pw.page, 'not an email', 'whatever');
      await waitText(pw.page, INVALID_IDENTIFIER);
    });
    await t.step('wrong password is refused with a message', async () => {
      await t.expectApiErrors(['NOT_ALLOWED', 'NOT_FOUND'], async () => {
        await loginWithPassword(t, pw.page, account.email, `${account.password}-wrong`);
        await waitText(pw.page, WRONG_CREDENTIALS);
      });
      const user = await pw.page.evaluate(() => localStorage.getItem('CG_CURRENT_USER'));
      assert(!user || user === 'null', 'a wrong password logged in');
    });
    await t.step('log in with email + password', async () => {
      await loginWithPassword(t, pw.page, account.email, account.password!);
      // the one-time "add a passkey" offer after a password login
      await skipPasskeyOffer(pw.page);
      const userId = await waitLoggedIn(pw.page);
      assert(userId === account.userId, `logged in as ${userId}, expected ${account.userId}`);
      await waitAppReady(pw.page);
      await pw.page.waitForSelector('#user-settings-root .user-widget-content', { visible: true });
    });
    await t.step('log out and log in with the username', async () => {
      await logout(t, pw.page);
      await loginWithPassword(t, pw.page, account.name, account.password!);
      await skipPasskeyOffer(pw.page);
      assert(await waitLoggedIn(pw.page) === account.userId, 'username login ended up as another user');
    });

    // --- passkey
    const pk = await t.session('passkey', { authenticator: true });
    const pkAccount = await t.step('sign up with a passkey', async () => {
      const a = await signUp(t, pk, 'passkey', 'pkuser');
      const { credentials } = await pk.cdp.send('WebAuthn.getCredentials', { authenticatorId: pk.authenticatorId! });
      assert(credentials.length === 1, `virtual authenticator holds ${credentials.length} credentials after sign-up`);
      assert(credentials[0].isResidentCredential, 'the sign-up passkey is not a discoverable credential');
      return a;
    });
    await t.step('log out', () => logout(t, pk.page));
    await t.step('log in with the passkey', async () => {
      await pk.page.goto(t.url('/login'), { waitUntil: 'domcontentloaded' });
      await waitAppReady(pk.page);
      await clickText(pk.page, 'Sign in with a passkey', { selector: 'button' });
      const userId = await waitLoggedIn(pk.page, 30_000);
      assert(userId === pkAccount.userId, `passkey login: ${userId}, expected ${pkAccount.userId}`);
      await waitAppReady(pk.page);
      await pk.page.waitForSelector('#user-settings-root .user-widget-content', { visible: true });
    });
  },
};

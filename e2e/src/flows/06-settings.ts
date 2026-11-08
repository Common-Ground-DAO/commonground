// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { Page } from 'puppeteer';
import type { Flow, FlowContext, Session } from '../lib/harness.ts';
import { signUp, type Account } from '../lib/account.ts';
import { closeUserMenu, openUserMenu, waitAppReady } from '../lib/app.ts';
import { assert, clickText, fill, findByText, hasText, sleep, until, waitNoText, waitText } from '../lib/ui.ts';

/** user popover → Accounts → Passkeys */
async function openPasskeys(page: Page) {
  await openUserMenu(page);
  await clickText(page, 'Accounts');
  await clickText(page, 'Passkeys');
  await waitText(page, /No passkeys yet|Add a passkey/);
}

/** answers the "Confirm it's you" step-up dialog with the password, if it is shown */
async function confirmWithPassword(t: FlowContext, page: Page, account: Account) {
  await waitText(page, "Confirm it's you", 10_000);
  if (!(await page.$('.reauth-dialog input[name=password]'))) {
    await clickText(page, 'Use your password', { selector: 'button' });
  }
  await fill(page, '.reauth-dialog input[name=password]', account.password!);
  await clickText(page, 'Confirm', { selector: '.reauth-dialog button' });
  await waitNoText(page, "Confirm it's you", 15_000);
  t.note('step-up dialog answered with the password');
}

async function passkeyNames(page: Page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('.passkey-settings-item')).map(el => (el as HTMLElement).innerText.split('\n')[0].trim()));
}

async function credentialCount(s: Session) {
  const { credentials } = await s.cdp.send('WebAuthn.getCredentials', { authenticatorId: s.authenticatorId! });
  return credentials.length;
}

/**
 * Settings: profile edit, passkey add/rename/remove (incl. the step-up
 * dialog after a device-only re-login), and Accounts → Add wallet: the
 * RainbowKit modal and the wallet entries that work without an extension.
 */
export const settings: Flow = {
  id: 'settings',
  title: 'Settings: profile edit, passkey add/rename/remove (step-up), wallet connect modal',
  async run(t) {
    const s = await t.session('settings', { authenticator: true });
    const page = s.page;
    const account = await t.step('setup: sign up with a password', () => signUp(t, s, 'password', 'settings'));

    const bio = `e2e bio ${t.unique('b')}`;
    await t.step('edit the profile (bio)', async () => {
      await openUserMenu(page);
      await clickText(page, 'Edit', { selector: 'button' });
      await fill(page, 'textarea[placeholder="A little bit about me..."]', bio);
      await clickText(page, 'Save changes', { selector: 'button' });
      await waitNoText(page, 'Save changes', 10_000);
      await closeUserMenu(page);
      await openUserMenu(page);
      await waitText(page, bio, 10_000);
      await closeUserMenu(page);
    });

    await t.step('add a passkey (fresh login: no step-up)', async () => {
      await openPasskeys(page);
      await clickText(page, 'Add a passkey', { selector: 'button' });
      // a session older than the step-up window asks first, then needs a second click
      if (await findByText(page, "Confirm it's you", { selector: 'div, span, h1, h2, h3', timeout: 2_000 }).catch(() => null)) {
        await confirmWithPassword(t, page, account);
        await clickText(page, 'Create the passkey now', { selector: 'button' });
      }
      await waitText(page, 'Passkey added', 15_000);
      await until('the passkey in the list', async () => (await passkeyNames(page)).length === 1, 10_000);
      assert(await credentialCount(s) === 1, 'the virtual authenticator holds no credential');
    });

    const newName = 'e2e key';
    await t.step('rename the passkey', async () => {
      await clickText(page, 'Rename', { selector: '.passkey-settings-item button' });
      await fill(page, '.passkey-settings-item input', newName);
      await clickText(page, 'Save', { selector: '.passkey-settings-item button' });
      await until('the new name', async () => (await passkeyNames(page)).includes(newName), 10_000);
    });

    // asserted at the end, so the passkey removal below runs either way
    const walletResults: string[] = [];
    await t.step('Accounts → Add wallet: the connect modal and its wallet entries', async () => {
      const openModal = async () => {
        if (await page.$('[data-rk] [role=dialog]')) {
          return;
        }
        await closeUserMenu(page);
        await openUserMenu(page);
        await clickText(page, 'Accounts');
        await clickText(page, 'Add Wallet or Identity');
        await clickText(page, 'Ethereum Wallet');
        await page.waitForSelector('[data-rk] [role=dialog]', { visible: true, timeout: 15_000 });
      };
      await openModal();
      const options = await page.evaluate(() => Array.from(document.querySelectorAll('[data-rk] [data-testid^="rk-wallet-option-"]')).map(el => el.getAttribute('data-testid')!.slice('rk-wallet-option-'.length)));
      t.note(`wallet entries: ${options.join(', ')}`);
      assert(options.length > 0, 'the wallet modal lists no wallets');
      // the entries that work without an installed extension or a host app:
      // WalletConnect-based ones show a QR code, others a "Get <wallet>" view
      const candidates = options.filter(id => /walletConnect|metaMask|rabby|rainbow/i.test(id));
      const results: string[] = [];
      for (const id of candidates) {
        const crashesBefore = t.issueCount(issue => issue.kind === 'pageerror' || issue.kind === 'error-screen' || /App received an error/.test(issue.text));
        await openModal();
        const entry = await page.waitForSelector(`[data-rk] [data-testid="rk-wallet-option-${id}"]`, { visible: true });
        // the modal animates in
        await sleep(600);
        await entry!.click().catch(() => entry!.evaluate(el => (el as HTMLElement).click()));
        let view = await until(`the ${id} view`, () => page.evaluate(() => {
          if (document.getElementById('cg-preview-status')?.textContent?.trim() === "Error :'(") {
            return 'app crashed';
          }
          const dialog = document.querySelector<HTMLElement>('[data-rk] [role=dialog]');
          if (!dialog) {
            return 'modal gone';
          }
          if (/Scan with|scan this|QR code/i.test(dialog.innerText) && dialog.querySelector('svg')) {
            return 'qr';
          }
          return /Get |Add to Chrome|Install|Don.t have/i.test(dialog.innerText) ? 'get' : null;
        }), 15_000).catch(() => 'no view within 15 s');
        await sleep(1000);
        if (view !== 'app crashed' && await page.evaluate(() => document.getElementById('cg-preview-status')?.textContent?.trim() === "Error :'(")) {
          // the modal went away because the whole app did
          view = 'app crashed';
        }
        await checkCrash();
        const crashed = t.issueCount(issue => issue.kind === 'pageerror' || issue.kind === 'error-screen' || /App received an error/.test(issue.text)) > crashesBefore;
        results.push(`${id}: ${view}${crashed && view !== 'app crashed' ? ' (page error)' : ''}`);
        await page.screenshot({ path: `${t.outDir}/wallet-${id}.png` });
        if (view === 'app crashed' || view === 'modal gone' || crashed) {
          // start over for the next entry
          await page.reload({ waitUntil: 'domcontentloaded' });
          await waitAppReady(page);
        }
        else {
          const close = await page.$('[data-rk] [role=dialog] button[aria-label="Close"]');
          await close?.click();
          await sleep(500);
        }
      }
      t.metric('walletEntries', results);
      t.note(`wallet views: ${results.join('; ')}`);
      walletResults.push(...results);

      async function checkCrash() {
        await t.checkErrorScreens();
      }
    });
    await t.step('remove the passkey after a device-only re-login (step-up dialog)', async () => {
      // drop the session cookie: the reload logs in with the device key
      // only, which does not count as a recent authentication
      const cookies = await page.cookies(t.origin);
      for (const cookie of cookies.filter(c => c.name !== 'cg_e2e_client')) {
        await page.deleteCookie({ name: cookie.name, url: t.origin });
      }
      for (let attempt = 1; ; attempt++) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitAppReady(page);
        await openPasskeys(page);
        if (await findByText(page, 'Remove', { selector: '.passkey-settings-item button', timeout: 8_000 }).catch(() => null)) {
          break;
        }
        // the list did not load (see the guard issues): like a user, reload once more
        assert(attempt < 3, 'the passkey list did not load after three reloads');
        t.note(`FINDING: the passkey list did not load after the device-only re-login (attempt ${attempt}); reloading again`);
        await closeUserMenu(page);
      }
      await clickText(page, 'Remove', { selector: '.passkey-settings-item button' });
      let sawStepUp = false;
      await until('the passkey to be removed', async () => {
        if (await hasText(page, "Confirm it's you")) {
          sawStepUp = true;
          await confirmWithPassword(t, page, account);
          return false;
        }
        const keep = await findByText(page, 'Keep it', { selector: 'button', timeout: 200 }).catch(() => null);
        if (keep) {
          await clickText(page, 'Remove', { selector: '.modal-root button, [role=dialog] button, button.btnDestructive' });
          await sleep(500);
          return false;
        }
        return (await passkeyNames(page)).length === 0;
      }, 30_000, 300);
      assert(sawStepUp, 'removing a passkey after a device-only login did not ask to confirm it\'s you');
      await waitText(page, 'No passkeys yet', 10_000);
      await closeUserMenu(page);
    });


    await t.step('every wallet entry rendered its view without crashing the app', async () => {
      assert(walletResults.length > 0 && walletResults.every(entry => /: (qr|get)$/.test(entry)), `wallet modal entries broke: ${walletResults.join('; ')}`);
    });
  },
};

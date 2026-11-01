// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { Flow } from '../lib/harness.ts';
import { signUp } from '../lib/account.ts';
import { createCommunity, waitAppReady } from '../lib/app.ts';
import { assert, until, waitText } from '../lib/ui.ts';

/**
 * Anonymous visitors: the home page in light and dark colour scheme, the
 * instance config, the service worker, and a deep link into a community in
 * a fresh browser context.
 */
export const anonymous: Flow = {
  id: 'anonymous',
  title: 'Anonymous load (light/dark), instance config, service worker, community deep link',
  async run(t) {
    for (const scheme of ['light', 'dark'] as const) {
      const s = await t.session(`anon-${scheme}`, { colorScheme: scheme });
      await t.step(`home page, ${scheme} scheme`, async () => {
        await s.page.goto(t.url('/'), { waitUntil: 'domcontentloaded' });
        await waitAppReady(s.page);
        await waitText(s.page, 'Join for free');
        const theme = await s.page.evaluate(() => document.body.className);
        assert(theme.split(' ').includes(scheme), `body class is "${theme}", expected the ${scheme} theme`);
        await s.page.screenshot({ path: `${t.outDir}/home-${scheme}.png` });
      });
      if (scheme === 'light') {
        await t.step('window.__CG_INSTANCE__ is set', async () => {
          const instance = await s.page.evaluate(() => (window as unknown as { __CG_INSTANCE__?: { appUrl?: string; features?: object } }).__CG_INSTANCE__);
          assert(instance && typeof instance === 'object', 'window.__CG_INSTANCE__ is not set (/instance-config.js)');
          assert(instance.appUrl === t.origin, `__CG_INSTANCE__.appUrl is ${instance.appUrl}, expected ${t.origin}`);
          assert(instance.features && typeof instance.features === 'object', '__CG_INSTANCE__.features missing');
          t.metric('instance', instance);
        });
        await t.step('service worker registers and activates', async () => {
          const script = await until('an active service worker', () => s.page.evaluate(async () => {
            const registration = await navigator.serviceWorker.getRegistration();
            return registration?.active?.scriptURL ?? null;
          }), 30_000, 500);
          assert(script === t.url('/service-worker.js'), `active service worker is ${script}`);
          // the page is controlled after a reload
          await s.page.reload({ waitUntil: 'domcontentloaded' });
          await waitAppReady(s.page);
          const controlled = await until('the page to be controlled by the service worker', () => s.page.evaluate(() => !!navigator.serviceWorker.controller), 15_000);
          assert(controlled, 'page is not controlled by the service worker after a reload');
        });
      }
    }

    // a community to deep-link to, made by a throwaway user in its own context
    const owner = await t.session('owner');
    const community = await t.step('setup: a user creates a community', async () => {
      await signUp(t, owner, 'password', 'anonowner');
      return createCommunity(t, owner.page);
    });

    const visitor = await t.session('deep-link');
    await t.step('deep link /c/<community>/ in a fresh context', async () => {
      await visitor.page.goto(t.url(community.path), { waitUntil: 'domcontentloaded' });
      await waitAppReady(visitor.page);
      await waitText(visitor.page, community.title);
      await waitText(visitor.page, /Join Community/);
      assert(new URL(visitor.page.url()).pathname === community.path, `deep link ended on ${visitor.page.url()}`);
    });
    await t.step('deep link to a channel and back home', async () => {
      await visitor.page.goto(t.url(`${community.path}channel/general/`), { waitUntil: 'domcontentloaded' });
      await waitAppReady(visitor.page);
      await waitText(visitor.page, 'General');
      await visitor.page.goto(t.url('/'), { waitUntil: 'domcontentloaded' });
      await waitAppReady(visitor.page);
      await waitText(visitor.page, 'Join for free');
    });
  },
};

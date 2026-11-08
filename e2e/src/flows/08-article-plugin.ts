// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { Page } from 'puppeteer';
import type { Flow, FlowContext } from '../lib/harness.ts';
import { signUp } from '../lib/account.ts';
import { createCommunity, navigate, waitAppReady } from '../lib/app.ts';
import { assert, clickText, fill, findByText, hasText, sleep, until, waitText } from '../lib/ui.ts';

const YOUTUBE_ID = 'aqz-KE-bpKQ';
const PLUGIN_URL = 'https://example.org/';

/** short-uuid's default translator (flickrBase58, consistent length 22), as the app's getUrl uses it */
function shortUuid(uuid: string) {
  const alphabet = '123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  let n = BigInt(`0x${uuid.replace(/-/g, '')}`);
  let out = '';
  while (n > 0n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out.padStart(22, alphabet[0]);
}

/** the article URL the app links to: /c/<community>/article/<slug>-<short id>/ (src/common/util.ts) */
function articleUrl(communityPath: string, title: string, articleId: string) {
  const slug = title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().split(/[\s-]+/).filter(Boolean);
  return `${communityPath}article/${[...slug, shortUuid(articleId)].join('-')}/`;
}

/** the input of a TextInputField by its label (the label has no `for`) */
function inputByLabel(label: string) {
  return `::-p-xpath(//label[normalize-space(text())="${label}"]/ancestor::div[contains(@class,"input-container")][1]//input)`;
}

async function writeArticle(t: FlowContext, page: Page, communityPath: string, title: string): Promise<string> {
  let articleId: string | undefined;
  const onResponse = async (response: import('puppeteer').HTTPResponse) => {
    if (response.url().includes('/api/v2/Community/createArticle')) {
      const text = await response.text().catch(() => '');
      articleId = /"articleId":"([0-9a-f-]{36})"/.exec(text)?.[1] ?? articleId;
    }
  };
  page.on('response', onResponse);
  await navigate(t, page, `${communityPath}create/article/`);
  await fill(page, 'textarea[placeholder="Title"]', title);
  const body = await page.waitForSelector('.content-input .message-field-input[contenteditable=true]', { visible: true });
  await body!.click();
  await page.keyboard.type('Written by the e2e suite.', { delay: 3 });
  await page.keyboard.press('Enter');
  // the "+" next to an empty paragraph opens the media menu
  const plus = await page.waitForSelector('.editorNewMediaButton button', { visible: true, timeout: 10_000 });
  await plus!.click();
  await clickText(page, 'Embed Youtube Video');
  await fill(page, 'input[placeholder="Link to Youtube video"]', `https://www.youtube.com/watch?v=${YOUTUBE_ID}`);
  await clickText(page, 'Add', { selector: 'button.embedModalAddButton, button' });
  await page.waitForSelector(`.content-input iframe[src*="youtube.com/embed/${YOUTUBE_ID}"], .content-input [id="embed-yt-${YOUTUBE_ID}"]`, { timeout: 15_000 });
  await sleep(500);
  await clickText(page, 'Publish', { selector: 'button' });
  await waitText(page, /Published/, 20_000);
  // the "post published" modal
  const done = await findByText(page, /^(Done|Not now)$/, { selector: 'button', timeout: 10_000 }).catch(() => null);
  await done?.click();
  page.off('response', onResponse);
  assert(articleId, 'no articleId in the createArticle response');
  return articleUrl(communityPath, title, articleId);
}

/**
 * An article with a YouTube embed (written by the owner, read in a fresh
 * anonymous context), and a community plugin (iframe) created by the
 * community owner (Admin role).
 */
export const articlePlugin: Flow = {
  id: 'article-plugin',
  title: 'Article with a YouTube embed; community plugin iframe',
  async run(t) {
    const owner = await t.session('author');
    const page = owner.page;
    const community = await t.step('setup: sign up and create a community', async () => {
      await signUp(t, owner, 'password', 'author');
      return createCommunity(t, page);
    });

    const title = `e2e article ${t.unique('a')}`;
    const articlePath = await t.step('write and publish an article with a YouTube embed', () => writeArticle(t, page, community.path, title));

    const reader = await t.session('reader');
    await t.step('an anonymous reader opens the article and sees the embed', async () => {
      await reader.page.goto(t.url(articlePath), { waitUntil: 'domcontentloaded' });
      await waitAppReady(reader.page);
      await waitText(reader.page, title);
      const src = await until('the YouTube iframe', () => reader.page.evaluate(() =>
        document.querySelector<HTMLIFrameElement>('iframe[src*="youtube.com/embed/"]')?.src ?? null), 20_000);
      assert(src.includes(YOUTUBE_ID), `embed points to ${src}`);
      if (await hasText(reader.page, 'Switch and reload')) {
        t.note('the embed shows the isolation-mode placeholder instead of the player');
      }
      await sleep(2000);
      await reader.page.screenshot({ path: `${t.outDir}/article.png` });
    });

    await t.step('community plugin (iframe)', async () => {
      await navigate(t, page, `${community.path}?modal=plugins`);
      // the community's creator holds the Admin role, which may create
      // plugins; the instance config has no switch that turns plugins off
      const create = await findByText(page, 'Create plugin', { selector: 'button', timeout: 10_000 }).catch(() => null);
      assert(create, 'the community owner has no "Create plugin" in the community settings');
      await create.click();
      const name = `e2e plugin ${t.unique('p').slice(-6)}`;
      await fill(page, inputByLabel('Plugin name'), name);
      await fill(page, inputByLabel('Plugin URL'), PLUGIN_URL);
      await clickText(page, 'Save changes', { selector: 'button' });
      // the keys modal ("These are the keys for your plugin")
      await waitText(page, /keys for your/i, 15_000);
      const close = await page.$('.modal-root .modal-header button.cg-circular');
      await close?.click();
      await sleep(500);
      await navigate(t, page, community.path);
      await clickText(page, name, { timeout: 15_000 });
      await page.waitForFunction(() => /\/plugin\//.test(window.location.pathname), { timeout: 10_000 });
      const trust = await findByText(page, 'I trust, and want to continue', { selector: 'button', timeout: 10_000 }).catch(() => null);
      await trust?.click();
      const src = await until('the plugin iframe', () => page.evaluate(() =>
        document.querySelector<HTMLIFrameElement>('iframe[title^="iframe_"]')?.src ?? null), 20_000);
      assert(src.startsWith(PLUGIN_URL), `plugin iframe points to ${src}`);
      await sleep(1500);
      await page.screenshot({ path: `${t.outDir}/plugin.png` });
    });
  },
};

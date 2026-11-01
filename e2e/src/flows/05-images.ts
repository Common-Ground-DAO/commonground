// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { ElementHandle, Page } from 'puppeteer';
import type { Flow, FlowContext } from '../lib/harness.ts';
import { signUp } from '../lib/account.ts';
import { closeUserMenu, createChannel, createCommunity, EDITOR, navigate, openChannel, openUserMenu } from '../lib/app.ts';
import { writeTestPng } from '../lib/images.ts';
import { assert, clickText, sleep, until, waitText } from '../lib/ui.ts';

/** loads `url` from the page and checks it is served (the <img> rendering is checked by the caller) */
async function assertServedImage(t: FlowContext, page: Page, url: string, what: string) {
  assert(new URL(url).pathname.startsWith('/files/'), `${what}: ${url} is not served from /files/`);
  const [status, type, bytes] = await page.evaluate(async (src: string) => {
    const response = await fetch(src);
    return [response.status, response.headers.get('content-type') ?? '', (await response.arrayBuffer()).byteLength] as const;
  }, url);
  assert(status === 200, `${what}: ${url} answered HTTP ${status}`);
  if (!type.startsWith('image/')) {
    // renders anyway (an <img> ignores the type); noted, not failed
    t.note(`FINDING: ${what} is served as "${type}", not image/*`);
  }
  assert(bytes > 100, `${what}: ${url} has only ${bytes} bytes`);
}

/**
 * Image upload: an image attached to a chat message, and a profile picture;
 * both must render from the edge's /files/ route.
 */
export const images: Flow = {
  id: 'images',
  title: 'Image upload in a message and as avatar, served via /files/',
  async run(t) {
    const s = await t.session('images');
    const page = s.page;
    const channel = await t.step('setup: sign up, community and channel', async () => {
      await signUp(t, s, 'password', 'images');
      const community = await createCommunity(t, page);
      const path = await createChannel(t, page, community, 'pictures');
      await openChannel(t, page, path);
      return path;
    });

    await t.step('send a message with an image attachment', async () => {
      const file = writeTestPng(`${t.outDir}/fixtures`, 'attachment', 320, 200, 2);
      const input = await page.waitForSelector('input[type=file][name="image-uploader"]');
      // the composer uploads the image right away; send only once it is stored
      const uploaded = page.waitForResponse(response => response.url().includes('/api/v2/File/uploadImage'), { timeout: 60_000 });
      await (input as ElementHandle<HTMLInputElement>).uploadFile(file);
      // the attachment preview in the composer (after the client-side image check)
      await waitText(page, 'Remove all', 60_000);
      const editor = await page.waitForSelector(EDITOR, { visible: true });
      await editor!.click();
      await page.keyboard.type('a picture', { delay: 3 });
      await uploaded;
      await until('the composer to finish the upload', async () => page.evaluate(() => !document.querySelector('.send-button')?.textContent?.includes('Uploading')), 60_000);
      await page.keyboard.press('Enter');
      const src = await until('the image message to render', () => page.evaluate(() => {
        const img = document.querySelector<HTMLImageElement>('.message-item .messageAttachmentImages img.messageAttachmentImage');
        return img && img.complete && img.naturalWidth > 0 && !img.src.endsWith('/missing.jpg') ? img.src : null;
      }), 30_000);
      await assertServedImage(t, page, src, 'message image');
      t.metric('messageImage', src.replace(/\/files\/([0-9a-f]{8})[^/]*\/.*/, '/files/$1…'));
    });

    await t.step('the image survives reopening the channel', async () => {
      // away to the community lobby and back (a client-side route change each)
      await navigate(t, page, channel.replace(/channel\/[^/]+\/$/, ''));
      await page.waitForSelector('.message-item img.messageAttachmentImage', { hidden: true, timeout: 10_000 });
      await openChannel(t, page, channel);
      const ok = await until('the image after reopening', () => page.evaluate(() => {
        const img = document.querySelector<HTMLImageElement>('.message-item img.messageAttachmentImage');
        return !!img && img.complete && img.naturalWidth > 0;
      }), 20_000);
      assert(ok, 'image not shown after reopening');
    });

    await t.step('upload a profile picture', async () => {
      await openUserMenu(page);
      await clickText(page, 'Edit', { selector: 'button' });
      await sleep(500);
      const inputs = await page.$$('input[type=file]');
      let uploaded = false;
      for (const input of inputs) {
        // the profile card's own (hidden) input, inside the user popover
        const inPopover = await input.evaluate(el => !!el.closest('.user-setting-modal-content-top-container'));
        if (inPopover) {
          await (input as ElementHandle<HTMLInputElement>).uploadFile(writeTestPng(`${t.outDir}/fixtures`, 'avatar', 256, 256, 3));
          uploaded = true;
          break;
        }
      }
      assert(uploaded, 'no file input in the profile editor');
      // it uploads right away; the widget's background shows the new picture
      const url = await until('the new profile picture', () => page.evaluate(() => {
        const bg = document.querySelector<HTMLElement>('#user-settings-root .user-widget-content-bg')?.style.backgroundImage ?? '';
        const match = /url\("?([^")]+)"?\)/.exec(bg);
        return match && match[1].includes('/files/') ? match[1] : null;
      }), 60_000);
      await assertServedImage(t, page, new URL(url, t.origin).href, 'profile picture');
      const discard = await page.$('xpath/.//button[.//div[contains(@class,"btnText") and (text()="Discard" or text()="Save changes")]]');
      if (discard) {
        await clickText(page, /^(Save changes|Discard)$/, { selector: 'button' }).catch(() => undefined);
      }
      await closeUserMenu(page);
    });
  },
};

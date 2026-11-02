// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { Page } from 'puppeteer';
import type { Flow } from '../lib/harness.ts';
import { instanceInfo, signUp } from '../lib/account.ts';
import { createCommunity, joinCommunity, navigate, waitAppReady } from '../lib/app.ts';
import { assert, clickText, fill, sleep, until } from '../lib/ui.ts';

type AudioStats = { sent: number; received: number; pcs: number };

/** audio bytes over all RTCPeerConnections of the page (wrapped at load, see below) */
async function audioStats(page: Page): Promise<AudioStats> {
  return page.evaluate(async () => {
    const pcs = (window as unknown as { __e2ePeerConnections?: RTCPeerConnection[] }).__e2ePeerConnections ?? [];
    let sent = 0;
    let received = 0;
    for (const pc of pcs) {
      if (pc.connectionState === 'closed') {
        continue;
      }
      const stats = await pc.getStats();
      stats.forEach((report: { type: string; kind?: string; mediaType?: string; bytesSent?: number; bytesReceived?: number }) => {
        const kind = report.kind ?? report.mediaType;
        if (report.type === 'outbound-rtp' && kind === 'audio') {
          sent += report.bytesSent ?? 0;
        }
        if (report.type === 'inbound-rtp' && kind === 'audio') {
          received += report.bytesReceived ?? 0;
        }
      });
    }
    return { sent, received, pcs: pcs.filter(pc => pc.connectionState !== 'closed').length };
  });
}

/** connection states and RTP counters of every peer connection, for failure messages */
async function pcSummary(page: Page) {
  return page.evaluate(async () => {
    const pcs = (window as unknown as { __e2ePeerConnections?: RTCPeerConnection[] }).__e2ePeerConnections ?? [];
    const out: string[] = [];
    for (const pc of pcs) {
      const rtp: string[] = [];
      (await pc.getStats()).forEach((r: { type: string; kind?: string; bytesSent?: number; bytesReceived?: number; state?: string }) => {
        if (r.type === 'outbound-rtp' || r.type === 'inbound-rtp') {
          rtp.push(`${r.type}/${r.kind}:${r.bytesSent ?? r.bytesReceived}`);
        }
        if (r.type === 'candidate-pair' && r.state === 'succeeded') {
          rtp.push('pair-ok');
        }
      });
      out.push(`${pc.connectionState}/${pc.iceConnectionState} senders=${pc.getSenders().map(sd => sd.track?.kind ?? '-').join('+')} ${rtp.join(' ')}`);
    }
    return out.join(' | ') || 'no peer connections';
  });
}

/** both directions of audio grow over `ms` */
async function assertAudioFlows(page: Page, who: string, ms = 3000) {
  const a = await audioStats(page);
  await sleep(ms);
  const b = await audioStats(page);
  assert(b.pcs > 0, `${who}: no open RTCPeerConnection`);
  assert(b.sent > a.sent, `${who}: no audio sent (${a.sent} → ${b.sent} bytes)`);
  assert(b.received > a.received, `${who}: no audio received (${a.received} → ${b.received} bytes)`);
  return b;
}

/** unmutes the microphone (calls start muted): the second button of the call footer (CallActions) */
async function ensureMicOn(page: Page) {
  const mic = await page.waitForSelector('.video-call-footer button.call-actions-button:nth-of-type(2)', { visible: true, timeout: 15_000 });
  if (!(await mic!.evaluate(el => el.classList.contains('media-sharing-enabled')))) {
    await mic!.click();
  }
  await page.waitForSelector('.video-call-footer button.call-actions-button.media-sharing-enabled:nth-of-type(2)', { timeout: 10_000 });
}

/**
 * A two-user call with fake media (Chrome's fake camera/microphone): the
 * owner starts a call in the community, a member joins, audio bytes flow in
 * both directions (RTCPeerConnection stats), the member leaves, the owner
 * ends the call. Afterwards both reload — the device selection stored during
 * the call is read on every load.
 */
export const call: Flow = {
  id: 'call',
  title: 'Two-user call with fake media: join, audio both ways, leave/end',
  async run(t) {
    const owner = await t.session('caller');
    const member = await t.session('callee');
    for (const s of [owner, member]) {
      await s.page.evaluateOnNewDocument(() => {
        const Native = window.RTCPeerConnection;
        const list: RTCPeerConnection[] = [];
        (window as unknown as { __e2ePeerConnections: RTCPeerConnection[] }).__e2ePeerConnections = list;
        window.RTCPeerConnection = class extends Native {
          constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
            super(...args);
            list.push(this);
          }
        } as typeof RTCPeerConnection;
      });
    }

    const community = await t.step('setup: owner creates a community, member joins', async () => {
      await signUp(t, owner, 'password', 'caller');
      const info = await instanceInfo(owner.page);
      if (info.features?.calls === false) {
        t.skip('calls are disabled on this instance (features.calls = false)');
      }
      const c = await createCommunity(t, owner.page);
      await signUp(t, member, 'password', 'callee');
      await joinCommunity(t, member.page, c);
      return c;
    });

    const callPath = await t.step('owner starts a call', async () => {
      await navigate(t, owner.page, community.path);
      await clickText(owner.page, 'Start Call');
      await fill(owner.page, 'input[placeholder="e.g. Daily Standup"]', 'e2e call');
      await clickText(owner.page, 'Start call', { selector: 'button' });
      await owner.page.waitForFunction(() => /\/call\/[^/]+\/?$/.test(window.location.pathname), { timeout: 30_000 });
      await until('the owner to be connected to the call', async () => (await audioStats(owner.page)).pcs > 0, 30_000);
      return new URL(owner.page.url()).pathname;
    });

    await t.step('member joins the call', async () => {
      await navigate(t, member.page, community.path);
      // the call in the community sidebar
      const item = await member.page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>('.call-item')).find(el => el.innerText.includes('e2e call')) ?? null, { timeout: 20_000 });
      await (item as import('puppeteer').JSHandle<Element>).evaluate(el => (el as HTMLElement).click());
      await clickText(member.page, /^(Join call|Join now)$/, { selector: 'button', timeout: 30_000 });
      await until('the member to be connected to the call', async () => (await audioStats(member.page)).pcs > 0, 30_000);
      assert(new URL(member.page.url()).pathname === callPath, `member is on ${member.page.url()}, expected ${callPath}`);
    });

    await t.step('peer cards without camera or profile picture load no image', async () => {
      // Both users are fresh (no profile picture) and join with the camera
      // off, so every peer card shows the "no video" background. It must not
      // reference an image: `url(undefined)` made the browser request
      // `…/call/<id>/undefined` (the global `undefined-url` guard fails the
      // flow on such a request).
      for (const [page, who] of [[owner.page, 'owner'], [member.page, 'member']] as const) {
        const backgrounds = await until(`${who}: two peer cards`, async () => {
          const found = await page.$$eval('.call-peer-card', els => els.map(el => (el as HTMLElement).style.backgroundImage));
          return found.length >= 2 ? found : null;
        }, 15_000);
        t.metric(`peerCardBackgrounds.${who}`, backgrounds);
        assert(backgrounds.every(b => b === 'none' || b === ''), `${who}: peer card backgrounds ${JSON.stringify(backgrounds)}`);
      }
    });

    await t.step('audio flows both ways', async () => {
      await ensureMicOn(owner.page);
      await ensureMicOn(member.page);
      const flows = async (page: Page, who: string) => until(`audio in both directions (${who})`, () => assertAudioFlows(page, who).catch(() => null), 30_000, 500)
        .catch(async e => {
          throw new Error(`${(e as Error).message} — ${who} peer connections: ${await pcSummary(page)}`);
        });
      const ownerStats = await flows(owner.page, 'owner');
      const memberStats = await flows(member.page, 'member');
      t.metric('audioBytes', { owner: ownerStats, member: memberStats });
    });

    await t.step('member leaves, owner ends the call', async () => {
      const leave = await member.page.waitForSelector('button.btnFinal.call-actions-button-size', { visible: true });
      await leave!.click();
      await until('the member to leave', async () => (await audioStats(member.page)).pcs === 0 || !/\/call\//.test(new URL(member.page.url()).pathname), 15_000);
      const moderate = await owner.page.$('button.call-actions-button');
      if (moderate) {
        await moderate.click();
        await clickText(owner.page, 'End call for everyone', { timeout: 5_000 }).catch(async () => {
          // no moderation menu: leave instead
          await (await owner.page.waitForSelector('button.btnFinal.call-actions-button-size', { visible: true }))!.click();
        });
      }
      else {
        await (await owner.page.waitForSelector('button.btnFinal.call-actions-button-size', { visible: true }))!.click();
      }
      await until('the owner to leave', async () => (await audioStats(owner.page)).pcs === 0, 15_000);
    });

    await t.step('reload after the call', async () => {
      for (const s of [owner, member]) {
        await s.page.reload({ waitUntil: 'domcontentloaded' });
        await waitAppReady(s.page);
        await sleep(1000);
      }
    });

    await t.step('reload with the call camera unplugged', async () => {
      // The app remembers the devices of the last call (localStorage
      // selectedAudioDeviceId / selectedVideoDeviceId) and checks them on
      // every load. Emulate a machine whose camera is gone since (an
      // unplugged webcam, a closed laptop lid): the browser lists no video
      // input any more.
      const stored = await owner.page.evaluate(() => localStorage.getItem('selectedVideoDeviceId'));
      t.note(`stored camera id: ${stored}`);
      await owner.page.evaluateOnNewDocument(() => {
        const original = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
        navigator.mediaDevices.enumerateDevices = async () => (await original()).filter(device => device.kind !== 'videoinput');
      });
      await owner.page.reload({ waitUntil: 'domcontentloaded' });
      await waitAppReady(owner.page);
      await sleep(1500);
    });
  },
};

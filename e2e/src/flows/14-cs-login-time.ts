// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { ConsoleMessage, HTTPResponse } from 'puppeteer';
import type { Flow } from '../lib/harness.ts';
import { signUp } from '../lib/account.ts';
import { connectionState, createChannel, createCommunity, openChannel, sendMessage, waitAppReady } from '../lib/app.ts';
import { prepareLivePage, shownMessages } from '../lib/live.ts';
import { assert, sleep } from '../lib/ui.ts';

const ITERATIONS = 6;
/** generous: a page load on the dev VM's disposable instance takes 1–3 s */
const LOGGED_IN_THRESHOLD_MS = 10_000;
const FIRST_MESSAGE_THRESHOLD_MS = 10_000;
const MEASURE_TIMEOUT_MS = 30_000;

type Sample = {
  i: number;
  how: 'reload' | 'navigate';
  /** the device login's OK response (the server logged the session in) */
  deviceLoginMs: number | null;
  /** the connection indicator shows "connected" */
  connectedMs: number | null;
  /** max(deviceLogin, connected): the user is logged in and live */
  loggedInMs: number | null;
  /** the first message of the open channel is shown */
  firstMessageMs: number | null;
  /** every message posted in setup is shown */
  allMessagesMs: number | null;
  /** "taking longer than 7s" console lines of the load (the notification setup's timeout) */
  slowSetupLogs: number;
};

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

/**
 * E7 (docs/todo/ROADMAP_chat-sync.md, Acceptance): login time. A user in a
 * channel with history reloads the page; per load the flow measures when
 * the device login answered OK, when the connection indicator showed
 * "connected" (together: logged in and live), and when the channel's first
 * and last messages were shown. The numbers go into the report (they decide
 * whether message persistence, P4, is worth it); the flow fails only above a
 * generous threshold.
 */
export const csLoginTime: Flow = {
  id: 'cs-login-time',
  title: 'E7 login time: reload → logged in and live under a threshold; time to first message reported',
  async run(t) {
    const s = await t.session('timer');
    await prepareLivePage(s.page);
    const posted = await t.step('setup: sign up, community, channel with three messages', async () => {
      await signUp(t, s, 'password', 'timer');
      const community = await createCommunity(t, s.page);
      const channel = await createChannel(t, s.page, community, 'history');
      await openChannel(t, s.page, channel);
      const texts = [`history 1 ${t.unique('m')}`, `history 2 ${t.unique('m')}`, `history 3 ${t.unique('m')}`];
      for (const text of texts) {
        await sendMessage(s.page, text);
      }
      return { channel, texts };
    });

    let loadStarted = 0;
    let loginOkAt: number | null = null;
    let slowSetupLogs = 0;
    const onResponse = async (response: HTTPResponse) => {
      if (!response.url().includes('/api/v2/User/login') || !loadStarted) {
        return;
      }
      try {
        const body = JSON.parse(await response.text()) as { status?: string };
        if (body.status === 'OK' && loginOkAt === null) {
          loginOkAt = Date.now();
        }
      }
      catch {
        // aborted
      }
    };
    const onConsole = (msg: ConsoleMessage) => {
      if (/taking longer than 7s/i.test(msg.text())) {
        slowSetupLogs++;
      }
    };
    s.page.on('response', onResponse);
    s.page.on('console', onConsole);

    const samples: Sample[] = [];
    await t.step(`${ITERATIONS} page loads, measured`, async () => {
      for (let i = 0; i < ITERATIONS; i++) {
        const how = i === ITERATIONS - 1 ? 'navigate' : 'reload';
        loginOkAt = null;
        slowSetupLogs = 0;
        loadStarted = Date.now();
        if (how === 'reload') {
          await s.page.reload({ waitUntil: 'domcontentloaded' });
        }
        else {
          await s.page.goto(t.url(posted.channel), { waitUntil: 'domcontentloaded' });
        }
        const sample: Sample = { i, how, deviceLoginMs: null, connectedMs: null, loggedInMs: null, firstMessageMs: null, allMessagesMs: null, slowSetupLogs: 0 };
        while (Date.now() - loadStarted < MEASURE_TIMEOUT_MS) {
          const now = Date.now() - loadStarted;
          if (sample.deviceLoginMs === null && loginOkAt !== null) {
            sample.deviceLoginMs = loginOkAt - loadStarted;
          }
          if (sample.connectedMs === null && await connectionState(s.page).catch(() => '') === 'connected') {
            sample.connectedMs = now;
          }
          if (sample.firstMessageMs === null || sample.allMessagesMs === null) {
            const shown = await shownMessages(s.page).catch(() => []);
            if (sample.firstMessageMs === null && shown.some(m => m.confirmed)) {
              sample.firstMessageMs = now;
            }
            if (sample.allMessagesMs === null && posted.texts.every(text => shown.some(m => m.confirmed && m.text.includes(text)))) {
              sample.allMessagesMs = now;
            }
          }
          if (sample.deviceLoginMs !== null && sample.connectedMs !== null && sample.allMessagesMs !== null) {
            break;
          }
          await sleep(50);
        }
        if (sample.deviceLoginMs !== null && sample.connectedMs !== null) {
          sample.loggedInMs = Math.max(sample.deviceLoginMs, sample.connectedMs);
        }
        // let the load finish (notification setup etc.) before the next one
        await waitAppReady(s.page).catch(() => undefined);
        await sleep(2_000);
        sample.slowSetupLogs = slowSetupLogs;
        samples.push(sample);
        console.log(`      #${i} ${how}: login ${sample.deviceLoginMs}ms, connected ${sample.connectedMs}ms, first message ${sample.firstMessageMs}ms, all ${sample.allMessagesMs}ms${sample.slowSetupLogs ? `, slow-setup logs ${sample.slowSetupLogs}` : ''}`);
      }
    });
    s.page.off('response', onResponse);
    s.page.off('console', onConsole);

    const values = (key: 'loggedInMs' | 'firstMessageMs' | 'allMessagesMs' | 'deviceLoginMs' | 'connectedMs') =>
      samples.map(sample => sample[key]).filter((v): v is number => v !== null);
    const summary = Object.fromEntries((['deviceLoginMs', 'connectedMs', 'loggedInMs', 'firstMessageMs', 'allMessagesMs'] as const)
      .map(key => [key, { median: median(values(key)), max: values(key).length ? Math.max(...values(key)) : null, missing: samples.length - values(key).length }]));
    t.metric('loginTimeSamples', samples);
    t.metric('loginTimeSummary', summary);
    t.note(`login time (median/max ms): logged in ${summary.loggedInMs.median}/${summary.loggedInMs.max}, first message ${summary.firstMessageMs.median}/${summary.firstMessageMs.max}, all messages ${summary.allMessagesMs.median}/${summary.allMessagesMs.max}`);
    const slow = samples.filter(sample => sample.slowSetupLogs > 0).length;
    if (slow) {
      t.note(`FINDING: ${slow} of ${samples.length} loads logged "taking longer than 7s" (notification setup timeout)`);
    }

    await t.step(`every load is logged in and live within ${LOGGED_IN_THRESHOLD_MS / 1000} s and shows a message within ${FIRST_MESSAGE_THRESHOLD_MS / 1000} s`, async () => {
      const bad = samples.filter(sample => sample.loggedInMs === null || sample.loggedInMs > LOGGED_IN_THRESHOLD_MS ||
        sample.firstMessageMs === null || sample.firstMessageMs > FIRST_MESSAGE_THRESHOLD_MS);
      assert(bad.length === 0, `${bad.length} of ${samples.length} loads too slow or incomplete: ${bad.map(sample =>
        `#${sample.i} login ${sample.deviceLoginMs}ms connected ${sample.connectedMs}ms first message ${sample.firstMessageMs}ms`).join('; ')}`);
    });
  },
};

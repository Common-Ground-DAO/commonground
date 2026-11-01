// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { sleep } from './ui.ts';

/** Reads mails the instance sent from a Mailpit catcher (API v1). */

type MailSummary = { ID: string; Created: string; Subject: string; To: { Address: string }[] };

export async function waitForMail(mailpitUrl: string, to: string, timeoutMs = 30_000, since = 0): Promise<{ subject: string; text: string; html: string }> {
  const started = Date.now();
  const query = encodeURIComponent(`to:"${to}"`);
  for (;;) {
    const res = await fetch(`${mailpitUrl}/api/v1/search?query=${query}&limit=10`);
    if (!res.ok) {
      throw new Error(`mailpit search failed: HTTP ${res.status}`);
    }
    const { messages } = await res.json() as { messages: MailSummary[] };
    const match = (messages ?? []).find(m => Date.parse(m.Created) >= since);
    if (match) {
      const full = await (await fetch(`${mailpitUrl}/api/v1/message/${match.ID}`)).json() as { Subject: string; Text: string; HTML: string };
      return { subject: full.Subject, text: full.Text ?? '', html: full.HTML ?? '' };
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`no mail to ${to} within ${timeoutMs / 1000}s`);
    }
    await sleep(500);
  }
}

/** the first 6-digit code in the mail to `to` */
export async function waitForCode(mailpitUrl: string, to: string, since: number): Promise<string> {
  const mail = await waitForMail(mailpitUrl, to, 30_000, since - 2000);
  const code = /\b(\d{6})\b/.exec(mail.text) ?? /\b(\d{6})\b/.exec(mail.html.replace(/<[^>]+>/g, ' '));
  if (!code) {
    throw new Error(`mail "${mail.subject}" to ${to} contains no 6-digit code`);
  }
  return code[1];
}

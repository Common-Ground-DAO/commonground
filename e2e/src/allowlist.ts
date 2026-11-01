// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { IssueKind } from './lib/harness.ts';

/**
 * Known noise the global guards must not fail on.
 *
 * Policy (e2e/README.md, "Allowlist"): an entry is only for noise that is
 * outside the app's control or that the test environment itself causes —
 * third-party scripts, the sandboxed network of the test runner, browser
 * warnings that are logged as errors. Never allowlist an error of the app
 * itself to make a run green; fix it or let the flow fail. Every entry says
 * why it is harmless, and is as narrow as possible (kind + a specific
 * pattern, optionally the URL it comes from). Page errors (uncaught
 * exceptions) and the error-boundary screen are never allowlisted.
 */
export type AllowEntry = {
  kind: IssueKind | IssueKind[];
  /** matched against the issue text (at least one of text/url is given) */
  text?: RegExp;
  /** matched against the URL the issue is attributed to, if given */
  url?: RegExp;
  reason: string;
};

export const allowlist: AllowEntry[] = [
  {
    // The WalletConnect project id the frontend uses on an instance without
    // its own (and any id on an origin not registered for it — every test
    // instance) makes the WalletConnect / Reown SDK's config and analytics
    // requests fail with HTTP 403, which the browser logs as errors. Outside
    // the app's control; the wallet flow asserts what matters on its own
    // (the modal and the QR views render, no page error).
    kind: 'console-error',
    url: /^https:\/\/([a-z0-9-]+\.)*(walletconnect\.(org|com)|web3modal\.org|reown\.com)\//,
    reason: 'WalletConnect/Reown SDK requests refused for an origin the project id is not registered for',
  },
  {
    kind: 'console-error',
    text: /^Origin https?:\/\/\S+ not found on Allowlist - update configuration on cloud\.reown\.com/,
    reason: 'WalletConnect/Reown SDK: the test origin is not registered for the project id',
  },
  {
    // Puppeteer's browser contexts are incognito-like, and Chrome logs this
    // as a console error when a page checks for push support. A test
    // environment artifact: in a normal profile push works.
    kind: 'console-error',
    text: /^Chrome currently does not support the Push API in incognito mode/,
    reason: 'test environment: Push API is unavailable in incognito browser contexts',
  },
];

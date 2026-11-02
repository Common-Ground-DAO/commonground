// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { mkdirSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer';
import { parseArgs } from './lib/config.ts';
import { spkiPinsFor } from './lib/tls.ts';
import { FlowContext, SkipFlow, type FlowResult } from './lib/harness.ts';
import { flowGroups, flows } from './flows/index.ts';

/**
 * Entry point of the end-to-end suite (normally started by e2e/run.sh inside
 * the backend image, which ships the pinned Chrome and puppeteer).
 * Exit code: 0 the selected flows passed or skipped (at least one passed), 1 a flow
 * failed or nothing passed,
 * 2 the suite itself could not start.
 */

async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (config.list) {
    for (const flow of flows) {
      console.log(`${flow.id.padEnd(16)} ${flow.title}`);
    }
    for (const [group, ids] of Object.entries(flowGroups)) {
      console.log(`${group.padEnd(16)} (group) ${ids.join(', ')}`);
    }
    return 0;
  }
  // a group name stands for its flows
  const wanted = config.flows.flatMap(id => flowGroups[id] ?? [id]);
  const unknown = wanted.filter(id => !flows.some(flow => flow.id === id));
  if (unknown.length) {
    throw new Error(`unknown flow(s): ${unknown.join(', ')} — see --list`);
  }
  const selected = wanted.length ? flows.filter(flow => wanted.includes(flow.id)) : flows;
  mkdirSync(config.outDir, { recursive: true });

  const { pins, details } = await spkiPinsFor(config.baseUrl, config.caFile, [4443]);
  details.forEach(line => console.log(`tls: ${line}`));
  pins.push(...config.spki);

  const args = [
    // the runner is a container: no setuid sandbox, small /dev/shm
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // calls: fake camera/microphone, no permission prompts
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--lang=en-US',
    // keep background tabs (second user) running at full speed
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];
  if (pins.length) {
    args.push(`--ignore-certificate-errors-spki-list=${pins.join(',')}`);
  }
  if (config.resolve.length) {
    args.push(`--host-resolver-rules=${config.resolve.map(rule => {
      const [host, ip] = rule.split('=');
      return `MAP ${host} ${ip}`;
    }).join(',')}`);
  }

  const browser = await puppeteer.launch({
    args,
    slowMo: config.slowMo || undefined,
    protocolTimeout: 120_000,
  });
  const started = Date.now();
  const results: FlowResult[] = [];
  let instance: unknown = null;
  try {
    console.log(`Common Ground e2e — ${config.baseUrl} — Chrome ${await browser.version()}`);
    for (const flow of selected) {
      console.log(`\n▶ ${flow.id}: ${flow.title}`);
      const t = new FlowContext(config, browser, flow, `${config.outDir}/${flow.id}`);
      const flowStarted = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutMs = flow.timeoutMs?.(config) ?? config.flowTimeoutMs;
      try {
        await Promise.race([
          flow.run(t),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`flow timed out after ${timeoutMs / 1000}s`)), timeoutMs);
          }),
        ]);
      }
      catch (e) {
        if (e instanceof SkipFlow) {
          t.result.status = 'skip';
          t.result.skipReason = e.message;
        }
        else {
          t.result.status = 'fail';
          t.result.error = e instanceof Error ? `${e.message}${e.stack ? `\n${e.stack.split('\n').slice(1, 5).join('\n')}` : ''}` : String(e);
          if (!t.result.steps.some(step => step.status === 'fail')) {
            await t.screenshots('FAIL-flow');
          }
        }
      }
      finally {
        clearTimeout(timer);
        if (!instance) {
          instance = await t.sessions[0]?.page.evaluate(() => (window as unknown as { __CG_INSTANCE__?: unknown }).__CG_INSTANCE__ ?? null).catch(() => null);
        }
        await t.close();
      }
      // guard issues fail a flow — also one that skipped after recording them
      if (t.result.status !== 'fail' && t.result.issues.length > 0) {
        t.result.error = `${t.result.issues.length} guard issue(s): ${[...new Set(t.result.issues.map(issue => issue.kind))].join(', ')}` +
          (t.result.status === 'skip' ? ` (before it skipped: ${t.result.skipReason})` : '');
        t.result.status = 'fail';
      }
      t.result.durationMs = Date.now() - flowStarted;
      results.push(t.result);
      const mark = t.result.status === 'pass' ? '✔' : t.result.status === 'skip' ? '○' : '✘';
      console.log(`${mark} ${flow.id} ${t.result.status.toUpperCase()} (${(t.result.durationMs / 1000).toFixed(1)}s)` +
        (t.result.skipReason && t.result.status === 'skip' ? ` — ${t.result.skipReason}` : '') +
        (t.result.error ? ` — ${t.result.error.split('\n')[0]}` : ''));
    }
  }
  finally {
    await browser.close().catch(() => undefined);
  }

  const totalMs = Date.now() - started;
  const report = {
    baseUrl: config.baseUrl,
    startedAt: new Date(started).toISOString(),
    durationMs: totalMs,
    instance,
    summary: {
      pass: results.filter(r => r.status === 'pass').length,
      fail: results.filter(r => r.status === 'fail').length,
      skip: results.filter(r => r.status === 'skip').length,
    },
    flows: results,
  };
  writeFileSync(`${config.outDir}/report.json`, JSON.stringify(report, null, 2));

  console.log('\n──────── summary ────────');
  for (const r of results) {
    console.log(`${r.status.toUpperCase().padEnd(5)} ${r.id.padEnd(16)} ${(r.durationMs / 1000).toFixed(1).padStart(6)}s  ${(r.status === 'skip' ? r.skipReason : r.error?.split('\n')[0]) ?? ''}`);
    for (const issue of r.issues) {
      console.log(`        ${issue.kind} [${issue.session} @ ${issue.step}]${issue.count > 1 ? ` ×${issue.count}` : ''}: ${issue.text.split('\n')[0].slice(0, 220)}`);
    }
  }
  console.log(`\n${report.summary.pass} passed, ${report.summary.fail} failed, ${report.summary.skip} skipped in ${(totalMs / 1000).toFixed(0)}s — report: ${config.outDir}/report.json`);
  if (report.summary.pass === 0) {
    console.log('nothing passed (every flow failed or skipped)');
    return 1;
  }
  return report.summary.fail > 0 ? 1 : 0;
}

// a throwing event handler of a flow must not take the whole run down
process.on('uncaughtException', e => console.error('uncaught exception in the suite (continuing):', e));
process.on('unhandledRejection', e => console.error('unhandled rejection in the suite (continuing):', e));

main().then(code => process.exit(code), e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
});

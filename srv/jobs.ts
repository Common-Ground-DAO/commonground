// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { Worker } from 'worker_threads';
import cron from "node-cron";
import path from 'path';
import config from './common/config';
import { fakeHealthcheck } from './healthcheck';

let processIsExiting = false;

const allWorkers: Map<string, Worker> = new Map();

async function createCronOrIntervalWorker(filename: string, options: ({ cronExpression: string } | { interval: number })) {
  const onExit = (code: number) => {
    console.log(`${filename} Worker exited with code ${code}`);
    allWorkers.delete(filename);
  }
  const spawn = async (type: 'Cron' | 'Interval') => {
    if (!processIsExiting) {
      console.log(`=== Spawning ${type} ${filename} Worker... ===`);
      const existingWorker = allWorkers.get(filename);
      if (!existingWorker) {
        const worker = new Worker(path.join(__dirname, 'jobs', `${filename}.js`));
        allWorkers.set(filename, worker);
        worker.on("error", (error) => {
          console.error(`An error occurred in ${filename} Worker`, error);
        });
        worker.on("exit", onExit);
      }
      else {
        console.warn(`WARNING! There is already a ${filename} Worker running, skipping spawning another one. This should not happen, investigate!`);
      }
    }
  }
  if ('cronExpression' in options) {
    cron.schedule(options.cronExpression, () => spawn('Cron'));
  }
  else if ('interval' in options) {
    setInterval(() => spawn('Interval'), options.interval);
  }
  else {
    throw new Error("Invalid options");
  }
}

async function createPermanentWorker(filename: string, restart = true, sleepBefore?: number) {
  // sleep 30s for migration(s) to finish
  if (sleepBefore !== undefined)
    await new Promise<void>(resolve => setTimeout(resolve, sleepBefore));

  console.log(`=== Spawning Permanent ${filename} Worker... ===`);
  const worker = new Worker(path.join(__dirname, 'jobs', `${filename}.js`));
  allWorkers.set(filename, worker);
  worker.on("error", (error) => {
    console.error(`An error occurred in ${filename} Worker`, error);
  });
  worker.on("exit", (code) => {
    if (!processIsExiting && restart) {
      console.error(`${filename} exited unexpectedly with code ${code}, restarting in 1s`);
      setTimeout(() => createPermanentWorker(filename, true), 1000);
    }
  });
}

// Kept for future one-shot migrations/backfills (together with the `oneshot_jobs`
// table that such jobs use to guard against re-running). Currently no one-shot job
// is scheduled — the historical backfills were removed after they had run everywhere.
async function createOneshotWorker(filename: string, sleepBefore?: number) {
  if (sleepBefore !== undefined)
    await new Promise<void>(resolve => setTimeout(resolve, sleepBefore));

  console.log(`=== Spawning Oneshot ${filename} Worker... ===`);
  const worker = new Worker(path.join(__dirname, 'jobs', `${filename}.js`));
  worker.on("error", (error) => {
    console.error(`An error occurred in ${filename} Worker`, error);
  });
  worker.on("exit", (code) => {
    if (!processIsExiting) {
      console.error(`${filename} Worker exited with code ${code}`);
    }
  });
}

createPermanentWorker('premiumRenewal', true, 30000);
createPermanentWorker('callUpdateEmitter', true);
createPermanentWorker('trackTokenSales', true, 30000);
createPermanentWorker('handleCommunityAirdrops', true, 30000);

if (config.DEPLOYMENT === 'prod') {
  createPermanentWorker('tokenSaleNotifications', true, 30000);
}

// the backend image's HEALTHCHECK reads healthcheck.txt; without this the
// job-runner container reports permanently unhealthy (every other backend
// service already does the same)
fakeHealthcheck();

createCronOrIntervalWorker('onlineStatusCheck', { interval: 30000 });
// staking Spark drip: the pro-rata target math makes cadence cosmetic —
// totals are exact regardless — 6-hourly keeps balances feeling alive
createCronOrIntervalWorker('stakingAccrual', { cronExpression: '17 */6 * * *' });
createCronOrIntervalWorker('activityScore', { cronExpression: '*/10 * * * *' });
createCronOrIntervalWorker('newsletterDelivery', { cronExpression: '0 12 * * 6' });
createCronOrIntervalWorker('emailNotifications', { cronExpression: '*/1 * * * *' });

process.on('SIGTERM', async () => {
  processIsExiting = true;
  if (allWorkers.get('activityScore') !== undefined) {
    await new Promise<void>(resolve => setTimeout(resolve, 4000));
  }
  allWorkers.get('activityScore')?.terminate();
  allWorkers.get('premiumRenewal')?.terminate();
  allWorkers.get('callUpdateEmitter')?.terminate();
  allWorkers.get('newsletterDelivery')?.terminate();
  allWorkers.get('emailNotifications')?.terminate();
  allWorkers.get('trackTokenSales')?.terminate();
  await new Promise<void>(resolve => setTimeout(resolve, 1000));
  process.exit(allWorkers.get('activityScore') === undefined ? 0 : 1);
});
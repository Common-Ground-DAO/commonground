// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { Worker } from 'worker_threads';
import cron from "node-cron";
import path from 'path';
import { postgresProbe, startHealthcheck } from './healthcheck';
import { valkeyProbe } from './redis/healthProbe';
import pool from './util/postgres';

let processIsExiting = false;

/**
 * Heap cap of every worker thread. Without it each worker sizes its heap like
 * the main thread — about half of the container's memory limit — so a few
 * busy workers together could pass the limit long before V8 collects. With
 * it, the workers' sum stays below the job-runner's limit: at most nine run
 * at once (four permanent ones, five scheduled ones, each at most once), 9 x
 * 384 MB = 3.4 GB of the default 4 GB (docker-compose.selfhost.yml, docs/
 * deployment §5). JOB_WORKER_MAX_OLD_SPACE_MB overrides it; a worker that hits
 * it ends with ERR_WORKER_OUT_OF_MEMORY and is restarted like any crashed one.
 */
const WORKER_RESOURCE_LIMITS = {
  maxOldGenerationSizeMb: Number(process.env.JOB_WORKER_MAX_OLD_SPACE_MB) || 384,
};

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
        const worker = new Worker(path.join(__dirname, 'jobs', `${filename}.js`), { resourceLimits: WORKER_RESOURCE_LIMITS });
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
  const worker = new Worker(path.join(__dirname, 'jobs', `${filename}.js`), { resourceLimits: WORKER_RESOURCE_LIMITS });
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
  const worker = new Worker(path.join(__dirname, 'jobs', `${filename}.js`), { resourceLimits: WORKER_RESOURCE_LIMITS });
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
createPermanentWorker('handleCommunityAirdrops', true, 30000);
// receives the selfhost mail relay's bounce reports (selfhost compose sets
// MAIL_BOUNCE_RECEIVER from CG_ENABLE_MAIL); needs the relay login
if (process.env.MAIL_BOUNCE_RECEIVER === 'true') {
  if (process.env.SMTP_USER && process.env.SMTP_PASSWORD) {
    createPermanentWorker('bounceReceiver', true);
  } else {
    console.error('MAIL_BOUNCE_RECEIVER=true, but SMTP_USER/SMTP_PASSWORD are not set: bounce handling is off');
  }
}

// healthy: the database and the Valkey state instance (the workers publish
// their events through it) answer; the job-runner has no listener. The main
// thread uses its pool for this probe only (the workers have their own): an
// idle connection the database drops (a restart) is reported, not thrown —
// without a listener the pool's `error` event would end the whole job-runner.
pool.on('error', (error) => {
  console.warn(`healthcheck: idle database connection lost (${error.message})`);
});
startHealthcheck([postgresProbe(pool), valkeyProbe()]);

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
  await new Promise<void>(resolve => setTimeout(resolve, 1000));
  process.exit(allWorkers.get('activityScore') === undefined ? 0 : 1);
});
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { writeFileSync } from "fs";
import pool from './util/postgres';
import dayjs from 'dayjs';
import redisManager from './redis';

export async function healthcheckHandler() {
	try {
		await queryDb();
		return true;
	} catch (e) {
		return false
	}
}

async function queryDb() {
	let query = `
			insert into logging (service, data)
			values('healthcheck', $1)
		`;
	const dbResult = await pool.query(query, [{ datetime: dayjs().toISOString() }]);
	return dbResult;
}

// The state instance is the one the app cannot work without (the cache
// instance is optional), and all its clients share one server, so one PING on
// the data client is enough. Importing `./redis` opens no connection by itself
// — clients connect on first use — so processes that only need
// `fakeHealthcheck` from this module hold no Redis connection.
async function checkRedis(): Promise<boolean> {
	try {
		return (await redisManager.getClient("data").ping()) === 'PONG';
	} catch (e) {
		return false;
	}
}

export function startHealthcheck() {
	setInterval(async () => {
		const dbStatus = await healthcheckHandler();
		const redisStatus = await checkRedis();
		if (dbStatus && redisStatus) {
			writeFileSync('./healthcheck.txt', '0');
		} else {
			writeFileSync('./healthcheck.txt', '1');
		}
	}, 10000);
}

//to-do: implement proper healthcheck for mediasoup server
export function fakeHealthcheck() {
	setInterval(async () => {
		writeFileSync('./healthcheck.txt', '0');
	}, 10000);
}

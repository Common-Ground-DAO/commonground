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

// All four clients talk to the same Redis instance, so one PING on the
// non-legacy data client is enough to know Redis is reachable.
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

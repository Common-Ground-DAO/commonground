// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import {
  checkRoleClaimability,
  checkCommunityRoleClaimability,
  getContractData,
  howManyUsedAPICallsForRoleClaimChecks,
  checkMultiRoleClaimability,
  getSingleTransactionData,
  getErc20Balance,
  getBlockNumber,
} from './onchain/index';
import express from 'express';
import { OnchainPriority } from './onchain/scheduler';
import { fakeHealthcheck } from './healthcheck';
import pool from './util/postgres';
import format from 'pg-format';
import { isValidSignature, getUniversalProfileData } from './onchain/lukso';
import { PredefinedRole, RoleType } from './common/enums';

const app = express();

app.post('/getContractData', express.json(), async (req, res) => {
  const { chain, address, skipWatch } = req.body;
  try {
    const data = await getContractData(chain, address, skipWatch || false);
    res.json(data);
  } catch (e) {
    res.sendStatus(500);
    console.error("An error occurred fetching contract data", e);
  }
});

app.post('/checkRoleClaimability', express.json(), async (req, res) => {
  const data: {
    userId: string,
    roleId: string;
    assignmentRules: Models.Community.AssignmentRules & { type: "token" };
    priority: OnchainPriority;
  } = req.body;
  try {
    const result = await checkRoleClaimability(data.userId, data.roleId, data.assignmentRules, data.priority);
    res.json({ data: result });
  } catch (e) {
    res.sendStatus(500);
    console.error("An error occurred checking role claim", e);
  }
});

app.post('/checkMultiRoleClaimability', express.json(), async (req, res) => {
  const data: {
    userId: string,
    roleData: {
      id: string;
      assignmentRules: Models.Community.AssignmentRules & { type: "token" };
    }[];
    priority: OnchainPriority;
  } = req.body;
  try {
    const result = await checkMultiRoleClaimability(data.userId, data.roleData, data.priority);
    res.json({ data: result });
  } catch (e) {
    res.sendStatus(500);
    console.error("An error occurred checking role claim", e);
  }
});

app.post('/checkCommunityRoleClaimability', express.json(), async (req, res) => {
  const data: {
    userId: string,
    communityId: string,
  } = req.body;
  try {
    const result = await checkCommunityRoleClaimability(data.userId, data.communityId, OnchainPriority.MEDIUM);
    res.json({ data: result });
  } catch (e) {
    res.sendStatus(500);
    console.error("An error occurred checking community role claimability", e);
  }
});

app.post('/luksoIsValidSignature', express.json(), async (req, res) => {
  const data: {
    address: Common.Address;
    signature: string;
    message: string;
  } = req.body;
  try {
    const isValid = await isValidSignature('lukso', { data: { address: data.address, signature: data.signature, message: data.message } });
    res.json({ isValidSignature: isValid });
  } catch (e) {
    res.sendStatus(500);
    console.error("An error occurred checking validity of signature", e);
  }
});

app.post('/luksoGetUniversalProfileData', express.json(), async (req, res) => {
  const data: {
    address: Common.Address;
  } = req.body;
  try {
    const result = await getUniversalProfileData('lukso', { data: { address: data.address } });
    res.json(result);
  } catch (e: any) {
    console.error("An error occurred getting the profile data", e);
    res.status(500).json(e.message);
  }
});

app.post('/getSingleTransactionData', express.json(), async (req, res) => {
  const data: {
    chain: Models.Contract.ChainIdentifier;
    txHash: string;
  } = req.body;
  try {
    const result = await getSingleTransactionData(data.chain, data.txHash);
    res.json(result);
  } catch (e) {
    res.sendStatus(500);
    console.error("An error occurred validating investment transaction", e);
  }
});

app.post('/getErc20Balance', express.json(), async (req, res) => {
  const data: {
    chain: Models.Contract.ChainIdentifier;
    contractAddress: Common.Address;
    walletAddress: Common.Address;
  } = req.body;
  try {
    const result = await getErc20Balance(data.chain, data.contractAddress, data.walletAddress, OnchainPriority.HIGH);
    res.json({ balance: result });
  } catch (e) {
    res.sendStatus(500);
    console.error("An error occurred getting the ERC20 balance", e);
  }
});

app.post('/getBlockNumber', express.json(), async (req, res) => {
  const data: {
    chain: Models.Contract.ChainIdentifier;
  } = req.body;
  try {
    const result = await getBlockNumber(data.chain);
    res.json({ blockNumber: result });
  } catch (e) {
    res.sendStatus(500);
    console.error("An error occurred getting the block number", e);
  }
});

app.listen(4000);

(async () => {
  if (process.env.RECALCULATE_BALANCES_AND_ROLES === "true") {
    const startTime = Date.now();
    const communityRoles = await pool.query(`
      SELECT
        c.id AS "communityId",
        c.title AS "communityTitle",
        r.id AS "roleId",
        r.title AS "roleTitle",
        r."assignmentRules",
        array_to_json((
          SELECT array_agg(u.id)
          FROM users u
          INNER JOIN roles_users_users ruu
            ON ruu."userId" = u.id
          INNER JOIN roles r
            ON ruu."roleId" = r.id
          WHERE r.title = ${format("%L", PredefinedRole.Member)}
            AND r."type" = ${format("%L", RoleType.PREDEFINED)}
            AND r."communityId" = c.id
        )) AS "memberUserIds"
      FROM communities c
      INNER JOIN roles r
        ON r."communityId" = c.id
        AND r."assignmentRules" IS NOT NULL
        AND r."deletedAt" IS NULL
      GROUP BY c.id, r.id
    `);

    const data = communityRoles.rows as {
      communityId: string;
      communityTitle: string;
      roleId: string;
      roleTitle: string;
      assignmentRules: Models.Community.AssignmentRules;
      memberUserIds: string[];
    }[];
    console.log(`No wallet balances exist in the database, re-evaluating ${data.length} roles`);

    const promises: Promise<any>[] = data.filter(
      d => d.assignmentRules.type === "token"
    ).map(async (d) => {
      let accessCounter = 0;
      const roleClaimPromises = d.memberUserIds.map(async (userId) => {
        const hasAccess = await checkRoleClaimability(
          userId,
          d.roleId,
          d.assignmentRules as Models.Community.AssignmentRules & { type: "token" },
          OnchainPriority.HIGH,
          'never',
        );
        if (hasAccess) {
          accessCounter++;
        }
        return {
          userId,
          hasAccess,
        };
      });
      const results = await Promise.all(roleClaimPromises);
      const allowedUserIds = results.filter(d => d.hasAccess === true).map(d => d.userId);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`
          DELETE FROM roles_users_users
          WHERE "roleId" = ${format("%L", d.roleId)}
        `);
        if (allowedUserIds.length > 0) {
          await client.query(`
            INSERT INTO roles_users_users
              ("userId", "roleId", claimed)
            VALUES ${allowedUserIds
              .map(userId => format(
                "(%L::UUID, %L::UUID, TRUE)",
                userId,
                d.roleId,
              ))
              .join(',')}
          `);
        }
        await client.query("COMMIT");
      }
      catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
      finally {
        client.release();
      }
      console.log(`Community ${d.communityTitle}, Role ${d.roleTitle}: Evaluating ${d.memberUserIds.length} users, ${accessCounter} have access`);
    });
    await Promise.all(promises);

    console.log("=========================================");
    console.log("=== DONE UPDATING ALL WALLET BALANCES");
    console.log(`=== used ${howManyUsedAPICallsForRoleClaimChecks()} api calls`);
    console.log(`=== took ${Math.floor((Date.now() - startTime) / 1000)} seconds`);
    console.log("=========================================");
  }
})();

fakeHealthcheck();

process.on("SIGTERM", async () => {
  process.exit(0);
});
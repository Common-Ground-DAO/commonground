// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import errors from "../common/errors";
import { WalletType } from "../common/enums";
import format from "pg-format";
import pool from "../util/postgres";
import { type Pool, type PoolClient } from "pg";
import { ethers } from "ethers";
import onchainHelper from "./onchain";
import stakingHelper from "./staking";
import { OnchainPriority } from "../onchain/scheduler";

type TypeMapping = {
  fuel: Models.Wallet.Wallet & { type: "fuel" };
  evm: Models.Wallet.Wallet & { type: "evm" };
  cg_evm: Models.Wallet.Wallet & { type: "cg_evm" };
  contract_evm: Models.Wallet.Wallet & { type: "contract_evm" };
}

type ToObjectType<T> = T extends keyof TypeMapping ? TypeMapping[T] : never;

export async function getExistingWalletData(dataSource: Pool | PoolClient, walletIdentifier: Models.Wallet.Wallet['walletIdentifier'], type: Models.Wallet.Wallet['type']) {
  const query = `
    SELECT
      "id",
      "walletIdentifier",
      "loginEnabled",
      "visibility",
      "userId",
      "createdAt",
      "updatedAt",
      "deletedAt"
    FROM wallets
    WHERE
      "walletIdentifier" = $1
      AND "type" = $2
  `;

  const result = await dataSource.query(query, [
    walletIdentifier.toLowerCase(),
    type,
  ]);
  return (result.rows[0] as {
    id: Models.Wallet.Wallet['id'];
    walletIdentifier: Models.Wallet.Wallet['walletIdentifier'];
    loginEnabled: boolean;
    visibility: Models.Wallet.Visibility;
    userId: Models.Wallet.Wallet['userId'];
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
  } | undefined) || null;
}

async function _createWallet(
  dataSource: Pool | PoolClient,
  data: Omit<Models.Wallet.Wallet, 'id'>,
) {
  let extraFields: string[] = [];
  const params: any[] = [
    data.userId,
    data.type,
    data.walletIdentifier.toLowerCase(),
    data.signatureData,
    data.chain,
  ];
  if ("loginEnabled" in data) {
    extraFields.push('"loginEnabled"');
    params.push(data.loginEnabled);
  }
  if ("visibility" in data) {
    extraFields.push('"visibility"');
    params.push(data.visibility);
  }
  const query = `
    INSERT INTO wallets (
      "userId",
      "type",
      "walletIdentifier",
      "signatureData",
      "chain"
      ${extraFields.length > 0 ? `,${extraFields.join(',')}` : ''}
    )
    VALUES (${params.map((p, i) => `$${i + 1}`).join(',')})
    ON CONFLICT ("type", "walletIdentifier")
    DO UPDATE SET
      "userId" = EXCLUDED."userId",
      "signatureData" = EXCLUDED."signatureData",
      "deletedAt" = NULL,
      "updatedAt" = now()
      ${extraFields.length > 0 ? `,${extraFields.map(field => `${field} = EXCLUDED.${field}`).join(',')}` : ''}
    RETURNING id
  `;
  const result = await dataSource.query(query, params);
  return result.rows[0] as {
    id: string;
  };
}

async function _updateWallet(
  dataSource: Pool | PoolClient,
  userId: string,
  data: API.User.updateWallet.Request,
): Promise<void> {
  const setArray: string[] = [];
  if (data.loginEnabled !== undefined) {
    setArray.push(`"loginEnabled" = ${!!data.loginEnabled ? 'TRUE' : 'FALSE'}`);
  }
  if (data.visibility !== undefined) {
    setArray.push(format('"visibility" = %L', data.visibility));
  }
  if (setArray.length === 0) {
    throw new Error(errors.server.INVALID_REQUEST);
  }
  const query = `
    UPDATE "wallets"
    SET
      "updatedAt" = now(),
      ${setArray.join(', ')}
    WHERE "id" = $1
      AND "userId" = $2
      AND "deletedAt" IS NULL
  `;
  const result = await dataSource.query(query, [
    data.id,
    userId,
  ]);
  if (result.rowCount !== 1) {
    // wrong userId or walletId
    throw new Error(errors.server.NOT_ALLOWED);
  }
}

async function _deleteWallet(
  dataSource: Pool | PoolClient,
  userId: string,
  data: API.User.deleteWallet.Request,
): Promise<void> {
  const query = `
    UPDATE "wallets"
    SET
      "updatedAt" = now(),
      "deletedAt" = now()
    WHERE "id" = $1
      AND "userId" = $2
      AND "deletedAt" IS NULL
  `;
  const result = await dataSource.query(query, [
    data.id,
    userId,
  ]);
  if (result.rowCount !== 1) {
    // wrong userId or walletId
    throw new Error(errors.server.NOT_ALLOWED);
  }
}

async function _getAllWalletsByUserId<T extends Models.Wallet.Type>(
  dataSource: Pool | PoolClient,
  userId: string,
  walletTypes: T[],
): Promise<ToObjectType<T>[]> {
  const query = `
    SELECT 
      "id",
      "userId",
      "type",
      "walletIdentifier",
      "loginEnabled",
      "visibility",
      "signatureData",
      "chain"
    FROM wallets
    WHERE "userId" = $1 
      AND "deletedAt" IS NULL
      AND "type" = ANY(${format('ARRAY[%L]::"public"."wallets_type_enum"[]', walletTypes)})
  `;
  const result = await dataSource.query(query, [userId]);
  return result.rows as any[];
  // Todo: Fixme later

  // return result.rows as {
  //   id: string;
  //   userId: string;
  //   type: WalletType;
  //   walletIdentifier: Common.Address;
  //   loginEnabled: boolean;
  //   visibility: Models.Wallet.Visibility,
  //   signatureData: Models.Wallet.Wallet["signatureData"]
  // }[];
}

class WalletHelper {
  public parseAndVerifySiweWalletData({
    data,
    signature,
  }: {
    data: API.User.SignableWalletData & { type: "evm" };
    signature: string;
  }) {
    const siweMessage = data.siweMessage;
    if (typeof siweMessage !== 'string') {
      throw new Error(errors.server.INVALID_REQUEST);
    }
    const result = this.parseAndVerifySiweData({ message: siweMessage, signature });

    if (result.address !== data.address.toLowerCase() || result.nonce !== data.secret) {
      throw new Error(errors.server.INVALID_SIGNATURE);
    }
    return result;
  }

  public parseAndVerifySiweData({ message, signature } : {
    message: string;
    signature: string;
  }) {
    const signer = ethers.verifyMessage(message, signature).toLowerCase() as Common.Address;
    const lines = message.split('\n');
    if (lines.length < 10) {
      throw new Error(errors.server.INVALID_REQUEST);
    }
    const address = lines[1].match(/^0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase() as Common.Address | undefined;
    const uri = lines[5].split('URI: ')[1];
    const version = lines[6].split('Version: ')[1];
    const chainId = lines[7].split('Chain ID: ')[1];
    const nonce = lines[8].split('Nonce: ')[1];
    const issuedAt = lines[9].split('Issued At: ')[1];

    if (!address || !uri || !version || !chainId || !nonce || !issuedAt) {
      throw new Error(errors.server.INVALID_REQUEST);
    }
    if (signer !== address) {
      throw new Error(errors.server.INVALID_SIGNATURE);
    }
    return {
      address,
      uri,
      version,
      chainId,
      nonce,
      issuedAt,
    };
  }

  public async prepareWalletAction(data: API.User.prepareWalletAction.Request, sessionUserId: string | null): Promise<Models.Server.Session.PreparedCredential> {
    let preWallet: Omit<Models.Wallet.Wallet, "id" | "userId"> | undefined;
    let walletExists = false;
    let walletValid = false;
    let readyForLogin = false;
    let readyForCreation = false;
    let isOwnWallet = false;
    let isDeleted = false;
    let isOlderThan7Days = false;
    let walletIdentifier: Models.Wallet.Wallet['walletIdentifier'] | undefined;
    let ownerId: string | undefined;

    let requestValid = true;
    try {
      if (data.data.type === WalletType.EVM) {
        let parsedSiweData: ReturnType<typeof this.parseAndVerifySiweWalletData> | undefined;
        parsedSiweData = this.parseAndVerifySiweWalletData({ data: data.data, signature: data.signature });
        walletValid = true;
        walletIdentifier = parsedSiweData.address;

      } else {
        requestValid = false;
        throw new Error(errors.server.INVALID_REQUEST);
      }
    }
    catch (e) {
      if (!requestValid) throw e;
    }

    if (walletValid && !!walletIdentifier) {
      if (data.data.type !== data.type && !(data.data.type === WalletType.EVM && data.type === WalletType.CG_EVM)) {
        throw new Error(errors.server.INVALID_REQUEST);
      }
      const existingWallet = await getExistingWalletData(pool, walletIdentifier, data.type);
        if (!!existingWallet) {
          walletExists = true;
          ownerId = existingWallet.userId;
          isDeleted = existingWallet.deletedAt !== null;
          readyForLogin = existingWallet.loginEnabled && !isDeleted;
          isOwnWallet = !!sessionUserId && sessionUserId === existingWallet.userId;
          isOlderThan7Days = new Date(existingWallet.updatedAt) < new Date(Date.now() - (7 * 24 * 60 * 60 * 1000));
        }
        if (!existingWallet || (!isOwnWallet && !readyForLogin) || (isOwnWallet && isDeleted)) {
          readyForCreation = true;
          preWallet = {
            type: data.data.type,
            loginEnabled: false,
            visibility: 'private',
            walletIdentifier,
            chain: null,
            signatureData: {
              data: data.data,
              signature: data.signature,
            },
          };
        }
    }

    return {
      type: "wallet",
      preWallet,
      ownerId,
      result: {
        walletExists,
        walletValid,
        readyForLogin,
        readyForCreation,
        isOwnWallet,
        isDeleted,
        isOlderThan7Days,
      },
    };
  }

  public async createWallet(userId: string, preWallet: Omit<Models.Wallet.Wallet, "id" | "userId">): Promise<Models.Wallet.Wallet> {
    const { id } = await _createWallet(pool, { ...preWallet, userId });
    await stakingHelper.syncClaimsForUser(userId).catch(e => {
      console.error("Error claiming staking positions after wallet link", e);
    });
    return {
      ...preWallet,
      userId,
      id,
    } as Models.Wallet.Wallet;
  }

  public async updateWallet(userId: string, data: API.User.updateWallet.Request): Promise<void> {
    await _updateWallet(pool, userId, data);
  }

  public async deleteWallet(userId: string, data: API.User.deleteWallet.Request): Promise<void> {
    const client = await pool.connect();
    let roleData: Awaited<ReturnType<typeof this._walletDeleted_clearBalancesAndGetAffectedRoles>> | undefined;
    await client.query("BEGIN");
    try {
      await _deleteWallet(client, userId, data);
      roleData = await this._walletDeleted_clearBalancesAndGetAffectedRoles(client, userId, data.id);
      await client.query("COMMIT");
    }
    catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
    finally {
      client.release();
    }
    await stakingHelper.syncClaimsForUser(userId).catch(e => {
      console.error("Error unclaiming staking positions after wallet delete", e);
    });
    if (roleData !== undefined && roleData.length > 0) {
      await onchainHelper.checkMultiRoleClaimability({ userId, roleData, priority: OnchainPriority.HIGH });
    }
  }

  public async fixRolesAndBalancesAfterWalletDelete(userId: string, walletId: string) {
    const roleData = await this._walletDeleted_clearBalancesAndGetAffectedRoles(pool, userId, walletId);
    if (roleData.length > 0) {
      await onchainHelper.checkMultiRoleClaimability({ userId, roleData, priority: OnchainPriority.MEDIUM });
    }
  }

  private async _walletDeleted_clearBalancesAndGetAffectedRoles(dataSource: Pool | PoolClient, userId: string, walletId: string) {
    const result = await pool.query<{
      roleId: string;
      communityId: string;
      assignmentRules: Models.Community.AssignmentRules;
      claimed: boolean;
    }>(`
      WITH delete_balances AS (
        DELETE FROM wallet_balances
        WHERE "walletId" = $1
        RETURNING "contractId"
      )
      SELECT
        r."id" AS "roleId",
        r."communityId",
        r."assignmentRules",
        ruu."claimed"
      FROM roles_contracts_contracts rcc
      INNER JOIN roles_users_users ruu
        ON  ruu."roleId" = rcc."rolesId"
        AND ruu."userId" = $2
      INNER JOIN roles r
        ON  r."id" = rcc."rolesId"
      WHERE rcc."contractsId" = ANY((SELECT "contractId" FROM delete_balances))
    `, [walletId, userId]);

    return result.rows.filter(row => row.assignmentRules?.type === "token").map(row => ({
      id: row.roleId,
      assignmentRules: row.assignmentRules as Models.Community.AssignmentRules & { type: "token" },
    }));
  }

  public async getWalletOwnerId(walletIdentifier: string) {
    const result = await pool.query(`
      SELECT "userId" FROM wallets
      WHERE "walletIdentifier" = $1 AND "deletedAt" IS NULL
    `, [walletIdentifier]);
    return result.rows[0]?.userId as string | undefined;
  }

  public async getAllWalletsByUserId<T extends Models.Wallet.Type>(
    userId: string,
    types: T[],
  ): Promise<ToObjectType<T>[]> {
    return await _getAllWalletsByUserId(pool, userId, types);
  }

  public async getWalletBalances(contractIds: string[], walletIds: string[]) {
    const result = await pool.query(`
      SELECT * FROM wallet_balances wb
      INNER JOIN wallets w ON wb."walletId" = w.id
      WHERE w."deletedAt" IS NULL
        AND wb."walletId" = ${format('ANY(ARRAY[%L]::UUID[])', walletIds)}
        AND wb."contractId" = ${format('ANY(ARRAY[%L]::UUID[])', contractIds)}
    `);
    return result.rows as {
      walletId: string;
      contractId: string;
      balance: Models.Contract.WalletBalance["balance"];
    }[];
  }

  public async getWalletContractBalances(data: {
    wallet: Common.Address;
    contract: Common.Address;
  }[], chain: Models.Contract.ChainIdentifier) {
    const result = await pool.query(`
      SELECT
        wb."walletId",
        w."walletIdentifier" AS "walletAddress",
        wb."contractId",
        c.address AS "contractAddress",
        wb.balance
      FROM wallet_balances wb
      INNER JOIN wallets w ON wb."walletId" = w.id
      INNER JOIN contracts c ON wb."contractId" = c."id"
      WHERE c.chain = ${format('%L', chain)}
        AND (w."walletIdentifier", c.address) IN (
          VALUES ${data.map(d =>
            format('(%L, %L)', d.wallet, d.contract)
          ).join(',')}
        )
    `);
    return result.rows as {
      walletId: string;
      walletAddress: Common.Address;
      contractId: string;
      contractAddress: Common.Address;
      balance: Models.Contract.WalletBalance["balance"];
    }[];
  }

  public async getWalletBalancesByUser(userId: string, contractIds: string[]) {
    const result = await pool.query(`
      SELECT
        w.id AS "walletId",
        COALESCE(
          array_to_json(array_agg(json_build_object(
            'contractId', wb."contractId",
            'balance', wb.balance
          ))),
          '[]'::json
        ) AS balances
      FROM wallets w
      LEFT JOIN wallet_balances wb ON (
        wb."walletId" = w.id AND
        wb."contractId" = ${format('ANY(ARRAY[%L]::UUID[])', contractIds)}
      )
      WHERE w."deletedAt" IS NULL
        AND w."userId" = ${format('%L::uuid', userId)}
      GROUP BY w.id
    `);
    return result.rows as {
      walletId: string;
      balances: {
        contractId: string;
        balance: Models.Contract.WalletBalance["balance"];
      }[];
    }[];
  }

  public async upsertWalletBalances(data: Models.Contract.WalletBalance[]) {
    try {
      const result = await pool.query(`
        INSERT INTO wallet_balances ("walletId", "contractId", balance)
        VALUES ${data.map(d => format(
          "(%L::uuid, %L::uuid, %L::jsonb)",
          d.walletId,
          d.contractId,
          JSON.stringify(d.balance),
        )).join(',')}
        ON CONFLICT ("walletId", "contractId")
          DO UPDATE SET balance = EXCLUDED.balance, "updatedAt" = now()
      `);
      if (result.rowCount !== data.length) {
        console.warn(`Unexpected upsert rowCount result: ${result.rowCount} (expected ${data.length})`, data);
      }
    } catch (e) {
      console.log("UPSERT ERROR")
      console.log(data)
      throw e;
    }
  }

  public async getRoleAccessByWalletsAndContracts(chain: Models.Contract.ChainIdentifier, data: {
    walletId: string;
    contractId: string;
  }[]) {
    if (data.length === 0) {
      return [];
    }
    const query = `
      SELECT
        w."userId",
        r."id" AS "roleId",
        ruu.claimed,
        r."assignmentRules",
        array_to_json(array_agg(json_build_object(
          'id', c."id",
          'address', c."address"
        ))) as "contracts"
      FROM wallets w
      INNER JOIN roles_users_users ruu
        ON ruu."userId" = w."userId"
      INNER JOIN roles_contracts_contracts rcc
        ON rcc."rolesId" = ruu."roleId"
      INNER JOIN contracts c
        ON c."id" = rcc."contractsId"
      INNER JOIN roles r
        ON rcc."rolesId" = r."id"
        AND r."deletedAt" IS NULL
      WHERE
        w."deletedAt" IS NULL AND
        (w.id, c.id) IN (
          VALUES ${data.map(d =>
            format('(%L::uuid, %L::uuid)', d.walletId, d.contractId)
          ).join(',')}
        )
      GROUP BY w."userId", r."id", r."assignmentRules", ruu.claimed
    `;
    const result = await pool.query(query);
    return result.rows as {
      userId: string;
      roleId: string;
      claimed: boolean;
      assignmentRules: Models.Community.AssignmentRules;
      contracts: {
        id: string;
        address: Common.Address;
      }[];
    }[];
  }

  public async _getAllContractWalletsByChain(chain: Models.Contract.ChainIdentifier) {
    const query = `
      SELECT
        "id" AS "walletId",
        "walletIdentifier",
        "signatureData"
      FROM wallets
      WHERE "chain" = $1
        AND "type" = 'contract_evm'
        AND "deletedAt" IS NULL
    `;
    const result = await pool.query<{
      walletId: string;
      walletIdentifier: string;
      signatureData: Models.Wallet.Wallet["signatureData"];
    }>(query, [chain]);
    return result.rows;
  }

  public async addPasskey(userId: string | null, passkeyData: Models.Passkey.FullData, counter: number) {
    const query = `
      INSERT INTO passkeys ("userId", "data", "counter")
      VALUES ($1, $2::jsonb, $3)
      RETURNING id
    `;
    const result = await pool.query(query, [userId, JSON.stringify(passkeyData), counter]);
    return result.rows[0].id as string;
  }

  public async updatePasskeyCounter(passkeyId: string, counter: number) {
    const query = `
      UPDATE passkeys
      SET counter = $1, "updatedAt" = now()
      WHERE id = $2
    `;
    const result = await pool.query(query, [counter, passkeyId]);
    if (result.rowCount !== 1) {
      throw new Error(errors.server.NOT_ALLOWED);
    }
  }

  public async getUserPasskeys(userId: string) {
    const query = `
      SELECT id, "createdAt", "updatedAt", data, counter
      FROM passkeys
      WHERE "userId" = $1
        AND "deletedAt" IS NULL
      ORDER BY "updatedAt" DESC
    `;
    const result = await pool.query<{
      id: string;
      createdAt: string;
      updatedAt: string;
      data: Models.Passkey.FullData;
      counter: number;
    }>(query, [userId]);
    return result.rows;
  }

  public async getPasskeyById(id: string) {
    const query = `
      SELECT
        id,
        "userId",
        data,
        counter,
        "updatedAt",
        "deletedAt"
      FROM passkeys
      WHERE id = $1
    `;
    const result = await pool.query<{
      id: string;
      userId: string | null;
      data: Models.Passkey.FullData;
      counter: number;
      updatedAt: string;
      deletedAt: string | null;
    }>(query, [id]);
    if (result.rows.length !== 1) {
      throw new Error(errors.server.NOT_FOUND);
    }
    return result.rows[0];
  }

  public async getPasskeyByCredentialIdAndWebAuthnUserId({ credentialID, webAuthnUserID }: {
    credentialID: string;
    webAuthnUserID: string;
  }) {
    const query = `
      SELECT
        id,
        "userId",
        data,
        counter,
        "updatedAt",
        "deletedAt"
      FROM passkeys
      WHERE data->>'credentialID' = $1
        AND data->>'webAuthnUserID' = $2
    `;
    const result = await pool.query<{
      id: string;
      userId: string | null;
      data: Models.Passkey.FullData;
      counter: number;
      updatedAt: string;
      deletedAt: string | null;
    }>(query, [credentialID, webAuthnUserID]);
    return result.rows.length > 0 ? result.rows[0] : null;
  }
}

const walletHelper = new WalletHelper();
export default walletHelper;
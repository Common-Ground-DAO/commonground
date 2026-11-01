// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { type Pool, type PoolClient } from "pg";
import errors from "../common/errors";
import { UserProfileTypeEnum } from "../common/enums";

/** linked accounts that can sign in (User/login twitter | lukso | farcaster) */
export const LOGIN_ACCOUNT_TYPES: ReadonlySet<string> = new Set<string>([
  UserProfileTypeEnum.TWITTER,
  UserProfileTypeEnum.LUKSO,
  UserProfileTypeEnum.FARCASTER,
]);

/**
 * The sign-in methods that work on this instance: passkeys of the process's
 * relying party, a password, login-enabled EVM wallets. (X, LUKSO and
 * Farcaster accounts can sign in too, but do not count: they are not methods
 * an account can be secured with here.) An account must never lose its last
 * one through its own actions.
 *
 * Both helpers lock the user row (`FOR UPDATE`), so they must run inside the
 * transaction that makes the change: two concurrent removals then cannot both
 * pass the check.
 */

export type LoginMethodExclusion = {
  /** a passkey about to be removed */
  passkeyId?: string;
  /** a wallet about to be removed or switched off as a login */
  walletId?: string;
};

export async function countLoginMethods(
  db: PoolClient,
  userId: string,
  rpId: string | null,
  except: LoginMethodExclusion = {},
): Promise<number> {
  await db.query(`SELECT "id" FROM users WHERE "id" = $1 FOR UPDATE`, [userId]);
  const result = await db.query<{ passkeys: string; password: boolean; wallets: string }>(`
    SELECT
      (SELECT COUNT(*) FROM passkeys
        WHERE "userId" = $1 AND "rpId" = $2 AND "deletedAt" IS NULL
          AND ($3::uuid IS NULL OR "id" <> $3::uuid)) AS "passkeys",
      COALESCE((SELECT "password" IS NOT NULL FROM users WHERE "id" = $1), FALSE) AS "password",
      (SELECT COUNT(*) FROM wallets
        WHERE "userId" = $1 AND "type" = 'evm' AND "loginEnabled" = TRUE AND "deletedAt" IS NULL
          AND ($4::uuid IS NULL OR "id" <> $4::uuid)) AS "wallets"
  `, [userId, rpId, except.passkeyId ?? null, except.walletId ?? null]);
  const row = result.rows[0];
  return Number(row.passkeys) + (row.password ? 1 : 0) + Number(row.wallets);
}

/** What the account-security step is derived from (srv/util/securityStep.ts). */
export type SecurityFacts = {
  email: string | null;
  emailVerified: boolean;
  hasPassword: boolean;
  passwordChangeRequired: boolean;
  /** passkeys of `rpId` */
  passkeys: number;
  /** login-enabled EVM wallets */
  loginWallets: number;
};

/** null: no such (live, human) account */
export async function getSecurityFacts(
  db: Pool | PoolClient,
  userId: string,
  rpId: string | null,
): Promise<SecurityFacts | null> {
  const result = await db.query<{
    email: string | null;
    emailVerified: boolean;
    hasPassword: boolean;
    passwordChangeRequired: boolean;
    passkeys: string;
    loginWallets: string;
  }>(`
    SELECT
      u."email",
      u."emailVerified",
      u."password" IS NOT NULL AS "hasPassword",
      u."passwordChangeRequired",
      (SELECT COUNT(*) FROM passkeys
        WHERE "userId" = u."id" AND "rpId" = $2 AND "deletedAt" IS NULL) AS "passkeys",
      (SELECT COUNT(*) FROM wallets
        WHERE "userId" = u."id" AND "type" = 'evm' AND "loginEnabled" = TRUE AND "deletedAt" IS NULL) AS "loginWallets"
    FROM users u
    WHERE u."id" = $1 AND u."deletedAt" IS NULL AND u.is_bot = FALSE
  `, [userId, rpId]);
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    email: row.email,
    emailVerified: row.emailVerified === true,
    hasPassword: row.hasPassword === true,
    passwordChangeRequired: row.passwordChangeRequired === true,
    passkeys: Number(row.passkeys),
    loginWallets: Number(row.loginWallets),
  };
}

/** Throws LAST_LOGIN_METHOD unless a method remains besides the excluded ones. */
export async function assertLoginMethodRemains(
  db: PoolClient,
  userId: string,
  rpId: string | null,
  except: LoginMethodExclusion = {},
): Promise<void> {
  if (await countLoginMethods(db, userId, rpId, except) === 0) {
    throw new Error(errors.server.LAST_LOGIN_METHOD);
  }
}

/**
 * For a change that turns off or removes the given wallet: throws
 * LAST_LOGIN_METHOD if the wallet is a working login method and nothing else
 * would remain. Locks the wallet row as well.
 */
export async function assertWalletIsNotLastLoginMethod(
  db: PoolClient,
  userId: string,
  rpId: string | null,
  walletId: string,
): Promise<void> {
  const wallet = await db.query<{ loginEnabled: boolean; type: string }>(`
    SELECT "loginEnabled", "type"
    FROM wallets
    WHERE "id" = $1 AND "userId" = $2 AND "deletedAt" IS NULL
    FOR UPDATE
  `, [walletId, userId]);
  const row = wallet.rows[0];
  if (row && row.loginEnabled && row.type === 'evm') {
    await assertLoginMethodRemains(db, userId, rpId, { walletId });
  }
}

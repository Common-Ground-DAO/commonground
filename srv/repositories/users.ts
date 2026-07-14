// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { User } from "../entities/users";
import errors from "../common/errors";
import { BotOwnerType, BotPlatformPresenceMode, UserProfileTypeEnum, PredefinedRole, PremiumRenewal, RoleType, UserPremiumFeatureName, WalletType, WalletVisibility } from "../common/enums";
import format from "pg-format";
import * as bcrypt from "bcrypt";
import { webcrypto } from "node:crypto";
import mailchimpClient from '@mailchimp/mailchimp_marketing';
import serverconfig from "../serverconfig";
import eventHelper from "./event";
import pool from "../util/postgres";
import { type Pool, type PoolClient } from "pg";
import { UserAccount } from "../entities/user-accounts";
import notificationHelper from "./notifications";
import { getDisplayNameString } from "../util";
import walletHelper from "./wallets";
import config from "../common/config";
import { addressRegex, calculateSupporterUpgradeCost } from "../common/util";

export type CreateUserAccountData = {
  displayName: string;
  imageId: string | null;
} & ({
  type: Extract<Models.User.ProfileItemType, "cg">;
  data: null;
  extraData: Models.User.UserAccountExtraData_CG;
} | {
  type: Extract<Models.User.ProfileItemType, "lukso">;
  data: Models.User.UserAccountData_Lukso;
  extraData: Models.User.UserAccountExtraData_Lukso;
} | {
  type: Extract<Models.User.ProfileItemType, "twitter">;
  data: Models.User.UserAccountData_Twitter;
  extraData: null;
} | {
  type: Extract<Models.User.ProfileItemType, "farcaster">;
  data: Models.User.UserAccountData_Farcaster;
  extraData: Models.User.UserAccountExtraData_Farcaster;
} | {
  type: Extract<Models.User.ProfileItemType, "bot">;
  data: null;
  extraData: null;
});

type CreateHumanUserAccountData = Exclude<CreateUserAccountData, { type: "bot" }>;

type CreateUserData = {
  devicePublicKey: any;
  email: string | null;
  activateNewsletter: boolean;
  password: string | null;
  passkeyId?: string;
  displayAccount: Exclude<Models.User.ProfileItemType, "bot">;
  wallet?: {
    walletIdentifier: Models.Wallet.Wallet['walletIdentifier'];
    type: Models.Wallet.Wallet["type"];
    signatureData: Models.Wallet.Wallet["signatureData"];
  };
  accounts: CreateHumanUserAccountData[];
};

type InternalCreateUserData = Omit<CreateUserData, "displayAccount" | "accounts"> & {
  displayAccount: Models.User.ProfileItemType;
  accounts: CreateUserAccountData[];
  isBot: boolean;
  bot?: {
    ownerType: Models.User.BotOwnerType;
    ownerId: string | null;
    platformPresenceMode: Models.User.BotPlatformPresenceMode | null;
    description: string | null;
  };
};

type CreateBotUserProfileData = {
  displayName: string;
  imageId: string | null;
  description: string | null;
};

export type CreateBotUserData = CreateBotUserProfileData & ({
  ownerType: 'community' | 'user';
  ownerId: string;
  platformPresenceMode?: never;
} | {
  ownerType: 'platform';
  ownerId: null;
  platformPresenceMode: Models.User.BotPlatformPresenceMode;
});

async function _hashPassword(password: string) {
  const generatedSalt = await bcrypt.genSalt(8);
  return await bcrypt.hash(password, generatedSalt);
}

async function _getSocialPreviewData(
  db: Pool | PoolClient,
  options: { userId: string } | { cgProfileName: string },
) {
  let CTE: string;
  if ('userId' in options) {
    CTE = `
      WITH user_id AS (
        SELECT ${format("%L::uuid", options.userId)} AS "userId"
      )
    `;
  }
  else {
    CTE = `
      WITH user_id AS (
        SELECT "userId"
        FROM user_accounts
        WHERE "type" = 'cg'
          AND LOWER("displayName") = ${format("LOWER(%L)", options.cgProfileName)}
          AND "deletedAt" IS NULL
      )
    `;
  }

  const query = `
    ${CTE}
    SELECT
      u."id",
      u."previewImageId",
      u."displayAccount",
      coalesce((SELECT json_agg(
        json_build_object(
          'type', ua."type",
          'displayName', ua."displayName",
          'imageId', ua."imageId",
          'extraData', ua."extraData"
        )
      ) from user_accounts ua WHERE ua."userId" = u."id" AND ua."deletedAt" IS NULL), '[]'::json) AS "accounts"
    FROM users u
    WHERE u."deletedAt" IS NULL
      AND u."id" = (SELECT "userId" FROM user_id)
  `;
  const result = await db.query<{
    id: string;
    previewImageId: string;
    displayAccount: Models.User.ProfileItemType;
    accounts: {
      type: Models.User.ProfileItemType;
      displayName: string;
      imageId: string | null;
      extraData: Models.User.UserAccountExtraData | null;
    }[];
  }>(query);
  if (result.rows.length === 1) {
    return result.rows[0];
  }
  return null;
}

async function _getUserData(
  db: Pool | PoolClient,
  data: {
    where: string;
    userId?: string;
    params?: any[];
  }
) {
  const query = `
    SELECT
      u."id",
      u.is_bot AS "isBot",
      u."createdAt",
      u."updatedAt",
      u."onlineStatus",
      u."bannerImageId",
      u."displayAccount",
      u."followingCount",
      u."followerCount",
      u."tags",
      coalesce((SELECT json_agg(
        json_build_object(
          'type', ua."type",
          'displayName', ua."displayName",
          'imageId', ua."imageId"
        )
      ) from user_accounts ua WHERE ua."userId" = u."id" AND ua."deletedAt" IS NULL), '[]'::json) AS "accounts",
      coalesce((SELECT json_agg(
        json_build_object(
          'featureName', up."featureName",
          'activeUntil', up."activeUntil"
        )
      ) from users_premium up WHERE up."userId" = u."id" AND up."activeUntil" > now()), '[]'::json) AS "premiumFeatures",
      ${!!data.userId
      ? `
        fl1."userId" IS NOT NULL AS "isFollower",
        fl2."userId" IS NOT NULL AS "isFollowed"`
      : `
        FALSE AS "isFollower",
        FALSE AS "isFollowed"`
    }
    FROM users u
    ${!!data.userId
      ? `
      LEFT JOIN followers fl1
        ON  fl1."userId" = u."id"
        AND fl1."otherUserId" = ${format("%L::uuid", data.userId)}
        AND fl1."deletedAt" IS NULL
      LEFT JOIN followers fl2
        ON fl2."userId" = ${format("%L::uuid", data.userId)}
        AND fl2."otherUserId" = u."id"
        AND fl2."deletedAt" IS NULL`
      : ''
    }
    WHERE ${data.where} ${data.where.length > 0 ? 'AND' : ''} u."deletedAt" IS NULL
  `;
  const result = await db.query(query, data.params);
  return result.rows as {
    id: string;
    isBot: boolean;
    verified: boolean;
    isFollower: boolean;
    isFollowed: boolean;
    createdAt: string;
    updatedAt: string;
    onlineStatus: Models.User.OnlineStatus;
    bannerImageId: string | null;
    displayAccount: Models.User.ProfileItemType;
    followingCount: number;
    followerCount: number;
    accounts: Models.User.ProfileItem[];
    tags: string[] | null;
    premiumFeatures: {
      featureName: Models.User.PremiumFeatureName;
      activeUntil: string;
    }[];
  }[];
}

async function _getUserProfileDetails(
  db: Pool | PoolClient,
  data: {
    callerId: string | null;
    targetUserId: string;
  },
) {
  const { callerId, targetUserId } = data;
  let callerCte = `
      target_follows_caller AS (
        SELECT 1
        WHERE FALSE
      )
    `;
  if (callerId !== null) {
    callerCte = `
      target_follows_caller AS (
        SELECT 1
        FROM followers
        WHERE "userId" = ${format("%L", targetUserId)}
          AND "otherUserId" = ${format("%L", callerId)}
          AND "deletedAt" IS NULL
      )
    `;
  }
  const query = `
    WITH ${callerCte}, select_profiles AS (
      SELECT
        ua."type",
        ua."displayName",
        ua."imageId",
        CASE
          WHEN ua."type" = 'bot' THEN jsonb_build_object(
            'type', 'bot',
            'description', b.description
          )
          ELSE ua."extraData"
        END AS "extraData"
      FROM user_accounts ua
      LEFT JOIN bots b ON b."userId" = ua."userId" AND ua."type" = 'bot'
      WHERE ua."userId" = $1
        AND ua."deletedAt" IS NULL
    ), select_wallets AS (
      SELECT
        "type",
        "visibility",
        "walletIdentifier",
        "chain"
      FROM wallets
      WHERE "userId" = $1
        AND "deletedAt" IS NULL
        AND CASE
          WHEN EXISTS (SELECT 1 FROM target_follows_caller)
          THEN "visibility" = ANY(ARRAY['public', 'followed']::public.wallets_visibility_enum[])
          ELSE "visibility" = 'public'::public.wallets_visibility_enum
        END
    )
    SELECT
      (SELECT coalesce(json_agg(json_build_object(
        'type', "type",
        'displayName', "displayName",
        'imageId', "imageId",
        'extraData', "extraData"
      )), '[]'::json) FROM select_profiles) AS "detailledProfiles",
      (SELECT coalesce(json_agg(json_build_object(
        'type', "type",
        'visibility', "visibility",
        'walletIdentifier', "walletIdentifier",
        'chain', "chain"
      )), '[]'::json) FROM select_wallets) AS "wallets"
  `;
  const queryResult = await db.query<{
    detailledProfiles: {
      type: Models.User.ProfileItemType;
      displayName: string;
      imageId: string | null;
      extraData: Models.User.UserAccountExtraData | null;
    }[];
    wallets: {
      type: Models.Wallet.Type;
      visibility: Models.Wallet.Visibility;
      walletIdentifier: Models.Wallet.WalletIdentifier;
      chain: Models.Contract.ChainIdentifier;
    }[];
  }>(query, [targetUserId]);
  if (queryResult.rows.length === 1) {
    const result = queryResult.rows[0];
    if (result.detailledProfiles.length > 0) return result;
  }
  throw new Error(errors.server.NOT_FOUND);
}

async function _getOwnData(
  db: Pool | PoolClient,
  data: {
    CTE?: string;
    where: string;
    params?: any[];
    extraFields?: string[];
  }
) {
  const query = `
    ${data.CTE ? data.CTE : ''}
    SELECT
      u."id",
      u.is_bot AS "isBot",
      u."communityOrder",
      u."finishedTutorials",
      u."newsletter",
      u."weeklyNewsletter",
      u."dmNotifications",
      u."email",
      u."followingCount",
      u."followerCount",
      u."createdAt",
      u."updatedAt",
      u."onlineStatus",
      u."bannerImageId",
      u."displayAccount",
      u."features",
      u."pointBalance",
      u."trustScore",
      u."emailVerified",
      u."extraData",
      u."tags",
      coalesce((SELECT json_agg(
        json_build_object(
          'type', ua."type",
          'displayName', ua."displayName",
          'imageId', ua."imageId",
          'extraData', ua."extraData"
        )
      ) FROM user_accounts ua WHERE ua."userId" = u."id" AND ua."deletedAt" IS NULL), '[]'::json) AS "accounts",
      coalesce((SELECT json_agg(
        json_build_object(
          'credentialID', upk."data"->>'credentialID',
          'credentialBackedUp', upk."data"->>'credentialBackedUp',
          'credentialDeviceType', upk."data"->>'credentialDeviceType',
          'createdAt', upk."createdAt",
          'updatedAt', upk."updatedAt"
        )
      ) FROM (
        SELECT "createdAt", "updatedAt", "data"
        FROM passkeys
        WHERE "userId" = u."id"
          AND "deletedAt" IS NULL
        ORDER BY "updatedAt" DESC
      ) AS upk), '[]'::json) AS "passkeys",
      coalesce((SELECT json_agg(
        json_build_object(
          'featureName', up."featureName",
          'activeUntil', up."activeUntil",
          'autoRenew', up."autoRenew"
        )
      ) FROM users_premium up WHERE up."userId" = u."id" AND up."activeUntil" > now()), '[]'::json) AS "premiumFeatures"
      ${data.extraFields ? `,${data.extraFields.join(',')}` : ''}
    FROM users u
    WHERE ${data.where.length > 0 ? `${data.where} AND` : ''} u."deletedAt" IS NULL
  `;
  const result = await db.query(query, data.params);
  // FIXME: Return first result for now since we don't enforce email uniqueness
  if (result.rows.length > 0) {
    return result.rows[0] as {
      id: string;
      isBot: boolean;
      communityOrder: string[];
      finishedTutorials: Models.User.TutorialName[];
      newsletter: boolean;
      weeklyNewsletter: boolean;
      dmNotifications: boolean;
      email: string | null;
      followingCount: number;
      followerCount: number;
      createdAt: string;
      updatedAt: string;
      onlineStatus: Models.User.OnlineStatus;
      bannerImageId: string | null;
      displayAccount: Models.User.ProfileItemType;
      accounts: Models.User.ProfileItemWithDetails[];
      features: Models.User.UserFeatures;
      pointBalance: number;
      trustScore: string;
      extraData: Models.User.ExtraData;
      tags: string[] | null;
      passkeys: {
        credentialID: string;
        credentialBackedUp: boolean;
        credentialDeviceType: string;
        createdAt: string;
        updatedAt: string;
      }[];
      premiumFeatures: {
        featureName: Models.User.PremiumFeatureName;
        activeUntil: string;
        autoRenew: Common.PremiumRenewal | null;
      }[];
      emailVerified: boolean;
    };
  } else {
    throw new Error(errors.server.NOT_FOUND);
  }
}

async function _createUser(
  db: PoolClient,
  data: InternalCreateUserData,
) {
  const botAccounts = data.accounts.filter(account => account.type === 'bot');
  if (data.isBot) {
    if (
      !data.bot ||
      data.displayAccount !== 'bot' ||
      botAccounts.length !== 1 ||
      data.accounts.length !== 1 ||
      data.email !== null ||
      data.password !== null ||
      data.activateNewsletter ||
      data.passkeyId !== undefined ||
      data.wallet !== undefined
    ) {
      console.error("Error creating bot user, bot invariants not satisfied");
      throw new Error(errors.server.INVALID_REQUEST);
    }
  }
  else if (data.bot || data.displayAccount === 'bot' || botAccounts.length > 0) {
    console.error("Error creating human user with bot-only data");
    throw new Error(errors.server.INVALID_REQUEST);
  }

  const { password, wallet, accounts, passkeyId } = data;
  let passwordHash: string | null = null;
  if (password !== null) {
    passwordHash = await _hashPassword(password);
  }
  const params: any[] = [
    data.email,
    data.activateNewsletter,
    passwordHash,
    data.displayAccount,
    data.isBot,
  ];
  let query = `
    WITH create_user AS (
      INSERT INTO users (
        "email",
        "newsletter",
        "password",
        "displayAccount",
        "is_bot"
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING "id", "updatedAt"
    )
  `;
  if (passkeyId) {
    const baseParamsLength = params.length;
    params.push(passkeyId);
    query += `,
      update_passkey AS (
        UPDATE passkeys
        SET "userId" = (SELECT "id" FROM create_user)
        WHERE "id" = $${baseParamsLength + 1}
          AND "userId" IS NULL
        RETURNING json_build_object(
          'credentialID', "data"->>'credentialID',
          'credentialBackedUp', "data"->>'credentialBackedUp',
          'credentialDeviceType', "data"->>'credentialDeviceType',
          'createdAt', "createdAt",
          'updatedAt', "updatedAt"
        ) AS "passkeyData"
      )
    `;
  }
  else {
    query += `,
      update_passkey AS (SELECT NULL AS "passkeyData")
    `;
  }
  if (!!wallet) {
    if (wallet.type === "cg_evm") {
      throw new Error(errors.server.NOT_ALLOWED);
    }
    const baseParamsLength = params.length;
    params.push(
      wallet.type,
      true,
      wallet.type === 'aeternity' ? wallet.walletIdentifier : wallet.walletIdentifier.toLowerCase(),
      JSON.stringify(wallet.signatureData),
    );
    query += `,
      create_wallet AS (
        INSERT INTO wallets (
          "userId",
          "type",
          "loginEnabled",
          "walletIdentifier",
          "signatureData"
        )
        VALUES (
          (SELECT "id" FROM create_user),
          $${baseParamsLength + 1}, $${baseParamsLength + 2}, $${baseParamsLength + 3}, $${baseParamsLength + 4}::jsonb
        )
        ON CONFLICT ("type", "walletIdentifier", "chain")
        DO UPDATE SET
          "userId" = EXCLUDED."userId",
          "loginEnabled" = EXCLUDED."loginEnabled",
          "signatureData" = EXCLUDED."signatureData",
          "deletedAt" = NULL,
          "updatedAt" = now()
      )
    `;
  }
  if (!!accounts && accounts.length > 0) {
    const usedTypes = new Set<string>();
    for (const account of accounts) {
      if (usedTypes.has(account.type)) {
        console.error("Cannot create an account type more than once on user create", JSON.stringify(account));
        throw new Error(errors.server.INVALID_REQUEST);
      }
      usedTypes.add(account.type);
      if (!Object.values(UserProfileTypeEnum).includes(account.type as UserProfileTypeEnum)) {
        throw new Error(`Invalid account type: ${account.type}`);
      }

      const baseParamsLength = params.length;
      params.push(
        account.type,
        account.displayName,
        account.imageId,
        account.data !== null ? JSON.stringify(account.data) : null,
        account.extraData !== null ? JSON.stringify(account.extraData) : null,
      );
      query += `,
        create_account${`_`+ account.type} AS (
          INSERT INTO user_accounts (
            "userId",
            "type",
            "displayName",
            "imageId",
            "data",
            "extraData"
          )
          VALUES (
            (SELECT "id" FROM create_user),
            $${baseParamsLength + 1}, $${baseParamsLength + 2}, $${baseParamsLength + 3}, $${baseParamsLength + 4}::jsonb, $${baseParamsLength + 5}::jsonb
          )
        )
      `;
      if (account.type === 'lukso') {
        if (!account.data?.id.match(addressRegex)) {
          console.error('Invalid lukso account id, needs to be a valid contract address', account.data?.id);
          throw new Error(errors.server.INVALID_REQUEST);
        }

        const baseParamsLength = params.length;
        params.push(
          account.data.id.toLowerCase(),
          JSON.stringify({ data: null, signature: '' }),
        );
        query += `,
          create_lukso_up_wallet AS (
            INSERT INTO wallets (
              "userId",
              "type",
              "walletIdentifier",
              "signatureData",
              "chain",
              "visibility"
            )
            VALUES (
              (SELECT "id" FROM create_user),
              'contract_evm',
              $${baseParamsLength + 1},
              $${baseParamsLength + 2}::jsonb,
              'lukso',
              'public'
            )
            ON CONFLICT ("type", "walletIdentifier", "chain")
            DO UPDATE SET
              "userId" = EXCLUDED."userId",
              "signatureData" = EXCLUDED."signatureData",
              "visibility" = 'public',
              "deletedAt" = NULL,
              "updatedAt" = now()
          )
        `;
      }
    }
  }
  if (
    !data.isBot &&
    !("wallet" in data) &&
    !data.password &&
    !data.accounts.find(a => a.type !== 'cg') &&
    !data.email &&
    !data.passkeyId
  ) {
    console.error("Error creating user, no wallet, password, accounts, email or passkeyId", data);
    throw new Error(errors.server.INVALID_REQUEST);
  }

  params.push(data.devicePublicKey);
  const devicePublicKeyParam = params.length;
  query += `
    , create_device AS (
      INSERT INTO devices ("userId", "publicKey")
      VALUES ((SELECT "id" FROM create_user), $${devicePublicKeyParam})
      RETURNING "id" AS "deviceId"
    )
  `;
  if (data.isBot && data.bot) {
    params.push(data.bot.ownerType, data.bot.ownerId, data.bot.platformPresenceMode, data.bot.description);
    const ownerTypeParam = devicePublicKeyParam + 1;
    query += `,
      create_bot AS (
        INSERT INTO bots (
          "userId",
          "deviceId",
          "ownerType",
          "ownerId",
          "platformPresenceMode",
          "description"
        )
        VALUES (
          (SELECT "id" FROM create_user),
          (SELECT "deviceId" FROM create_device),
          $${ownerTypeParam},
          $${ownerTypeParam + 1},
          $${ownerTypeParam + 2},
          $${ownerTypeParam + 3}
        )
        RETURNING "userId"
      )
    `;
  }
  query += `
    SELECT
      (SELECT "deviceId" FROM create_device) AS "deviceId",
      (SELECT "id" FROM create_user) AS "userId",
      (SELECT "updatedAt" FROM create_user) AS "updatedAt",
      (SELECT "passkeyData" FROM update_passkey) AS "passkeyData"
    ${data.isBot ? 'WHERE EXISTS (SELECT 1 FROM create_bot)' : ''}
  `;
  const result = await db.query<{
    deviceId: string;
    userId: string;
    updatedAt: string;
    passkeyData: {
      credentialID: string;
      credentialBackedUp: boolean;
      credentialDeviceType: string;
      createdAt: string;
      updatedAt: string;
    } | null;
  }>(query, params);
  if (result.rows.length === 1) {
    if (passkeyId && !result.rows[0].passkeyData) {
      console.error("Error creating user, passkeyId provided but no passkey result data", data);
      throw new Error(errors.server.INVALID_REQUEST);
    }
    return result.rows[0];
  }
  console.error("Error creating user, no result rows", data);
  throw new Error(errors.server.INVALID_REQUEST);
}

function __userWithNotifyIdsQuery(cteName: string) {
  return `
    SELECT
      u.id AS "userId",
      now() AS "updatedAt",
      COALESCE(
        (
          SELECT json_agg(r."communityId")
          FROM roles_users_users ruu
          INNER JOIN roles r
            ON ruu."roleId" = r."id"
            AND r."type" = ${format("%L", RoleType.PREDEFINED)}
            AND r."title" = ${format("%L", PredefinedRole.Member)}
          WHERE ruu."userId" = u."id"
        ),
        '[]'::json
      ) AS "communityIds"
    FROM users u
    WHERE u.id = ANY((SELECT id FROM ${cteName}))
  `;
}

type UserWithNotifyIds = {
  userId: string;
  updatedAt: string;
  communityIds: string[];
};

async function _updateUser(
  db: Pool | PoolClient,
  data: Partial<Pick<User,
    "password" |
    "previewImageId" |
    "bannerImageId" |
    "email" |
    "finishedTutorials" |
    "newsletter" |
    "communityOrder" |
    "displayAccount" |
    "trustScore" |
    "dmNotifications"
  >> & Pick<User, "id">
) {
  let i = 2;
  const setArray: string[] = ['"updatedAt" = now()'];
  const params: any[] = [data.id];
  let CTE = `
    WITH update_allowed AS (
      SELECT 1
    )
  `;
  for (const prop of (Object.keys(data) as (keyof typeof data)[])) {
    if (prop === "password") {
      params.push(await _hashPassword(data.password as string));
      setArray.push(format(`%I = $${i++}`, prop));
    }
    else if (["createdAt", "updatedAt"].includes(prop)) {
      throw new Error(errors.server.NOT_ALLOWED);
    }
    else if (prop === "displayAccount") {
      CTE = `
        WITH update_allowed AS (
          SELECT 1
          FROM user_accounts
          WHERE "userId" = $1
            AND "type" = ${format("%L", data.displayAccount)}
            AND "deletedAt" IS NULL
        )
      `;
      params.push(data[prop]);
      setArray.push(format(`%I = $${i++}`, prop));
    }
    else if (prop !== "id") {
      params.push(data[prop]);
      setArray.push(format(`%I = $${i++}`, prop));
    }
  }
  const query = `
    ${CTE},
    update_user AS (
      UPDATE users
      SET ${setArray.join(',')}
      WHERE "id" = $1
        AND EXISTS (SELECT 1 FROM update_allowed)
      RETURNING id
    )
    ${__userWithNotifyIdsQuery('update_user')}
  `;
  if (setArray.length < 2 || !data.id) {
    throw new Error(errors.server.INVALID_REQUEST);
  }
  const result = await db.query(query, params);
  if (result.rowCount !== 1) {
    throw new Error(errors.server.INVALID_REQUEST);
  }
  return result.rows[0] as UserWithNotifyIds;
}

async function _addUserAccount(
  db: Pool | PoolClient,
  userId: string,
  account: CreateHumanUserAccountData,
): Promise<Pick<UserAccount, "type" | "displayName" | "imageId" | "extraData">[]> {
  const query = `
    WITH insert_account AS (
      INSERT INTO user_accounts (
        "userId",
        "type",
        "displayName",
        "imageId",
        "data",
        "extraData"
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
      ON CONFLICT ("userId", "type") DO UPDATE
        SET
          "data" = EXCLUDED."data",
          "displayName" = EXCLUDED."displayName",
          "imageId" = EXCLUDED."imageId",
          "extraData" = EXCLUDED."extraData",
          "deletedAt" = NULL,
          "createdAt" = CASE WHEN user_accounts."deletedAt" IS NULL THEN user_accounts."createdAt" ELSE NOW() END,
          "updatedAt" = NOW()
      RETURNING "userId"
    )
    SELECT
      "type",
      "displayName",
      "imageId",
      "extraData"
    FROM user_accounts ua
    WHERE ua."userId" = (SELECT "userId" from insert_account) AND ua."deletedAt" IS NULL
  `;

  const params = [
    userId,
    account.type,
    account.displayName,
    account.imageId,
    account.data === null ? null : JSON.stringify(account.data),
    account.extraData === null ? null : JSON.stringify(account.extraData),
  ];

  const result = await db.query(query, params);
  return result.rows as {
    type: UserProfileTypeEnum;
    displayName: string;
    imageId: string | null;
    extraData: Models.User.UserAccountExtraData | null;
  }[];
}

async function _removeUserAccount(
  db: Pool | PoolClient,
  userId: string,
  accountType: UserProfileTypeEnum,
) {
  const query = `
    WITH update_allowed AS (
      SELECT 1
      FROM users
      WHERE "id" = $1
        AND "displayAccount" <> ${format("%L", accountType)}
    )
    UPDATE user_accounts ua
    SET
      "updatedAt" = NOW(),
      "deletedAt" = NOW()
    WHERE "userId" = $1
      AND "deletedAt" IS NULL
      AND "type" = $2
      AND EXISTS (SELECT 1 FROM update_allowed)
    RETURNING
      "data"
  `;
  const params = [
    userId,
    accountType,
  ];
  const result = await db.query(query, params);
  if (result.rows.length !== 1) {
    throw new Error(errors.server.INVALID_REQUEST);
  }
  return result.rows[0] as {
    data: Models.User.UserAccountData | null;
  };
}

async function _getUserDetailledAccounts(
  db: Pool | PoolClient,
  userId: string,
): Promise<Pick<UserAccount, "type" | "displayName" | "imageId" | "extraData">[]> {
  const query = `
    SELECT
      "type",
      "displayName",
      "imageId",
      "extraData"
    FROM user_accounts ua
    WHERE ua."userId" = $1
      AND ua."deletedAt" IS NULL
  `;
  const params = [userId];
  const result = await db.query<{
    type: UserProfileTypeEnum;
    displayName: string;
    imageId: string | null;
    extraData: Models.User.UserAccountExtraData | null;
  }>(query, params);
  return result.rows;
}

async function _addUserFeatures(
  db: Pool | PoolClient,
  userId: string,
  features: Partial<Models.User.UserFeatures>,
) {
  const params: any[] = [userId, features];

  const query = `
    UPDATE users
    SET "updatedAt" = now(), features = COALESCE(features, '{}'::jsonb) || $2::jsonb
    WHERE "id" = $1
    RETURNING features
  `;

  const result = await db.query(query, params);
  if (result.rowCount !== 1) {
    throw new Error(errors.server.INVALID_REQUEST);
  }
  return result.rows[0].features as Models.User.UserFeatures;
}

async function _addContractWallet(
  db: Pool | PoolClient,
  userId: string,
  contractAddress: Common.Address,
  contractData: Models.Wallet.ContractWalletData,
  chain: Models.Contract.ChainIdentifier,
  visibility: Models.Wallet.Visibility,
) {
  const existing = await db.query<{
    id: string;
    deletedAt: string | null;
  }>(`
    SELECT "id", "deletedAt" FROM wallets
    WHERE "walletIdentifier" = $1
      AND "chain" = $2
      AND "type" = 'contract_evm'
  `, [
    contractAddress.toLowerCase(),
    chain,
  ]);
  const __signatureData: Models.Wallet.Wallet['signatureData'] = {
    data: null,
    signature: '',
    contractData,
  };
  const signatureData = JSON.stringify(__signatureData);
  if (existing.rows.length > 0) {
    if (existing.rows[0].deletedAt === null) {
      throw new Error(errors.server.EXISTS_ALREADY);
    }
    await db.query(`
      UPDATE wallets
      SET
        "userId" = $1,
        "deletedAt" = NULL,
        "updatedAt" = now(),
        "signatureData" = $3::jsonb,
        "visibility" = $4
      WHERE "id" = $2
    `, [
      userId,
      existing.rows[0].id,
      signatureData,
      visibility,
    ]);
    return;
  }
  else {
    const query = `
      INSERT INTO wallets (
        "userId",
        "type",
        "walletIdentifier",
        "chain",
        "signatureData",
        "visibility"
      )
      VALUES (
        $1,
        'contract_evm',
        $2,
        $3,
        $4::jsonb,
        $5
      )
    `;
    const params = [
      userId,
      contractAddress.toLowerCase(),
      chain,
      signatureData,
      visibility,
    ];
    await db.query(query, params);
  }
}

async function _removeContractWallet(
  db: Pool | PoolClient,
  userId: string,
  contractAddress: Common.Address,
  chain: Models.Contract.ChainIdentifier,
) {
  const query = `
    UPDATE wallets
    SET
      "deletedAt" = NOW(),
      "updatedAt" = NOW()
    WHERE "userId" = $1
      AND "walletIdentifier" = $2
      AND "chain" = $3
      AND "type" = 'contract_evm'
  `;
  const params = [
    userId,
    contractAddress.toLowerCase(),
    chain,
  ];
  await db.query(query, params);
}

async function _isCgProfileNameAvailable(
  db: Pool | PoolClient,
  displayName: string
): Promise<boolean> {
  const query = `
    SELECT 1 FROM user_accounts
    WHERE "type" = 'cg'
      AND LOWER("displayName") = LOWER($1)
  `;
  const result = await db.query(query, [displayName]);
  return result.rowCount === 0;
}

async function _isEmailAvailable(
  db: Pool | PoolClient,
  email: string
): Promise<boolean> {
  const query = `
    SELECT 1 FROM users
    WHERE LOWER(email) = LOWER($1)
  `;
  const result = await db.query(query, [email]);
  return result.rowCount === 0;
}

async function _followUser(
  db: Pool | PoolClient,
  userId: string,
  otherUserId: string
) {
  const query = `
    WITH insert_relation AS (
      INSERT INTO followers ("userId", "otherUserId")
      VALUES ($1, $2)
      RETURNING 1
    ), update_user AS (
      UPDATE users
      SET
        "followingCount" = "followingCount" + 1,
        "updatedAt" = now()
      WHERE id = $1
        AND EXISTS (SELECT 1 FROM insert_relation)
      RETURNING "followingCount"
    ), update_other_user AS (
      UPDATE users
      SET
        "followerCount" = "followerCount" + 1,
        "updatedAt" = now()
      WHERE id = $2
        AND EXISTS (SELECT 1 FROM insert_relation)
      RETURNING "followerCount"
    )
    SELECT uu."followingCount", uou."followerCount"
    FROM update_user uu
    CROSS JOIN update_other_user uou
  `;
  const result = await db.query(query, [userId, otherUserId]);
  if (result.rows.length === 1) {
    return result.rows[0] as { followerCount: number, followingCount: number };
  }
  throw new Error(errors.server.EXISTS_ALREADY);
}

async function _unfollowUser(
  db: Pool | PoolClient,
  userId: string,
  otherUserId: string
) {
  const query = `
    WITH del_query AS (
      DELETE FROM followers
      WHERE "userId" = $1 AND "otherUserId" = $2
      RETURNING 1
    ), update_user AS (
      UPDATE users SET "followingCount" = "followingCount" - 1
      WHERE id = $1 AND EXISTS (SELECT 1 FROM del_query)
      RETURNING "followingCount"
    ), update_other_user AS (
      UPDATE users SET "followerCount" = "followerCount" - 1
      WHERE id = $2 AND EXISTS (SELECT 1 FROM del_query)
      RETURNING "followerCount"
    )
    SELECT uu."followingCount", uou."followerCount"
    FROM update_user uu
    CROSS JOIN update_other_user uou
  `;
  const result = await db.query(query, [userId, otherUserId]);
  if (result.rows.length === 1) {
    return result.rows[0] as { followerCount: number, followingCount: number };
  }
  throw new Error(errors.server.NOT_FOUND);
}

async function _validateBotOwner(
  db: PoolClient,
  ownerType: Models.User.BotOwnerType,
  ownerId: string | null,
) {
  if (!Object.values(BotOwnerType).includes(ownerType as BotOwnerType)) {
    throw new Error(errors.server.INVALID_REQUEST);
  }
  if (ownerType === BotOwnerType.PLATFORM) {
    if (ownerId !== null) {
      throw new Error(errors.server.INVALID_REQUEST);
    }
    return;
  }
  if (ownerId === null) {
    throw new Error(errors.server.INVALID_REQUEST);
  }

  const result = ownerType === BotOwnerType.COMMUNITY
    ? await db.query(`
        SELECT 1
        FROM communities
        WHERE "id" = $1
          AND "deletedAt" IS NULL
      `, [ownerId])
    : await db.query(`
        SELECT 1
        FROM users
        WHERE "id" = $1
          AND "is_bot" = FALSE
          AND "deletedAt" IS NULL
      `, [ownerId]);
  if (result.rowCount !== 1) {
    throw new Error(errors.server.INVALID_REQUEST);
  }
}

async function _createBotDevicePublicKey(): Promise<JsonWebKey> {
  const keyPair = await webcrypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-384',
    },
    true,
    ['sign', 'verify'],
  );
  return await webcrypto.subtle.exportKey('jwk', keyPair.publicKey);
}

class UserHelper {
  public async createUser(data: CreateUserData, awaitBeforeCommit?: () => Promise<void>) {
    if (data.accounts) {
      for(const account of data.accounts) {
        if (account.type === 'twitter') {
          if (!account.data?.id) {
            console.error("Error creating user with twitter account, no id", account);
            throw new Error(errors.server.INVALID_REQUEST);
          }
          await this._checkUniqueTwitter(pool, account.data.id);
        }

        if (account.type === 'lukso') {
          if (!account.data?.id) {
            console.error("Error creating user with lukso account, no id", account);
            throw new Error(errors.server.INVALID_REQUEST);
          }
          await this._checkUniqueUniversalProfile(pool, account.data.id);
        }
      }
    }

    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const result = await _createUser(client, {
        ...data,
        isBot: false,
      });
      if (awaitBeforeCommit) {
        await awaitBeforeCommit();
      }
      await client.query("COMMIT");
      return result;
    }
    catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
    finally {
      client.release();
    }
  }

  private async _createBotUserInTransaction(client: PoolClient, data: CreateBotUserData) {
    if (
      data.displayName.trim().length === 0 ||
      data.displayName.length > 255 ||
      (data.description !== null && data.description.length > 2000) ||
      (data.ownerType === BotOwnerType.PLATFORM
        && !Object.values(BotPlatformPresenceMode).includes(data.platformPresenceMode as BotPlatformPresenceMode))
    ) {
      throw new Error(errors.server.INVALID_REQUEST);
    }
    const devicePublicKey = await _createBotDevicePublicKey();
    await _validateBotOwner(client, data.ownerType, data.ownerId);
    return await _createUser(client, {
      devicePublicKey,
      email: null,
      activateNewsletter: false,
      password: null,
      displayAccount: UserProfileTypeEnum.BOT,
      accounts: [{
        type: UserProfileTypeEnum.BOT,
        displayName: data.displayName,
        imageId: data.imageId,
        data: null,
        extraData: null,
      }],
      isBot: true,
      bot: {
        ownerType: data.ownerType,
        ownerId: data.ownerId,
        platformPresenceMode: data.ownerType === BotOwnerType.PLATFORM ? data.platformPresenceMode : null,
        description: data.description,
      },
    });
  }

  public async createBotUserInTransaction(client: PoolClient, data: CreateBotUserData) {
    return await this._createBotUserInTransaction(client, data);
  }

  public async createBotUser(data: CreateBotUserData) {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const result = await this._createBotUserInTransaction(client, data);
      await client.query("COMMIT");
      return result;
    }
    catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
    finally {
      client.release();
    }
  }

  public async getOwnDataByCgProfileNameOrEmailAndPassword(cgProfileNameOrEmail: string, password: string): Promise<Models.User.OwnData> {
    let options: Parameters<typeof _getOwnData>[1];
    if (cgProfileNameOrEmail.indexOf('@') > -1) {
      options = {
        where: 'u."email" = $1',
        extraFields: ['u."password"'],
        params: [cgProfileNameOrEmail],
      };
    }
    else {
      options = {
        CTE: `
          WITH user_id AS (
            SELECT "userId"
            FROM user_accounts
            WHERE "type" = 'cg'
              AND LOWER("displayName") = ${format("LOWER(%L)", cgProfileNameOrEmail)}
              AND "deletedAt" IS NULL
          )
        `,
        where: 'u."id" = (SELECT "userId" FROM user_id)',
        extraFields: ['u."password"'],
      };
    }
    const result = await _getOwnData(pool, options);
    const passwordHash: string = (result as any).password;
    const passwordCorrect = await bcrypt.compare(password, passwordHash);
    if (passwordCorrect) {
      delete (result as any).password;
      return result;
    }
    throw new Error(errors.server.NOT_ALLOWED);
  }

  public async getOwnDataById(userId: string): Promise<Models.User.OwnData> {
    const result = await _getOwnData(pool, {
      where: 'u."id" = $1',
      params: [userId]
    });
    return result;
  }

  public async getUserByAccount(accountType: Exclude<Models.User.ProfileItemType, "cg" | "bot">, accountId: string): Promise<Models.User.OwnData> {
    const query = `
      SELECT "userId"
      FROM user_accounts ua WHERE
        ua."type" = $1 AND
        ${accountType === 'lukso' ? `LOWER(ua."data"->>'id') = LOWER($2)` : `ua."data"->>'id' = $2`} AND
        ua."deletedAt" IS NULL
    `;
    const params = [accountType, accountId];
    const result = await pool.query<{ userId: string; }>(query, params);
    if (result.rows.length === 0) {
      throw new Error(errors.server.ACCOUNT_DOES_NOT_EXIST);
    }
    else if (result.rows.length === 1) {
      const account = result.rows[0];
      return await this.getOwnDataById(account.userId);
    }
    throw new Error(errors.server.TWITTER_LOGIN_FAILED);
  }

  public async getOwnDataByEmailAndVerificationCode(email: string, code: string): Promise<Models.User.OwnData> {
    const options = {
      where: 'u."email" = $1 AND u."verificationCode" = $2 AND u."verificationCodeExpiration" > now()',
      params: [email, code],
    };
    const user = await _getOwnData(pool, options);
    // if no error is thrown, then otp is correct
    await pool.query(`
      UPDATE users
      SET "verificationCode" = NULL, "verificationCodeExpiration" = NULL ${!user.emailVerified ? ', "emailVerified" = TRUE' : ''}
      WHERE id = $1
    `, [user.id]);
    if (!user.emailVerified) { 
      user.emailVerified = true;
    }
    return user;
  }

  public async getUserAccount(accountType: Exclude<Models.User.ProfileItemType, "cg" | "bot">, accountId: string) {
    const query = `
      SELECT "type", "userId", "displayName", "imageId", "data", "extraData"
      FROM user_accounts ua WHERE
        ua."type" = $1 AND
        ${accountType === 'lukso' ? `LOWER(ua."data"->>'id') = LOWER($2)` : `ua."data"->>'id' = $2`} AND
        ua."deletedAt" IS NULL
    `;
    const params = [accountType, accountId];
    const result = await pool.query<{
      type: Models.User.ProfileItemType;
      userId: string;
      displayName: string;
      imageId: string | null;
      data: Models.User.UserAccountData | null;
      extraData: Models.User.UserAccountExtraData | null;
    }>(query, params);
    if (result.rows.length === 1) {
      return result.rows[0];
    }
    return null;
  }

  /**
   * Delivers a list of Models.User.Data items. The result might not contain all
   * desired users, e.g. if a user has been deleted or the id could not be found.
   * @param targetUserIds string[]
   * @returns Promise<Models.User.Data[]>
   */
  public async getUserDataByIds(targetUserIds: string[], userId?: string): Promise<Models.User.Data[]> {
    const result = await _getUserData(pool, {
      where: 'u."id" = ANY($1)',
      userId,
      params: [targetUserIds]
    });
    return result;
  }

  public async getUserProfileDetails(targetUserId: string, userId?: string): Promise<Models.User.UserProfileDetails> {
    return _getUserProfileDetails(pool, {
      targetUserId,
      callerId: userId || null,
    });
  }

  public async setPassword(userId: string, password: string): Promise<void> {
    await _updateUser(pool, { id: userId, password });
  }

  public async updateUser(
    userId: string,
    data: Partial<Omit<Models.User.OwnData, "id" | "updatedAt" | "extraData"> & {
      previewImageId?: string
    } & {
      bannerImageId?: string | null
    }>
  ): Promise<void> {
    if (data.displayAccount === UserProfileTypeEnum.BOT) {
      throw new Error(errors.server.INVALID_REQUEST);
    }
    if (data.email) {
      data.emailVerified = false;
    }
    if ("updatedAt" in data || "id" in data || "extraData" in data) {
      throw new Error(errors.server.INVALID_REQUEST);
    }
    const result = await _updateUser(pool, {
      // type-safe override of displayAccount (enum vs type)
      ...data,
      id: userId,
    });

    // preview image should not be delivered as an update
    delete data.previewImageId;
    // send event if more than data.id is still present
    if (Object.keys(data).length > 0) {
      const event: Events.User.OwnData = {
        type: 'cliUserOwnData',
        data,
      };
      await eventHelper.emit(event, {
        userIds: [userId],
      });

      const listViewUpdate: Pick<Models.User.Data, "id"> & Partial<Models.User.Data> = {
        id: userId,
      };
      if (Object.keys(listViewUpdate).length > 1) {
        const event: Events.User.Data = {
          type: 'cliUserData',
          data: {
            ...listViewUpdate,
            updatedAt: result.updatedAt,
          },
        };
        eventHelper.emit(event, {
          communityIds: result.communityIds,
          userIds: [userId],
        });
      }
    }
  }

  public async setUserExtraDataField(key: keyof Models.User.ExtraData, value: any, userId: string): Promise<void> {
    if (!key.match(/^[a-zA-Z0-9_]+$/)) {
      console.error("Invalid key for extra data", key, value, userId);
      throw new Error(errors.server.INVALID_REQUEST);
    }
    const query = `
      UPDATE users
      SET "updatedAt" = now(), "extraData" = jsonb_set("extraData", '{${key}}', $1::jsonb)
      WHERE "id" = $2
      RETURNING "updatedAt", "extraData"
    `;
    const result = await pool.query<{
      updatedAt: string;
      extraData: Models.User.ExtraData;
    }>(query, [JSON.stringify(value), userId]);
    if (result.rows.length !== 1) {
      throw new Error(errors.server.NOT_FOUND);
    }
    const event: Events.User.OwnData = {
      type: 'cliUserOwnData',
      data: {
        updatedAt: result.rows[0].updatedAt,
        extraData: result.rows[0].extraData,
      },
    };
    eventHelper.emit(event, {
      userIds: [userId],
    });
  }

  public async updateCgProfile(userId: string, data: Omit<API.User.updateUserAccount.Request, "imageId"> & { imageId?: string | null }): Promise<void> {
    let updatedAt: string;
    const { imageId, displayName, description, homepage, links } = data;

    const startJsonbSet = '"extraData"';
    let wrappedJsonbSet = startJsonbSet;

    const setStrings: string[] = [];
    if (imageId !== undefined)
      setStrings.push(format('"imageId" = %L', imageId));
    if (displayName !== undefined)
      setStrings.push(format('"displayName" = %L', displayName));
    if (description !== undefined)
      wrappedJsonbSet = `jsonb_set(${wrappedJsonbSet}, '{description}', ${format("%L::jsonb", JSON.stringify(description))})`;
    if (homepage !== undefined)
      wrappedJsonbSet = `jsonb_set(${wrappedJsonbSet}, '{homepage}', ${format("%L::jsonb", JSON.stringify(homepage))})`;
    if (links !== undefined)
      wrappedJsonbSet = `jsonb_set(${wrappedJsonbSet}, '{links}', ${format("%L::jsonb", JSON.stringify(links))})`;

    if (wrappedJsonbSet !== startJsonbSet) {
      setStrings.push(`"extraData" = ${wrappedJsonbSet}`);
    }

    if (setStrings.length === 0)
      throw new Error(errors.server.INVALID_REQUEST);

    const updateResult = await pool.query<{ updatedAt: string }>(`
      WITH update_account AS (
        UPDATE user_accounts
        SET "updatedAt" = now(), ${setStrings.join(", ")}
        WHERE "userId" = $1
          AND "type" = 'cg'
          AND "deletedAt" IS NULL
        RETURNING "userId"
      )
      UPDATE users
      SET "updatedAt" = now()
      WHERE "id" = (SELECT "userId" FROM update_account)
      RETURNING "updatedAt"
    `, [userId]);
    if (updateResult.rows.length !== 1) {
      throw new Error(errors.server.NOT_FOUND);
    }
    else {
      updatedAt = updateResult.rows[0].updatedAt;
    }
    const accounts = await _getUserDetailledAccounts(pool, userId);

    const event: Events.User.OwnData = {
      type: 'cliUserOwnData',
      data: {
        accounts,
        updatedAt,
      },
    };
    eventHelper.emit(event, {
      userIds: [userId],
    });
  }

  public async addUserAccount(
    userId: string,
    data: CreateHumanUserAccountData
  ): Promise<void> {
    if ((data as CreateUserAccountData).type === UserProfileTypeEnum.BOT) {
      throw new Error(errors.server.INVALID_REQUEST);
    }
    if (data.type === 'twitter') {
      if (!data.data?.id) throw new Error(errors.server.INVALID_REQUEST);
      await this._checkUniqueTwitter(pool, data.data.id);
    }

    if (data.type === 'lukso') {
      if (!data.data?.id) throw new Error(errors.server.INVALID_REQUEST);
      await this._checkUniqueUniversalProfile(pool, data.data.id);
    }

    const client = await pool.connect();
    await client.query('BEGIN');
    try {
      if (data.type === 'lukso') {
        await _addContractWallet(client, userId, data.data!.id as Common.Address, { type: 'universal_profile' }, 'lukso', 'public')
      }
      const result = await _addUserAccount(client, userId, data);
      const { data: internalData, ...newAccount } = data;
      const event: Events.User.OwnData = {
        type: 'cliUserOwnData',
        data: { accounts: result.concat([newAccount]) },
      };
      await eventHelper.emit(event, {
        userIds: [userId],
      });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  public async updateUserAccount(
    userId: string,
    data: API.User.updateUserAccount.Request,
  ) {
    throw new Error(errors.server.NOT_IMPLEMENTED);
  }

  public async removeUserAccount(
    userId: string,
    type: UserProfileTypeEnum
  ): Promise<void> {
    if (type === UserProfileTypeEnum.BOT) {
      throw new Error(errors.server.INVALID_REQUEST);
    }
    let deletedWalletId: string | undefined;

    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const result = await _removeUserAccount(client, userId, type);

      if (type === 'lukso' && result.data !== null) {
        const query = `
          UPDATE wallets
          SET
            "updatedAt" = NOW(),
            "deletedAt" = NOW()
          WHERE "userId" = $1
            AND "type" = 'contract_evm'
            AND "walletIdentifier" = $2
            AND "chain" = 'lukso'
            AND "deletedAt" IS NULL
          RETURNING id
        `;
        const params = [
          userId,
          result.data.id.toLowerCase(),
        ];
        const deleteWalletResult = await client.query<{ id: string }>(query, params);
        if (deleteWalletResult.rows.length === 1) {
          deletedWalletId = deleteWalletResult.rows[0].id;
        }
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

    if (deletedWalletId) {
      await walletHelper.fixRolesAndBalancesAfterWalletDelete(userId, deletedWalletId);
    }

    const accounts = await _getUserDetailledAccounts(pool, userId);
    const event: Events.User.OwnData = {
      type: 'cliUserOwnData',
      data: { accounts },
    };
    await eventHelper.emit(event, {
      userIds: [userId],
    });
  }

  public async updateUniversalProfileData(data: {
    contractAddress: Common.Address,
    displayName: string,
    imageId: string | null,
  }): Promise<void> {
    const { contractAddress, displayName, imageId } = data;
    const query = `
      WITH update_universal_profile AS (
        UPDATE user_accounts
        SET
          "updatedAt" = now(),
          "displayName" = $2,
          "imageId" = $3
        WHERE LOWER("data"->>'id') = LOWER($1)
          AND "type" = 'lukso'
          AND "deletedAt" IS NULL
        RETURNING "userId"
      )
      UPDATE users
      SET
        "updatedAt" = now()
      WHERE "id" = (SELECT "userId" FROM update_universal_profile)
      RETURNING "id"
    `;
    const params = [contractAddress, displayName, imageId];
    const result = await pool.query<{
      id: string;
    }>(query, params);

    if (result.rows.length === 1) {
      const { id } = result.rows[0];
      const accounts = await _getUserDetailledAccounts(pool, id);
      const event: Events.User.OwnData = {
        type: 'cliUserOwnData',
        data: { accounts },
      };
      await eventHelper.emit(event, {
        userIds: [id],
      });
      // Todo: notify other users, too?
    }
  }

  public async addUserFeatures(
    userId: string,
    features: Partial<Models.User.UserFeatures>
  ): Promise<void> {
    const newFeatures = await _addUserFeatures(pool, userId, features);
    const event: Events.User.OwnData = {
      type: 'cliUserOwnData',
      data: { features: newFeatures },
    };
    await eventHelper.emit(event, {
      userIds: [userId],
    });
  }

  public async followUser(userId: string, otherUserId: string) {
    const [
      result,
      ownListViewData,
    ] = await Promise.all([
      _followUser(pool, userId, otherUserId),
      _getUserData(pool, {
        where: 'u."id" = $1',
        userId,
        params: [userId]
      }),
    ]);
    let userAlias = '';
    if (ownListViewData.length === 1) {
      const userData = ownListViewData[0];
      userAlias = getDisplayNameString(userData);
    }
    let preNotification: (Omit<Models.Notification.ApiNotification, "id" | "createdAt" | "updatedAt" | "read">) = {
      type: 'Follower',
      subjectCommunityId: null,
      subjectItemId: null,
      subjectUserId: userId,
      subjectArticleId: null,
      text: 'is now following you',
      extraData: {
        userAlias,
      } as any,
    };
    const [createNotificationResult] = await notificationHelper.createNotifications([{
      ...preNotification,
      userId: otherUserId,
    }]);
    const notification = {
      ...preNotification,
      ...createNotificationResult,
      read: false,
    };

    const ownEvent: Events.User.OwnData = {
      type: 'cliUserOwnData',
      data: { followingCount: result.followingCount },
    }
    const otherEvent: Events.User.OwnData = {
      type: 'cliUserOwnData',
      data: { followerCount: result.followerCount },
    }
    await Promise.all([
      eventHelper.emit(ownEvent, { userIds: [userId] }),
      eventHelper.emit(otherEvent, { userIds: [otherUserId] }),
      eventHelper.sendWsOrWebPushNotificationEvent({
        userId: otherUserId,
        event: {
          type: 'cliNotificationEvent',
          action: 'new',
          data: notification,
        }
      }),
    ]);
  }


  public async unfollowUser(userId: string, otherUserId: string) {
    const result = await _unfollowUser(pool, userId, otherUserId);
    const ownEvent: Events.User.OwnData = {
      type: 'cliUserOwnData',
      data: { followingCount: result.followingCount },
    }
    const otherEvent: Events.User.OwnData = {
      type: 'cliUserOwnData',
      data: { followerCount: result.followerCount },
    }
    await Promise.all([
      eventHelper.emit(ownEvent, { userIds: [userId] }),
      eventHelper.emit(otherEvent, { userIds: [otherUserId] }),
    ]);
  }

  public async isCgProfileNameAvailable(cgProfileName: string): Promise<boolean> {
    return await _isCgProfileNameAvailable(pool, cgProfileName);
  }

  public async isEmailAvailable(email: string): Promise<boolean> {
    return await _isEmailAvailable(pool, email);
  }

  public async subscribeNewsletter(userId: string, email: string) {
    // instances without a Mailchimp key keep the subscription state locally
    if (serverconfig.MAILCHIMP_API_KEY !== 'placeholder') {
      try {
        await mailchimpClient.lists.setListMember(
          serverconfig.MAILCHIMP_DEFAULT_LIST_ID,
          email,
          { email_address: email, status_if_new: 'subscribed', status: 'subscribed' }
        );
      } catch (e) {
        console.log(e);
        throw new Error(errors.server.UNKNOWN);
      }
    }
    await _updateUser(pool, { id: userId, newsletter: true });
    
    const event: Events.User.OwnData = {
      type: 'cliUserOwnData',
      data: { newsletter: true }
    };
    
    await eventHelper.emit(event, {
      userIds: [userId],
    });
  }

  public async unsubscribeNewsletter(userId: string, email: string) {
    // instances without a Mailchimp key keep the subscription state locally
    if (serverconfig.MAILCHIMP_API_KEY !== 'placeholder') {
      try {
        await mailchimpClient.lists.updateListMember(
          serverconfig.MAILCHIMP_DEFAULT_LIST_ID,
          email,
          { email_address: email, status: 'unsubscribed' }
        );
      } catch (e) {
        console.log(e);
        throw new Error(errors.server.UNKNOWN);
      }
    }
    await _updateUser(pool, { id: userId, newsletter: false });

    const event: Events.User.OwnData = {
      type: 'cliUserOwnData',
      data: { newsletter: false }
    };
    
    await eventHelper.emit(event, {
      userIds: [userId],
    });
  }

  public async addContactEmail(userId: string, email: string, withNewCommunitycreatedTag?: boolean): Promise<void> {
    await this.subscribeNewsletter(userId, email);

    if (serverconfig.MAILCHIMP_API_KEY === 'placeholder') {
      return;
    }
    const tags = [{ name: 'New Member', status: 'active' }];
    if (withNewCommunitycreatedTag) {
      tags.push({ name: 'New Community created', status: 'active' });
    }

    await mailchimpClient.lists.updateListMemberTags(
      serverconfig.MAILCHIMP_DEFAULT_LIST_ID,
      email,
      { tags }
    );
  }

  public async getSocialPreviewData(options: { userId: string } | { cgProfileName: string }) {
    return await _getSocialPreviewData(pool, options);
  }

  public async getUserRoleAndCommunityIds(userId: string) {
    const result = await pool.query(`
      SELECT ruu."roleId", c."id" AS "communityId"
      FROM roles_users_users ruu
      INNER JOIN roles r
        ON r."id" = ruu."roleId"
        AND r."deletedAt" IS NULL
      INNER JOIN communities c
        ON c."id" = r."communityId"
      WHERE ruu."userId" = $1
        AND ruu.claimed = TRUE
        AND c."deletedAt" IS NULL
    `, [userId]);
    const rows = result.rows as { roleId: string, communityId: string }[];
    const roleIds = new Set<string>();
    const communityIds = new Set<string>();
    for (const row of rows) {
      roleIds.add(row.roleId);
      communityIds.add(row.communityId);
    }
    return {
      roleIds: Array.from(roleIds),
      communityIds: Array.from(communityIds),
    };
  }

  public async getFollowers(userId: string, limit: number, offset: number) {
    const result = await pool.query(`
      SELECT "userId", "createdAt"
      FROM followers
      WHERE "otherUserId" = $1 AND "deletedAt" IS NULL
      ORDER BY "createdAt" DESC
      LIMIT $2
      OFFSET $3
    `, [userId, limit, offset]);
    return result.rows as {
      userId: string;
      createdAt: string;
    }[];
  }

  public async getFollowing(userId: string, limit: number, offset: number) {
    const result = await pool.query(`
      SELECT "otherUserId" AS "userId", "createdAt"
      FROM followers
      WHERE "userId" = $1 AND "deletedAt" IS NULL
      ORDER BY "createdAt" DESC
      LIMIT $2
      OFFSET $3
    `, [userId, limit, offset]);
    return result.rows as {
      userId: string;
      createdAt: string;
    }[];
  }

  public async getFriends(userId: string, limit: number, offset: number) {
    const query = `
      SELECT f1."otherUserId" as "userId", f1."createdAt"
      FROM followers f1
      JOIN followers f2 
        ON f1."otherUserId" = f2."userId"
      WHERE f1."userId" = $1
        AND f2."otherUserId" = $1
        AND f1."deletedAt" IS NULL
        AND f2."deletedAt" IS NULL
      ORDER BY "createdAt" DESC
      LIMIT $2
      OFFSET $3
    `;
    const result = await pool.query(query, [userId, limit, offset]);
    return result.rows as {
      userId: string;
      createdAt: string;
    }[];
  }

  public async getFriendsWithName(userId: string, limit: number, offset: number) {
    const query = `
      SELECT f1."otherUserId" as "id", ua."displayName" as "name", ua."imageId" as "imageId"
      FROM followers f1
      JOIN followers f2 
        ON f1."otherUserId" = f2."userId"
      JOIN users u
        ON u."id" = f1."otherUserId"
      JOIN user_accounts ua
        ON ua."userId" = u."id"
        AND ua."type"::text = u."displayAccount"::text
      WHERE f1."userId" = $1
        AND f2."otherUserId" = $1
        AND f1."deletedAt" IS NULL
        AND f2."deletedAt" IS NULL
      ORDER BY "f1"."createdAt" DESC
      LIMIT $2
      OFFSET $3
    `;
    const result = await pool.query(query, [userId, limit, offset]);
    return result.rows as {
      id: string;
      name: string;
      imageId: string | null;
    }[];
  }

  /* PREMIUM */
  public async _getUserPremiumFeatures(db: Pool | PoolClient, userId: string) {
    const result = await db.query<{
      featureName: UserPremiumFeatureName;
      activeUntil: string;
      autoRenew: Common.PremiumRenewal | null;
    }>(`
      SELECT
        "featureName",
        "activeUntil",
        "autoRenew"
      FROM users_premium
      WHERE "userId" = $1
    `, [userId]);
    return result.rows;
  }

  private async _upsertOrReplacePremiumFeature(db: Pool | PoolClient, options: {
    type: 'replace';
    userId: string;
    price: number;
    featureName: Models.User.PremiumFeatureName;
    replacedFeatureName: Models.User.PremiumFeatureName;
  } | {
    type: 'upsert';
    userId: string;
    price: number;
    featureName: Models.User.PremiumFeatureName;
    duration: 'month' | 'year';
  }) {
    const { userId, featureName, price } = options;
    const transactionData: Models.Premium.TransactionData = {
      type: 'user-spend',
      featureName,
      triggeredBy: "MANUAL",
    };
    const CTEs: string[] = [`
      WITH update_user AS (
        UPDATE users
        SET
          "pointBalance" = "pointBalance" - ${format("%s", Number(price))},
          "updatedAt" = now()
        WHERE id = ${format("%L", userId)}::uuid
          AND "pointBalance" >= ${format("%s", Number(price))}
        RETURNING "pointBalance", "updatedAt"
      ), insert_transaction AS (
        INSERT INTO point_transactions ("userId", "data", "amount")
        SELECT
          ${format("%L", userId)}::uuid,
          ${format("%L", JSON.stringify(transactionData))}::jsonb,
          ${format("%s", Number(price))}
        WHERE EXISTS(SELECT 1 FROM update_user)
        RETURNING "id"
      )
    `];
    if (options.type === 'replace') {
      CTEs.push(`
        delete_lower_tier AS (
          DELETE FROM users_premium
          WHERE "userId" = ${format("%L", userId)}::uuid
            AND "featureName" = ${format("%L", options.replacedFeatureName)}::"public"."users_premium_featurename_enum"
            AND EXISTS(SELECT 1 FROM update_user)
          RETURNING "activeUntil", "autoRenew"
        ),
        insert_value_select AS (
          SELECT
            ${format("%L", userId)}::uuid AS "userId",
            ${format("%L", featureName)}::"public"."users_premium_featurename_enum" AS "featureName",
            (SELECT "activeUntil" FROM delete_lower_tier) AS "activeUntil",
            (SELECT "autoRenew" FROM delete_lower_tier) AS "autoRenew"
          WHERE EXISTS(SELECT 1 FROM delete_lower_tier)
        )
      `);
    }
    else if (options.type === 'upsert') {
      CTEs.push(`
        insert_value_select AS (
          SELECT
            ${format("%L", userId)}::uuid AS "userId",
            ${format("%L", featureName)}::"public"."users_premium_featurename_enum" AS "featureName",
            now() + interval '${options.duration === 'year' ? '365' : '30'} days' AS "activeUntil",
            '${options.duration === 'year' ? PremiumRenewal.YEAR : PremiumRenewal.MONTH}'::"public"."users_premium_autorenew_enum" AS "autoRenew"
          WHERE EXISTS(SELECT 1 FROM update_user)
        )
      `);
    }

    const result = await db.query<{
      data: {
        pointBalance: number;
        updatedAt: string;
      }
    }>(`
      ${CTEs.join(',')},
      insert_premium AS (
        INSERT INTO users_premium ("userId", "featureName", "activeUntil", "autoRenew")
        SELECT "userId", "featureName", "activeUntil", "autoRenew"
        FROM insert_value_select
        ON CONFLICT ("userId", "featureName")
        DO UPDATE SET
          "activeUntil" = excluded."activeUntil",
          "autoRenew" = excluded."autoRenew"
      )
      SELECT json_build_object(
        'pointBalance', (SELECT "pointBalance" FROM update_user),
        'updatedAt', (SELECT "updatedAt" FROM update_user)
      ) AS data
    `);
    if (result.rows.length === 1) {
      const { data } = result.rows[0];
      if (!!data && data.pointBalance !== null && data.updatedAt !== null) {
        return data;
      }
    }
    throw new Error(errors.server.INSUFFICIENT_BALANCE);
  }

  public async buyUserPremiumFeature(userId: string, data: API.User.buyUserPremiumFeature.Request) {
    const { featureName, duration } = data;
    let price = 0;
    let result: Awaited<ReturnType<typeof this._upsertOrReplacePremiumFeature>> | undefined;
    const currentFeatures = await this._getUserPremiumFeatures(pool, userId);
    const now = new Date();

    if (currentFeatures.some(d => d.featureName === featureName && new Date(d.activeUntil) > now)) {
      throw new Error(errors.server.INVALID_REQUEST);
    }

    if (duration === 'upgrade') {
      const { price, replacedFeatureName } = calculateSupporterUpgradeCost(currentFeatures, featureName, true);
      
      result = await this._upsertOrReplacePremiumFeature(pool, {
        type: 'replace',
        userId,
        price,
        featureName,
        replacedFeatureName,
      });
    }
    else if (duration === 'month' || duration === 'year') {
      switch (featureName) {
        case UserPremiumFeatureName.SUPPORTER_1:
          if (currentFeatures.some(f => f.featureName === UserPremiumFeatureName.SUPPORTER_2 && new Date(f.activeUntil) > now)) {
            throw new Error(errors.server.INVALID_REQUEST);
          }
          price = config.PREMIUM.USER_SUPPORTER_1.MONTHLY_PRICE;
          break;

        case UserPremiumFeatureName.SUPPORTER_2:
          if (currentFeatures.some(f => f.featureName === UserPremiumFeatureName.SUPPORTER_1 && new Date(f.activeUntil) > now)) {
            throw new Error(errors.server.INVALID_REQUEST);
          }
          price = config.PREMIUM.USER_SUPPORTER_2.MONTHLY_PRICE;
          break;

        default:
          throw new Error(errors.server.INVALID_REQUEST);
      }
      if (duration === 'year') {
        price = Math.round(price * 12 * ((100 - config.PREMIUM.YEARLY_DISCOUNT_PERCENT) / 100));
      }
      result = await this._upsertOrReplacePremiumFeature(pool, {
        type: 'upsert',
        userId,
        price,
        featureName,
        duration
      });
    }

    if (!result) {
      throw new Error(errors.server.INVALID_REQUEST);
    }

    const { pointBalance, updatedAt } = result;
    const premiumFeatures = await this._getUserPremiumFeatures(pool, userId);
    const event: Events.User.OwnData = {
      type: 'cliUserOwnData',
      data: {
        updatedAt,
        pointBalance,
        premiumFeatures,
      },
    };
    eventHelper.emit(event, {
      userIds: [userId],
    });
  }

  public async setPremiumFeatureAutoRenew(userId: string, requestData: API.User.setPremiumFeatureAutoRenew.Request) {
    const { featureName, autoRenew } = requestData;
    const currentFeatures = await this._getUserPremiumFeatures(pool, userId);
    const activeFeature = currentFeatures.find(f => f.featureName === featureName && new Date(f.activeUntil) > new Date());
    if (!activeFeature) {
      throw new Error(errors.server.INVALID_REQUEST);
    }
    const result = await pool.query<{
      data: {
        updatedAt: string | null;
      }
    }>(`
      WITH update_feature AS (
        UPDATE users_premium
        SET "autoRenew" = ${autoRenew === null ? 'NULL' : format('%L::"public"."users_premium_autorenew_enum"', autoRenew)}
        WHERE "userId" = ${format("%L::uuid", userId)}
          AND "featureName" = ${format("%L", featureName)}::"public"."users_premium_featurename_enum"
        RETURNING "autoRenew"
      ),
      update_user AS (
        UPDATE users
        SET "updatedAt" = now()
        WHERE id = ${format("%L::uuid", userId)}
          AND EXISTS (SELECT 1 FROM update_feature)
        RETURNING "updatedAt"
      )
      SELECT json_build_object(
        'updatedAt', (SELECT "updatedAt" FROM update_user)
      ) AS data
    `);
    activeFeature.autoRenew = autoRenew;
    const { data } = result.rows[0];
    if (!!data && data.updatedAt !== null) {
      const event: Events.User.OwnData = {
        type: 'cliUserOwnData',
        data: {
          updatedAt: data.updatedAt,
          premiumFeatures: currentFeatures,
        },
      };
      eventHelper.emit(event, {
        userIds: [userId],
      });
    }
    else {
      throw new Error(errors.server.INVALID_REQUEST);
    }
  }

  public async getUserCommunityIds(userId: string) {
    const result = await pool.query(`
      SELECT
        r."communityId"
      FROM users u
      INNER JOIN roles_users_users ruu
        ON ruu."userId" = u."id"
      INNER JOIN roles r
        ON ruu."roleId" = r."id"
        AND r."type" = ${format("%L", RoleType.PREDEFINED)}
        AND r."title" = ${format("%L", PredefinedRole.Member)}
      WHERE u."id" = $1
    `, [userId]);
    const rows = result.rows as {
      communityId: string;
    }[];
    return rows.map(r => r.communityId);
  }

  public async isUserMemberOfCommunity({ userId, communityId }: { userId: string, communityId: string }) {
    const result = await pool.query(`
      SELECT 1
      FROM roles_users_users ruu
      INNER JOIN roles r
        ON r."id" = ruu."roleId"
        AND r."communityId" = $1
        AND r."type" = ${format("%L", RoleType.PREDEFINED)}
        AND r."title" = ${format("%L", PredefinedRole.Member)}
      WHERE ruu."userId" = $2
    `, [communityId, userId]);
    return result.rowCount === 1;
  }

  public async getTransactionData(userId: string) {
    const result = await pool.query<{
      id: string;
      userId: string | null;
      communityId: string | null;
      amount: number;
      data: Models.Premium.TransactionData;
      createdAt: string;
    }>(`
      SELECT
        id,
        "userId",
        "communityId",
        amount,
        data,
        "createdAt"
      FROM point_transactions
      WHERE "userId" = $1
      ORDER BY "createdAt" DESC
    `, [userId]);
    return result.rows;
  }

  public async setUserOnlineStatus(userId: string, status: Models.User.OnlineStatus): Promise<void> {
    const result = await pool.query(`
      WITH update_status AS (
        UPDATE users
        SET
          "onlineStatus" = $2,
          "updatedAt" = now(),
          "onlineStatusUpdatedAt" = now()
        WHERE id = $1
          AND "onlineStatus" <> $2
        RETURNING id
      )
      ${__userWithNotifyIdsQuery('update_status')}
    `, [userId, status]);

    if (status !== "offline") {
      eventHelper.emit({
        type: 'cliUserOwnData',
        data: {
          onlineStatus: status,
        },
      }, {
        userIds: [userId],
      });
    }
    const updates = result.rows as UserWithNotifyIds[];
    for (const update of updates) {
      eventHelper.emit({
        type: 'cliUserData',
        data: {
          id: update.userId,
          onlineStatus: status,
          updatedAt: update.updatedAt,
        },
      }, {
        communityIds: update.communityIds,
        userIds: [update.userId]
      });
    }
  }

  public async setUsersToOffline(userIds: string[]): Promise<void> {
    const result = await pool.query(`
      WITH set_to_offline AS (
        UPDATE users
        SET
          "onlineStatus" = 'offline',
          "updatedAt" = now(),
          "onlineStatusUpdatedAt" = now()
        WHERE id = ANY(ARRAY[${format("%L", userIds)}]::uuid[])
          AND "onlineStatus" <> 'offline'
        RETURNING id
      )
      ${__userWithNotifyIdsQuery('set_to_offline')}
    `);

    const updates = result.rows as UserWithNotifyIds[];
    const promises: Promise<any>[] = [];
    for (const update of updates) {
      promises.push(eventHelper.emit({
        type: 'cliUserData',
        data: {
          id: update.userId,
          onlineStatus: 'offline',
          updatedAt: update.updatedAt,
        },
      }, {
        communityIds: update.communityIds,
        userIds: [update.userId]
      }));
    }
    await Promise.allSettled(promises);
  }

  public async touchUserOnlineStatus(userIds: string[]) {
    if (userIds.length === 0) {
      return;
    }

    const result = await pool.query(`
      WITH all_ids AS (
        SELECT id
        FROM (VALUES ${userIds.map(userId => format("(%L::uuid)", userId)).join(',')}) AS t(id)
      ), update_offline AS (
        UPDATE users
        SET
          "onlineStatusUpdatedAt" = now(),
          "onlineStatus" = 'online',
          "updatedAt" = now()
        WHERE id = ANY((SELECT id FROM all_ids))
          AND "onlineStatus" = 'offline'
        RETURNING id
      ), update_online AS (
        UPDATE users
        SET "onlineStatusUpdatedAt" = now()
        WHERE id = ANY((SELECT id FROM all_ids))
          AND "onlineStatus" <> 'offline'
      )
      ${__userWithNotifyIdsQuery('update_offline')}
    `);

    const updates = result.rows as UserWithNotifyIds[];
    for (const update of updates) {
      eventHelper.emit({
        type: 'cliUserData',
        data: {
          id: update.userId,
          onlineStatus: 'online',
          updatedAt: update.updatedAt,
        },
      }, {
        communityIds: update.communityIds,
        userIds: [update.userId]
      });
    }
  }

  public async pointsBought(data: {
    userId: string;
    amount: number;
    txHash: string;
    blockNumber: number;
    chain: Models.Contract.ChainIdentifier;
    tokenAddress: Common.Address | 'native';
    senderAddress: Common.Address;
  }) {
    if (data.amount % 1 !== 0) {
      throw new Error("Amount has to be an integer");
    }
    const transactionData: Models.Premium.TransactionData = {
      type: 'user-onchain-buy',
      chain: data.chain,
      senderIdentifier: data.senderAddress,
      txHash: data.txHash,
      blockNumber: data.blockNumber,
    }
    const result = await pool.query(`
      WITH insert_transaction AS (
        INSERT INTO point_transactions (
          "userId",
          "amount",
          "data" 
        )
        VALUES ($1, $2, $3::jsonb)
      )
      UPDATE users
      SET
        "pointBalance" = "pointBalance" + $2,
        "updatedAt" = now()
      WHERE id = $1
      RETURNING "pointBalance", "updatedAt"
    `, [
      data.userId,
      data.amount,
      JSON.stringify(transactionData),
    ]);
    if (result.rows.length === 1) {
      const { pointBalance, updatedAt } = result.rows[0];
      const event: Events.User.OwnData = {
        type: 'cliUserOwnData',
        data: {
          pointBalance,
          updatedAt,
        },
      };
      eventHelper.emit(event, {
        userIds: [data.userId],
      });
    }
  }

  private async _checkUniqueTwitter(dataSource: Pool, accountId: string): Promise<void> {
    const query = `SELECT "displayName" FROM user_accounts
    WHERE "data"->>'id' = $1 AND "deletedAt" IS NULL AND "type" = 'twitter'`
    const result = await dataSource.query(query, [accountId]);
    if (result.rows.length === 1) {
      throw new Error(errors.server.EXISTS_ALREADY);
    }
  }
  public isTwitterAlreadyLinked = async (accountId: string) => {
    try {
      await this._checkUniqueTwitter(pool, accountId);
      return false;
    }
    catch (e) {
      return true;
    }
  }

  private async _checkUniqueUniversalProfile(dataSource: Pool, accountId: string): Promise<void> {
    const query = `SELECT "displayName" FROM user_accounts
    WHERE LOWER("data"->>'id') = LOWER($1) AND "deletedAt" IS NULL AND "type" = 'lukso'`
    const result = await dataSource.query(query, [accountId]);
    if (result.rows.length === 1) {
      throw new Error(errors.server.EXISTS_ALREADY);
    }
  }

  public isUniversalProfileAlreadyLinked = async (accountId: string) => {
    try {
      await this._checkUniqueUniversalProfile(pool, accountId);
      return false;
    }
    catch (e) {
      return true;
    }
  }

  public async getUserEmail(userId: string): Promise<string | null> {
    const result = await pool.query(`
      SELECT "email"
      FROM users
      WHERE "id" = $1 AND "emailVerified" = true
    `, [userId]);
    if (result.rows.length === 1) {
      return result.rows[0].email;
    } else {
      return null;
    }
  }

  public async getUserExtraData(userId: string): Promise<Models.User.ExtraData> {
    const result = await pool.query(`
      SELECT "extraData"
      FROM users
      WHERE "id" = $1
    `, [userId]);
    if (result.rows.length === 1) {
      return result.rows[0].extraData;
    }
    throw new Error(errors.server.NOT_FOUND);
  }

  public async registerForTokenSale({ email, referredBy, userId }: { email: string, referredBy?: string, userId?: string }): Promise<void> {
    const query = `
      INSERT INTO tokensale_registrations ("email", "referredBy", "userId")
      VALUES ($1, $2, $3)
      ON CONFLICT (LOWER("email")) DO NOTHING
      RETURNING id
    `;
    const result = await pool.query<{ id: string }>(query, [email, referredBy || null, userId || null]);
  }

  public async getUserIdByEmail(email: string): Promise<string> {
    const result = await pool.query(`
      SELECT "id"
      FROM users
      WHERE "email" = $1
    `, [email]);
    if (result.rows.length === 1) {
      return result.rows[0].id;
    }
    throw new Error(errors.server.NOT_FOUND);
  }

  public async setReferredBy({ userId, tokenSaleId, referredByUserId }: { userId: string, tokenSaleId: string, referredByUserId: string }) {
    await pool.query(`
      INSERT INTO tokensale_userdata ("userId", "tokenSaleId", "referredByUserId")
      VALUES ($1, $2, $3)
      ON CONFLICT ("userId", "tokenSaleId") DO UPDATE SET "referredByUserId" = $3, "updatedAt" = now()
    `, [userId, tokenSaleId, referredByUserId]);
  }

  public async getTokenSaleData(tokenSaleId: string, userId?: string): Promise<{
    tokenSaleData: Models.TokenSale.SaleData,
    userSaleData?: Models.TokenSale.UserSaleData
  }> {
    const tokenSaleData = await pool.query<{
      id: string;
      name: string;
      saleContractChain: Models.Contract.ChainIdentifier;
      saleContractAddress: Common.Address;
      saleContractType: Models.Contract.SaleContractType;
      targetTokenChain: Models.Contract.ChainIdentifier;
      targetTokenAddress: Common.Address;
      targetTokenDecimals: number;
      totalInvested: string;
      startDate: string;
      endDate: string;
    }>(`
      SELECT
        "id",
        "name",
        "saleContractChain",
        "saleContractAddress",
        "saleContractType",
        "targetTokenChain",
        "targetTokenAddress",
        "targetTokenDecimals",
        "totalInvested",
        "startDate",
        "endDate"
      FROM tokensales
      WHERE "id" = $1
    `, [tokenSaleId]);
    if (tokenSaleData.rows.length === 1) {
      let userSaleData: Models.TokenSale.UserSaleData | undefined;
      if (!!userId) {
        const result = await pool.query<{
          tokenSaleId: string;
          referredByUserId: string | null;
          totalInvested: string;
          totalTokensBought: string;
          referralBonus: string;
          referredUsersDirectCount: number;
          referredUsersIndirectCount: number;
          rewardProgram: Models.TokenSale.UserSaleData['rewardProgram'];
          rewardClaimedTimestamp: string | null;
          targetAddress: Common.Address | null;
        }>(`
          SELECT
            "tokenSaleId",
            "referredByUserId",
            "totalInvested",
            "totalTokensBought",
            "referralBonus",
            "referredUsersDirectCount",
            "referredUsersIndirectCount",
            "rewardProgram",
            "rewardClaimedTimestamp",
            "targetAddress"
          FROM tokensale_userdata
          WHERE "tokenSaleId" = $1
            AND "userId" = $2
        `, [tokenSaleId, userId]);
        if (result.rows.length === 1) {
          userSaleData = result.rows[0];
        }
        else {
          await pool.query(`
            INSERT INTO tokensale_userdata ("userId", "tokenSaleId")
            VALUES ($1, $2)
          `, [userId, tokenSaleId]);
          userSaleData = {
            tokenSaleId,
            referredByUserId: null,
            totalInvested: '0',
            totalTokensBought: '0',
            referralBonus: '0',
            referredUsersDirectCount: 0,
            referredUsersIndirectCount: 0,
            rewardProgram: {},
            rewardClaimedTimestamp: null,
            targetAddress: null,
          };
        }
      }
      return {
        tokenSaleData: tokenSaleData.rows[0],
        userSaleData,
      };
    }
    throw new Error(errors.server.NOT_FOUND);
  }

  public async getTokenSaleEvents(tokenSaleId: string): Promise<Models.Contract.SaleInvestmentEventJson[]> {
    const result = await pool.query<{
      event: Models.Contract.SaleInvestmentEventJson;
    }>(`
      SELECT "event"
      FROM tokensale_investments
      WHERE "tokenSaleId" = $1
    `, [tokenSaleId]);
    const events = result.rows.map(row => row.event);
    events.sort((a, b) => a.investmentId - b.investmentId);
    return events;
  }

  public async claimTokenSaleReward(tokenSaleId: string, userId: string, rewardClaimedSecurityData: any) {
    const tokenSaleDates = await pool.query(`
      SELECT "startDate", "endDate"
      FROM tokensales
      WHERE "id" = $1
    `, [tokenSaleId]);
    if (tokenSaleDates.rows.length === 1) {
      const { startDate, endDate } = tokenSaleDates.rows[0];
      if (new Date(startDate) > new Date() || new Date(endDate) < new Date()) {
        throw new Error(errors.server.NOT_ALLOWED);
      }
    }
    else {
      throw new Error(errors.server.NOT_FOUND);
    }
    await pool.query(`
      INSERT INTO tokensale_userdata ("userId", "tokenSaleId", "rewardClaimedTimestamp", "rewardClaimedSecurityData") 
      VALUES ($1, $2, now(), $3::jsonb)
      ON CONFLICT ("userId", "tokenSaleId") DO UPDATE 
      SET "rewardClaimedTimestamp" = CASE 
        WHEN tokensale_userdata."rewardClaimedTimestamp" IS NULL THEN EXCLUDED."rewardClaimedTimestamp"
        ELSE tokensale_userdata."rewardClaimedTimestamp"
      END,
      "rewardClaimedSecurityData" = CASE
        WHEN tokensale_userdata."rewardClaimedSecurityData" IS NULL THEN EXCLUDED."rewardClaimedSecurityData"
        ELSE tokensale_userdata."rewardClaimedSecurityData"
      END
    `, [userId, tokenSaleId, JSON.stringify(rewardClaimedSecurityData)]);
  }

  public async saveTokenSaleTargetAddress(userId: string, data: API.User.saveTokenSaleTargetAddress.Request) {
    await pool.query(`
      UPDATE tokensale_userdata
      SET "targetAddress" = $2, "updatedAt" = now()
      WHERE "userId" = $1
        AND "tokenSaleId" = $3
    `, [userId, data.targetAddress, data.tokenSaleId]);
  }
}

const userHelper = new UserHelper();
export default userHelper;

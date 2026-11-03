// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import pool from './util/postgres';
import { PoolClient, QueryResult } from 'pg';
import { fakeHealthcheck } from './healthcheck';
import express from 'express';
import { ChannelPermission, PredefinedRole, RoleType } from './common/enums';
import { convertUuidToBinary, convertBinaryToUuid, mergeSortedMemberIds } from './util/memberListHelpers';
import { asyncRequestHandler } from './util/asyncHandler';
import { describeErrorForLog } from './util/errorLog';
import { decideChannelEvent, MAX_CHANNEL_EVENT_DEFERRALS } from './util/memberListChannelEvents';
import { emptyChannelMemberList, emptyMemberList } from './common/memberLists';

type PgNotifyEvent = Events.PgNotify.UserDataChange | Events.PgNotify.UserRoleChange | Events.PgNotify.CommunityRoleChange | Events.PgNotify.ChannelRolePermissionChange;

type UserData = {
  roleIds: Set<string>;
  onlineStatus: Models.User.OnlineStatus;
  displayName: string;
  displayNameLower: string;
};

type RoleData = {
  title: string;
  roleType: Common.RoleType;
};

type ChannelRolePermissions = {
  admin: string;
  moderator: Set<string>;
  writer: Set<string>;
  reader: Set<string>;
};

type CommunityMemberSet = {
  _all: Set<string>;
  online: Set<string>;
  offline: Set<string>;
};

type CommunityMemberListArr = {
  count: number;
  _all: string[];
  online: string[];
  offline: string[];
  /** all members by display name (ties by id), whatever their presence */
  byName: string[];
}

type ChannelMemberSet = {
  _all: Set<string>;
  admin: Set<string>;
  moderator: Set<string>;
  writer: Set<string>;
  reader: Set<string>;
  offline: Set<string>;
};

type ChannelMemberListArr = {
  count: number;
  _all: string[];
  admin: string[];
  moderator: string[];
  writer: string[];
  reader: string[];
  offline: string[];
};

let client: PoolClient;
const changeEvents: PgNotifyEvent[] = [];
// safety net: channel events that arrived before their community's roles are
// retried first in the next batch (memberListChannelEvents.ts) — in normal
// operation the rolechange NOTIFY always comes first
const deferredChannelEvents: { event: Events.PgNotify.ChannelRolePermissionChange; deferrals: number }[] = [];

const userDataByUserId = new Map<string, UserData>();
const userIdsByRoleId = new Map<string, Set<string>>();

const communityIdByRoleId = new Map<string, string>();
const roleDataByCommunityId = new Map<string, Map<string, RoleData>>();
const rolePermissionsByCommunityIdByChannelId = new Map<string, Map<string, ChannelRolePermissions>>();

const memberIdsByCommunityId = new Map<string, CommunityMemberSet>();
const memberListByCommunityId = new Map<string, CommunityMemberListArr>();
const memberIdsByCommunityIdByChannelId = new Map<string, Map<string, ChannelMemberSet>>();
const memberListByCommunityIdByChannelId = new Map<string, Map<string, ChannelMemberListArr>>();

/** by display name, ties by id: a total order, so merging sorted lists is exact */
function memberIdSortHelper(a: string, b: string) {
  const displayNameA = userDataByUserId.get(a)?.displayName || '';
  const displayNameB = userDataByUserId.get(b)?.displayName || '';
  return displayNameA.localeCompare(displayNameB) || (a < b ? -1 : a > b ? 1 : 0);
}

function getDisplayName(options: {
  displayAccount: Models.User.ProfileItemType | null;
  accounts: {
    displayName: string;
    type: Models.User.ProfileItemType;
  }[];
}): string {
  const { displayAccount, accounts } = options;
  let displayName: string = '';
  if (displayAccount !== null) {
    displayName = accounts
      .find((account) => account.type === displayAccount)?.displayName || displayName;
  }
  return displayName;
}

async function registerListeners() {
  client = await pool.connect();
  client.query('LISTEN userrolechange');
  client.query('LISTEN userdatachange');
  client.query('LISTEN rolechange');
  client.query('LISTEN channelrolepermissionchange');

  // Keepalive
  let interval: any = undefined;
  interval = setInterval(async () => {
    try {
      await client.query('SELECT 1');
    }
    catch (e) {
      console.log("KEEPALIVE ERROR", e);
      clearInterval(interval);
      shutdown(1);
    }
  }, 60000);

  client.on("notification", (msg) => {
    if (!!msg.payload) {
      try {
        const payload: PgNotifyEvent = JSON.parse(msg.payload);
        console.log("Event received", msg.payload);
        if (payload.type === 'userrolechange') {
          payload.roleId = convertUuidToBinary(payload.roleId);
          payload.userId = convertUuidToBinary(payload.userId);
        }
        else if (payload.type === 'userdatachange') {
          payload.userId = convertUuidToBinary(payload.userId);
        }
        else if (payload.type === 'rolechange') {
          payload.communityId = convertUuidToBinary(payload.communityId);
          payload.roleId = convertUuidToBinary(payload.roleId);
        }
        else if (payload.type === 'channelrolepermissionchange') {
          payload.channelId = convertUuidToBinary(payload.channelId);
          payload.communityId = convertUuidToBinary(payload.communityId);
          payload.roleId = convertUuidToBinary(payload.roleId);
        }
        else {
          console.warn("WARN: Unknown change event type:", payload);
        }
        changeEvents.push(payload);
      }
      catch (e) {
        console.trace(e);
      }
    }
  });
  client.on("error", () => {
    shutdown(1);
  });
  client.on("end", () => {
    console.log("Postgres client disconnected");
  })
  client.on("notice", (msg) => {
    console.log("Postgres Notice:", msg);
  });
}

async function initFromDb() {
  const userPromise = pool.query(`
    SELECT
      u.id AS "userId",
      u."onlineStatus",
      u."displayAccount",
      coalesce((
        SELECT json_agg(json_build_object(
          'displayName', "displayName",
          'type', type
        ))
        FROM user_accounts
        WHERE "userId" = u.id
      ), '[]'::json) AS "accounts"
    FROM users u
  `) as Promise<QueryResult<{
    userId: string;
    onlineStatus: Models.User.OnlineStatus;
    displayAccount: Models.User.ProfileItemType | null;
    accounts: {
      displayName: string;
      type: Models.User.ProfileItemType;
    }[];
  }>>;
  const userRolePromise = pool.query(`
    SELECT
      "userId",
      json_agg("roleId") AS "roleIds"
    FROM roles_users_users
    WHERE claimed = TRUE
    GROUP BY "userId"
  `) as Promise<QueryResult<{
    userId: string;
    roleIds: string[];
  }>>;
  const rolePromise = pool.query(`
    SELECT
      id AS "roleId",
      "communityId",
      title,
      type AS "roleType"
    FROM roles
    WHERE "deletedAt" IS NULL
  `) as Promise<QueryResult<{
    roleId: string;
    communityId: string;
    title: string;
    roleType: Common.RoleType;
  }>>;
  const channelRolePermissionPromise = pool.query(`
    SELECT
      ccrp."communityId",
      ccrp."roleId",
      ccrp."channelId",
      ccrp.permissions
    FROM communities_channels_roles_permissions ccrp
    INNER JOIN roles r
      ON r.id = ccrp."roleId"
    WHERE r."deletedAt" IS NULL
  `) as Promise<QueryResult<{
    communityId: string;
    roleId: string;
    channelId: string;
    permissions: Common.ChannelPermission[];
  }>>;
  const [
    { rows: users },
    { rows: userRoles },
    { rows: roles },
    { rows: channelRolePermissions },
  ] = await Promise.all([
    userPromise,
    userRolePromise,
    rolePromise,
    channelRolePermissionPromise,
  ]);

  // Populate user data
  for (const user of users) {
    // convert to binary
    user.userId = convertUuidToBinary(user.userId);

    const displayName = getDisplayName(user);
    userDataByUserId.set(user.userId, {
      roleIds: new Set(),
      displayName,
      displayNameLower: displayName.toLocaleLowerCase(),
      onlineStatus: user.onlineStatus,
    });
  }

  for (const userRoleData of userRoles) {
    // convert to binary
    userRoleData.userId = convertUuidToBinary(userRoleData.userId);
    for (let i = 0; i < userRoleData.roleIds.length; i++) {
      userRoleData.roleIds[i] = convertUuidToBinary(userRoleData.roleIds[i]);
    }

    const userData = userDataByUserId.get(userRoleData.userId);
    if (!userData) {
      console.trace("ERROR (SKIP): User data not found for userId:", convertBinaryToUuid(userRoleData.userId));
      continue;
    }
    userData.roleIds = new Set(userRoleData.roleIds);
    for (const roleId of userRoleData.roleIds) {
      let userIds = userIdsByRoleId.get(roleId);
      if (!userIds) {
        userIds = new Set();
        userIdsByRoleId.set(roleId, userIds);
      }
      userIds.add(userRoleData.userId);
    }
  }

  // Populate role data
  for (const role of roles) {
    // convert to binary
    role.roleId = convertUuidToBinary(role.roleId);
    role.communityId = convertUuidToBinary(role.communityId);

    communityIdByRoleId.set(role.roleId, role.communityId);
    let communityRoles = roleDataByCommunityId.get(role.communityId);
    if (!communityRoles) {
      communityRoles = new Map();
      roleDataByCommunityId.set(role.communityId, communityRoles);
    }
    communityRoles.set(role.roleId, {
      title: role.title,
      roleType: role.roleType,
    });
  }

  // Populate channel role permissions
  for (const channelRolePermission of channelRolePermissions) {
    // convert to binary
    channelRolePermission.communityId = convertUuidToBinary(channelRolePermission.communityId);
    channelRolePermission.roleId = convertUuidToBinary(channelRolePermission.roleId);
    channelRolePermission.channelId = convertUuidToBinary(channelRolePermission.channelId);

    const communityRoles = roleDataByCommunityId.get(channelRolePermission.communityId);
    if (!communityRoles) {
      console.trace("Community roles not found for communityId:", convertBinaryToUuid(channelRolePermission.communityId));
      continue;
    }
    let rolePermissionsByChannelId = rolePermissionsByCommunityIdByChannelId.get(channelRolePermission.communityId);
    if (!rolePermissionsByChannelId) {
      rolePermissionsByChannelId = new Map();
      rolePermissionsByCommunityIdByChannelId.set(channelRolePermission.communityId, rolePermissionsByChannelId);
    }
    let rolePermissions = rolePermissionsByChannelId.get(channelRolePermission.channelId);
    if (!rolePermissions) {
      let adminRoleId: string | undefined;
      for (const [roleId, role] of communityRoles) {
        if (role.roleType === RoleType.PREDEFINED && role.title === PredefinedRole.Admin) {
          adminRoleId = roleId;
          break;
        }
      }
      if (!adminRoleId) {
        console.trace("Admin role not found for communityId:", convertBinaryToUuid(channelRolePermission.communityId));
      }
      else {
        rolePermissions = {
          admin: adminRoleId,
          moderator: new Set(),
          writer: new Set(),
          reader: new Set(),
        };
        rolePermissionsByChannelId.set(channelRolePermission.channelId, rolePermissions);
      }
    }
    if (!rolePermissions) {
      console.trace("Role permissions not found for communityId:", convertBinaryToUuid(channelRolePermission.communityId), "channelId:", convertBinaryToUuid(channelRolePermission.channelId));
      continue;
    }
    else if (channelRolePermission.roleId !== rolePermissions.admin) {
      if (channelRolePermission.permissions.includes(ChannelPermission.CHANNEL_MODERATE)) {
        rolePermissions.moderator.add(channelRolePermission.roleId);
      }
      else if (channelRolePermission.permissions.includes(ChannelPermission.CHANNEL_WRITE)) {
        rolePermissions.writer.add(channelRolePermission.roleId);
      }
      else if (channelRolePermission.permissions.includes(ChannelPermission.CHANNEL_READ)) {
        rolePermissions.reader.add(channelRolePermission.roleId);
      }
    }
  }

  // Populate community member lists
  for (const [communityId, roleData] of roleDataByCommunityId) {
    for (const [roleId, role] of roleData) {
      let userIds = userIdsByRoleId.get(roleId);
      if (!userIds) {
        userIds = new Set();
        userIdsByRoleId.set(roleId, userIds);
      }
      if (role.roleType !== RoleType.PREDEFINED || role.title !== PredefinedRole.Member) {
        continue;
      }
      const communityMemberSet: CommunityMemberSet = {
        _all: new Set(),
        online: new Set(),
        offline: new Set(),
      };
      memberIdsByCommunityId.set(communityId, communityMemberSet);
      for (const userId of userIds) {
        const userData = userDataByUserId.get(userId);
        if (!userData) {
          console.trace("User data not found for userId:", convertBinaryToUuid(userId));
          continue;
        }
        communityMemberSet._all.add(userId);
        if (userData.onlineStatus !== 'offline') {
          communityMemberSet.online.add(userId);
        }
        else {
          communityMemberSet.offline.add(userId);
        }
      }
      const communityMemberList: CommunityMemberListArr = {
        count: communityMemberSet._all.size,
        _all: [],
        online: Array.from(communityMemberSet.online).sort(memberIdSortHelper),
        offline: Array.from(communityMemberSet.offline).sort(memberIdSortHelper),
        byName: [],
      };
      communityMemberList._all = communityMemberList.online.concat(communityMemberList.offline);
      communityMemberList.byName = mergeSortedMemberIds(communityMemberList.online, communityMemberList.offline, memberIdSortHelper);
      memberListByCommunityId.set(communityId, communityMemberList);
    }
  }

  // Populate channel member lists
  for (const [communityId, rolePermissionsByChannelId] of rolePermissionsByCommunityIdByChannelId) {
    const memberIdsByChannelId = new Map<string, {
      _all: Set<string>;
      admin: Set<string>;
      moderator: Set<string>;
      writer: Set<string>;
      reader: Set<string>;
      offline: Set<string>;
    }>();
    memberIdsByCommunityIdByChannelId.set(communityId, memberIdsByChannelId);
    for (const [channelId, roleIds] of rolePermissionsByChannelId) {
      const channelData: ChannelMemberSet = {
        _all: new Set<string>(),
        admin: new Set<string>(),
        moderator: new Set<string>(),
        writer: new Set<string>(),
        reader: new Set<string>(),
        offline: new Set<string>(),
      };
      memberIdsByChannelId.set(channelId, channelData);
      for (const adminUserId of userIdsByRoleId.get(roleIds.admin) || []) {
        channelData._all.add(adminUserId);
        const userData = userDataByUserId.get(adminUserId);
        if (userData && userData.onlineStatus !== 'offline') {
          channelData.admin.add(adminUserId);
        }
        else {
          channelData.offline.add(adminUserId);
        }
      }
      for (const moderatorRoleId of roleIds.moderator) {
        for (const moderatorUserId of userIdsByRoleId.get(moderatorRoleId) || []) {
          if (channelData._all.has(moderatorUserId)) {
            continue;
          }
          channelData._all.add(moderatorUserId);
          const userData = userDataByUserId.get(moderatorUserId);
          if (userData && userData.onlineStatus !== 'offline') {
            channelData.moderator.add(moderatorUserId);
          }
          else {
            channelData.offline.add(moderatorUserId);
          }
        }
      }
      for (const writerRoleId of roleIds.writer) {
        for (const writerUserId of userIdsByRoleId.get(writerRoleId) || []) {
          if (channelData._all.has(writerUserId)) {
            continue;
          }
          channelData._all.add(writerUserId);
          const userData = userDataByUserId.get(writerUserId);
          if (userData && userData.onlineStatus !== 'offline') {
            channelData.writer.add(writerUserId);
          }
          else {
            channelData.offline.add(writerUserId);
          }
        }
      }
      for (const readerRoleId of roleIds.reader) {
        for (const readerUserId of userIdsByRoleId.get(readerRoleId) || []) {
          if (channelData._all.has(readerUserId)) {
            continue;
          }
          channelData._all.add(readerUserId);
          const userData = userDataByUserId.get(readerUserId);
          if (userData && userData.onlineStatus !== 'offline') {
            channelData.reader.add(readerUserId);
          }
          else {
            channelData.offline.add(readerUserId);
          }
        }
      }
    }
  }

  for (const [communityId, memberIdsByChannelId] of memberIdsByCommunityIdByChannelId) {
    const memberListByChannelId = new Map<string, ChannelMemberListArr>();
    memberListByCommunityIdByChannelId.set(communityId, memberListByChannelId);

    for (const [channelId, memberIds] of memberIdsByChannelId) {
      const memberList: ChannelMemberListArr = {
        count: memberIds._all.size,
        _all: [],
        admin: Array.from(memberIds.admin).sort(memberIdSortHelper),
        moderator: Array.from(memberIds.moderator).sort(memberIdSortHelper),
        writer: Array.from(memberIds.writer).sort(memberIdSortHelper),
        reader: Array.from(memberIds.reader).sort(memberIdSortHelper),
        offline: Array.from(memberIds.offline).sort(memberIdSortHelper),
      };
      memberList._all = memberList.admin.concat(memberList.moderator, memberList.writer, memberList.reader, memberList.offline);
      memberListByChannelId.set(channelId, memberList);
    }
  }
}



function getUserChannelGroup(options: {
  userData: UserData;
  rolePermissions: ChannelRolePermissions;
}): 'admin' | 'moderator' | 'writer' | 'reader' | undefined {
  const { userData, rolePermissions } = options;
  const { roleIds } = userData;
  let userGroup: 'admin' | 'moderator' | 'writer' | 'reader' | undefined;
  for (const roleId of roleIds) {
    if (roleId === rolePermissions.admin) {
      userGroup = 'admin';
    }
    else if (
      rolePermissions.moderator.has(roleId) &&
      userGroup !== 'admin'
    ) {
      userGroup = 'moderator';
    }
    else if (
      rolePermissions.writer.has(roleId) &&
      userGroup !== 'admin' &&
      userGroup !== 'moderator'
    ) {
      userGroup = 'writer';
    }
    else if (
      rolePermissions.reader.has(roleId) &&
      userGroup !== 'admin' &&
      userGroup !== 'moderator' &&
      userGroup !== 'writer'
    ) {
      userGroup = 'reader';
    }
  }
  return userGroup;
}

function updateUserChannelGroup(options: {
  userId: string;
  userData: UserData;
  communityId: string;
  channelId: string;
  rolePermissions: ChannelRolePermissions;
}): boolean {
  const { userId, userData, communityId, channelId, rolePermissions } = options;
  let changed = false;
  const userChannelGroup = getUserChannelGroup({ userData, rolePermissions });
  const memberIds = memberIdsByCommunityIdByChannelId.get(communityId)?.get(channelId);
  if (!memberIds) {
    console.trace("Member ids not found for communityId:", convertBinaryToUuid(communityId), "channelId:", convertBinaryToUuid(channelId));
    return false;
  }
  if (!memberIds._all.has(userId)) {
    // User is not in member list
    if (!!userChannelGroup) {
      memberIds._all.add(userId);
      if (userData.onlineStatus === 'offline') {
        memberIds.offline.add(userId);
      }
      else {
        memberIds[userChannelGroup].add(userId);
      }
      changed = true;
    }
  }
  else {
    // User is already in member list)
    if (!userChannelGroup) {
      memberIds._all.delete(userId);
      memberIds.admin.delete(userId);
      memberIds.moderator.delete(userId);
      memberIds.writer.delete(userId);
      memberIds.reader.delete(userId);
      memberIds.offline.delete(userId);
      changed = true;
    }
    else if (
      (userData.onlineStatus === 'offline' && !memberIds.offline.has(userId)) ||
      (userData.onlineStatus !== 'offline' && !memberIds[userChannelGroup].has(userId))
    ) {
      memberIds.admin.delete(userId);
      memberIds.moderator.delete(userId);
      memberIds.writer.delete(userId);
      memberIds.reader.delete(userId);
      memberIds.offline.delete(userId);
      if (userData.onlineStatus === 'offline') {
        memberIds.offline.add(userId);
      }
      else {
        memberIds[userChannelGroup].add(userId);
      }
      changed = true;
    }
  }
  return changed;
}

function handleEvents() {
  processChangeEvents();
  setTimeout(handleEvents, 1000);
}

function processChangeEvents() {
  const retried = deferredChannelEvents.splice(0);
  const deferralsByEvent = new Map<PgNotifyEvent, number>(retried.map(d => [d.event, d.deferrals]));
  const deferredCommunityIds = new Set<string>();
  const events: PgNotifyEvent[] = [...retried.map(d => d.event), ...changeEvents.splice(0)];
  const updatedCommunityMemberLists = new Set<string>();
  const updatedMemberLists = new Map<string, Set<string>>();
  for (const event of events) {
    // Online status change
    if (event.type === 'userdatachange') {
      const userData = userDataByUserId.get(event.userId);
      const displayName = getDisplayName(event);
      if (userData) {
        if (userData.onlineStatus !== event.onlineStatus) {
          const userRoleIdsByCommunityId = new Map<string, Set<string>>();
          for (const roleId of userData.roleIds) {
            const communityId = communityIdByRoleId.get(roleId);
            if (!communityId) {
              console.trace("Community id not found for roleId:", convertBinaryToUuid(roleId));
              continue;
            }
            let roleIdsPerCommunity = userRoleIdsByCommunityId.get(communityId);
            if (!roleIdsPerCommunity) {
              roleIdsPerCommunity = new Set();
              userRoleIdsByCommunityId.set(communityId, roleIdsPerCommunity);
            }
            roleIdsPerCommunity.add(roleId);
          }
          for (const [communityId, roleIds] of userRoleIdsByCommunityId) {
            // update general member set
            const memberSet = memberIdsByCommunityId.get(communityId);
            if (!memberSet) {
              console.trace("Member set not found for communityId:", convertBinaryToUuid(communityId));
              continue;
            }
            updatedCommunityMemberLists.add(communityId);
            if (event.onlineStatus === 'offline') {
              memberSet.online.delete(event.userId);
              memberSet.offline.add(event.userId);
            }
            else {
              memberSet.online.add(event.userId);
              memberSet.offline.delete(event.userId);
            }

            const rolePermissionsByChannelId = rolePermissionsByCommunityIdByChannelId.get(communityId);
            if (!rolePermissionsByChannelId) {
              console.trace("Role permissions not found for communityId:", convertBinaryToUuid(communityId));
              continue;
            }
            for (const [channelId, rolePermissions] of rolePermissionsByChannelId) {
              const memberIds = memberIdsByCommunityIdByChannelId.get(communityId)?.get(channelId);
              if (!memberIds) {
                console.trace("Member ids not found for communityId:", convertBinaryToUuid(communityId), "channelId:", convertBinaryToUuid(channelId));
                continue;
              }
              const userChannelGroup = getUserChannelGroup({ userData, rolePermissions });
              if (!!userChannelGroup) {
                const updatedChannelMemberLists = updatedMemberLists.get(communityId);
                if (!updatedChannelMemberLists) {
                  updatedMemberLists.set(communityId, new Set([channelId]));
                }
                else {
                  updatedChannelMemberLists.add(channelId);
                }

                if (event.onlineStatus === 'offline') {
                  memberIds.admin.delete(event.userId);
                  memberIds.moderator.delete(event.userId);
                  memberIds.writer.delete(event.userId);
                  memberIds.reader.delete(event.userId);
                  memberIds.offline.add(event.userId);
                }
                else {
                  memberIds.admin.delete(event.userId);
                  memberIds.moderator.delete(event.userId);
                  memberIds.writer.delete(event.userId);
                  memberIds.reader.delete(event.userId);
                  memberIds.offline.delete(event.userId);
                  memberIds[userChannelGroup].add(event.userId);
                }
              }
            }
          }
          userData.onlineStatus = event.onlineStatus;
        }
        if (displayName !== userData.displayName) {
          userData.displayName = displayName;
          userData.displayNameLower = displayName.toLocaleLowerCase();
          // the lists are sorted by name: rebuild the user's communities and
          // the channels they are listed in
          const renamedUserCommunityIds = new Set<string>();
          for (const roleId of userData.roleIds) {
            const communityId = communityIdByRoleId.get(roleId);
            if (communityId) {
              renamedUserCommunityIds.add(communityId);
            }
          }
          for (const communityId of renamedUserCommunityIds) {
            if (memberIdsByCommunityId.has(communityId)) {
              updatedCommunityMemberLists.add(communityId);
            }
            const memberIdsByChannelId = memberIdsByCommunityIdByChannelId.get(communityId);
            if (!memberIdsByChannelId) {
              continue;
            }
            for (const [channelId, memberIds] of memberIdsByChannelId) {
              if (memberIds._all.has(event.userId)) {
                let updatedChannelMemberLists = updatedMemberLists.get(communityId);
                if (!updatedChannelMemberLists) {
                  updatedChannelMemberLists = new Set();
                  updatedMemberLists.set(communityId, updatedChannelMemberLists);
                }
                updatedChannelMemberLists.add(channelId);
              }
            }
          }
        }
      }
      else {
        userDataByUserId.set(event.userId, {
          roleIds: new Set(),
          displayName,
          displayNameLower: displayName.toLocaleLowerCase(),
          onlineStatus: event.onlineStatus,
        });
      }
    }
    // User role change
    else if (event.type === 'userrolechange') {
      const communityId = communityIdByRoleId.get(event.roleId);
      if (!communityId) {
        console.trace("ERROR (SKIP): Community id not found for role:", event);
        continue;
      }
      const rolePermissionsByChannelId = rolePermissionsByCommunityIdByChannelId.get(communityId);
      if (!rolePermissionsByChannelId) {
        console.trace("ERROR (SKIP): Role permissions not found for communityId:", convertBinaryToUuid(communityId), event);
        continue;
      }
      let userData = userDataByUserId.get(event.userId);
      if (!userData) {
        console.trace("ERROR (SKIP): User data not found for userId:", convertBinaryToUuid(event.userId), event);
        continue;
      }
      const roleData = roleDataByCommunityId.get(communityId)?.get(event.roleId);
      if (roleData?.roleType === RoleType.PREDEFINED || roleData?.title === PredefinedRole.Member) {
        // update general member set
        const memberSet = memberIdsByCommunityId.get(communityId);
        if (!memberSet) {
          console.trace("Member set not found for communityId:", convertBinaryToUuid(communityId));
        }
        else {
          updatedCommunityMemberLists.add(communityId);
          if (event.hasRole) {
            memberSet._all.add(event.userId);
            if (userData.onlineStatus === 'offline') {
              memberSet.online.delete(event.userId);
              memberSet.offline.add(event.userId);
            }
            else {
              memberSet.online.add(event.userId);
              memberSet.offline.delete(event.userId);
            }
          }
          else {
            memberSet._all.delete(event.userId);
            memberSet.online.delete(event.userId);
            memberSet.offline.delete(event.userId);
          }
        }
      }
      let roleUserIds = userIdsByRoleId.get(event.roleId);
      if (!roleUserIds) {
        console.warn("WARN: User ids not found for roleId:", event.roleId, "Creating Set");
        roleUserIds = new Set();
        userIdsByRoleId.set(event.roleId, roleUserIds);
      }
      if (event.hasRole) {
        userData.roleIds.add(event.roleId);
        roleUserIds.add(event.userId);
      }
      else {
        userData.roleIds.delete(event.roleId);
        roleUserIds.delete(event.userId);
      }

      for (const [channelId, rolePermissions] of rolePermissionsByChannelId) {
        const changed = updateUserChannelGroup({
          userId: event.userId,
          userData,
          communityId,
          channelId,
          rolePermissions,
        });
        if (changed) {
          let updatedMemberListsByCommunity = updatedMemberLists.get(communityId);
          if (!updatedMemberListsByCommunity) {
            updatedMemberListsByCommunity = new Set();
            updatedMemberLists.set(communityId, updatedMemberListsByCommunity);
          }
          updatedMemberListsByCommunity.add(channelId);
        }
      }
    }
    // Role change
    else if (event.type === 'rolechange') {
      let communityRoles = roleDataByCommunityId.get(event.communityId);
      if (!communityRoles) {
        communityRoles = new Map();
        roleDataByCommunityId.set(event.communityId, communityRoles);
      }
      if (!event.deleted) {
        // Role created or updated
        if (!communityRoles.has(event.roleId)) {
          communityIdByRoleId.set(event.roleId, event.communityId);
          const memberIds = new Set<string>();
          userIdsByRoleId.set(event.roleId, memberIds);
          if (event.roleType === RoleType.PREDEFINED && event.title === PredefinedRole.Member) {
            const memberSet: CommunityMemberSet = {
              _all: memberIds,
              online: new Set(),
              offline: new Set(),
            };
            memberIdsByCommunityId.set(event.communityId, memberSet);
            const memberList: CommunityMemberListArr = {
              count: 0,
              _all: [],
              online: [],
              offline: [],
              byName: [],
            };
            memberListByCommunityId.set(event.communityId, memberList);
          }
        }
        communityRoles.set(event.roleId, {
          title: event.title,
          roleType: event.roleType,
        });
      }
      else {
        // Role deleted
        communityRoles.delete(event.roleId);
        communityIdByRoleId.delete(event.roleId);
        const userIds = userIdsByRoleId.get(event.roleId) || [];
        userIdsByRoleId.delete(event.roleId);
        for (const userId of userIds) {
          const userData = userDataByUserId.get(userId);
          if (userData) {
            userData.roleIds.delete(event.roleId);
          }
        }
        for (const [channelId, rolePermissions] of rolePermissionsByCommunityIdByChannelId.get(event.communityId) || []) {
          if (
            rolePermissions.moderator.has(event.roleId) ||
            rolePermissions.writer.has(event.roleId) ||
            rolePermissions.reader.has(event.roleId)
          ) {
            rolePermissions.moderator.delete(event.roleId);
            rolePermissions.writer.delete(event.roleId);
            rolePermissions.reader.delete(event.roleId);
            let changed = false;
            for (const userId of userIds) {
              const userData = userDataByUserId.get(userId);
              if (!userData) {
                continue;
              }
              changed = updateUserChannelGroup({
                userId,
                userData,
                communityId: event.communityId,
                channelId,
                rolePermissions,
              }) || changed;
            }
            if (changed) {
              let updatedMemberListsByCommunity = updatedMemberLists.get(event.communityId);
              if (!updatedMemberListsByCommunity) {
                updatedMemberListsByCommunity = new Set();
                updatedMemberLists.set(event.communityId, updatedMemberListsByCommunity);
              }
              updatedMemberListsByCommunity.add(channelId);
            }
          }
        }
      }
    }
    // Channel role permission change
    else if (event.type === 'channelrolepermissionchange') {
      let rolePermissionsByChannelId = rolePermissionsByCommunityIdByChannelId.get(event.communityId);
      if (!rolePermissionsByChannelId) {
        rolePermissionsByChannelId = new Map();
        rolePermissionsByCommunityIdByChannelId.set(event.communityId, rolePermissionsByChannelId);
        console.log("Created new community channel role permission map for community", convertBinaryToUuid(event.communityId));
      }
      let rolePermissions = rolePermissionsByChannelId.get(event.channelId);
      const deferrals = deferralsByEvent.get(event) ?? 0;
      const decision = decideChannelEvent({
        channelKnown: !!rolePermissions,
        communityRoles: roleDataByCommunityId.get(event.communityId),
        communityHasDeferredEvent: deferredCommunityIds.has(event.communityId),
        deferrals,
      });
      if (decision.action === 'defer') {
        deferredCommunityIds.add(event.communityId);
        deferredChannelEvents.push({ event, deferrals: deferrals + 1 });
        continue;
      }
      if (decision.action === 'drop') {
        console.trace(`ERROR (SKIP): Community roles or Admin role not found after ${MAX_CHANNEL_EVENT_DEFERRALS} batches for communityId:`, convertBinaryToUuid(event.communityId), event);
        continue;
      }
      // a channel that is new to this service always gets a member list
      // (with its admins, as initFromDb does), even if no user changes below
      let newChannel = false;
      if (decision.action === 'create') {
        newChannel = true;
        rolePermissions = {
          admin: decision.adminRoleId,
          moderator: new Set(),
          writer: new Set(),
          reader: new Set(),
        };
        rolePermissionsByChannelId.set(event.channelId, rolePermissions);
        console.log("Created new channel role permission map for community:", convertBinaryToUuid(event.communityId), "channelId:", convertBinaryToUuid(event.channelId));

        let memberIdsByChannelId = memberIdsByCommunityIdByChannelId.get(event.communityId);
        if (!memberIdsByChannelId) {
          memberIdsByChannelId = new Map();
          memberIdsByCommunityIdByChannelId.set(event.communityId, memberIdsByChannelId);
          console.log("Created new channel memberId map for community:", convertBinaryToUuid(event.communityId));
        }
        let memberIds = memberIdsByChannelId.get(event.channelId);
        if (!memberIds) {
          memberIds = {
            _all: new Set(),
            admin: new Set(),
            moderator: new Set(),
            writer: new Set(),
            reader: new Set(),
            offline: new Set(),
          };
          memberIdsByChannelId.set(event.channelId, memberIds);
          console.log("Created new channel memberId map for community:", convertBinaryToUuid(event.communityId), "channelId:", convertBinaryToUuid(event.channelId));
        }
      }
      if (!rolePermissions) {
        continue; // unreachable: 'apply' means the channel is known
      }

      if (event.roleId !== rolePermissions.admin) {
        if (event.permissions.includes(ChannelPermission.CHANNEL_MODERATE)) {
          rolePermissions.moderator.add(event.roleId);
          rolePermissions.writer.delete(event.roleId);
          rolePermissions.reader.delete(event.roleId);
        }
        else if (event.permissions.includes(ChannelPermission.CHANNEL_WRITE)) {
          rolePermissions.writer.add(event.roleId);
          rolePermissions.moderator.delete(event.roleId);
          rolePermissions.reader.delete(event.roleId);
        }
        else if (event.permissions.includes(ChannelPermission.CHANNEL_READ)) {
          rolePermissions.reader.add(event.roleId);
          rolePermissions.moderator.delete(event.roleId);
          rolePermissions.writer.delete(event.roleId);
        }
        else {
          rolePermissions.moderator.delete(event.roleId);
          rolePermissions.writer.delete(event.roleId);
          rolePermissions.reader.delete(event.roleId);
        }
      }

      const userIds = new Set(userIdsByRoleId.get(event.roleId));
      if (newChannel) {
        for (const adminUserId of userIdsByRoleId.get(rolePermissions.admin) || []) {
          userIds.add(adminUserId);
        }
      }
      let changed = false;
      for (const userId of userIds) {
        const userData = userDataByUserId.get(userId);
        if (!userData) {
          console.warn("WARN: User data not found for userId:", userId);
          continue;
        }
        changed = updateUserChannelGroup({
          userId,
          userData,
          communityId: event.communityId,
          channelId: event.channelId,
          rolePermissions,
        }) || changed;
      }
      if (changed || newChannel) {
        let updatedMemberListsByCommunity = updatedMemberLists.get(event.communityId);
        if (!updatedMemberListsByCommunity) {
          updatedMemberListsByCommunity = new Set();
          updatedMemberLists.set(event.communityId, updatedMemberListsByCommunity);
        }
        updatedMemberListsByCommunity.add(event.channelId);
      }
    }
  }

  for (const communityId of updatedCommunityMemberLists) {
    const memberSet = memberIdsByCommunityId.get(communityId);
    if (!memberSet) {
      console.trace("ERROR (SKIP): Member set not found for communityId:", convertBinaryToUuid(communityId));
      continue;
    }
    let memberList = memberListByCommunityId.get(communityId);
    if (!memberList) {
      memberList = {
        count: 0,
        _all: [],
        online: [],
        offline: [],
        byName: [],
      };
      memberListByCommunityId.set(communityId, memberList);
    }
    memberList.count = memberSet._all.size;
    memberList.online = Array.from(memberSet.online).sort(memberIdSortHelper);
    memberList.offline = Array.from(memberSet.offline).sort(memberIdSortHelper);
    memberList._all = memberList.online.concat(memberList.offline);
    memberList.byName = mergeSortedMemberIds(memberList.online, memberList.offline, memberIdSortHelper);
  }
  for (const [communityId, updatedChannelIds] of updatedMemberLists) {
    let memberListByChannelId = memberListByCommunityIdByChannelId.get(communityId);
    if (!memberListByChannelId) {
      memberListByChannelId = new Map();
      memberListByCommunityIdByChannelId.set(communityId, memberListByChannelId);
      console.log("Created new community memberList map for community", convertBinaryToUuid(communityId));
    }
    for (const channelId of updatedChannelIds) {
      const memberIds = memberIdsByCommunityIdByChannelId.get(communityId)?.get(channelId);
      if (!memberIds) {
        console.trace("ERROR (SKIP): Member ids not found for communityId:", convertBinaryToUuid(communityId), "channelId:", convertBinaryToUuid(channelId));
        continue;
      }
      let memberList = memberListByChannelId.get(channelId);
      if (!memberList) {
        memberList = {
          count: 0,
          _all: [],
          admin: [],
          moderator: [],
          writer: [],
          reader: [],
          offline: [],
        };
        memberListByChannelId.set(channelId, memberList);
      }
      memberList.count = memberIds._all.size;
      memberList.admin = Array.from(memberIds.admin).sort(memberIdSortHelper);
      memberList.moderator = Array.from(memberIds.moderator).sort(memberIdSortHelper);
      memberList.writer = Array.from(memberIds.writer).sort(memberIdSortHelper);
      memberList.reader = Array.from(memberIds.reader).sort(memberIdSortHelper);
      memberList.offline = Array.from(memberIds.offline).sort(memberIdSortHelper);
      memberList._all = memberList.admin.concat(memberList.moderator, memberList.writer, memberList.reader, memberList.offline);
    }
  }
}

function getMemberListWindow(options: {
  communityId: string;
  offset: number;
  limit: number;
  search?: string;
  roleId?: string;
}): Models.Community.MemberList {
  const { communityId, offset, limit, search: _search, roleId } = options;
  // a community this service does not know (yet — a new one appears with the
  // next event batch) answers an empty list, never an empty body
  const search = _search?.toLocaleLowerCase();
  const communityRoles = roleDataByCommunityId.get(communityId);
  if (!communityRoles) {
    console.trace("ERROR (SKIP): Community roles not found for communityId:", convertBinaryToUuid(communityId));
    return emptyMemberList();
  }
  const communityRoleIdArray = Array.from(communityRoles.keys());
  const memberRoleId = communityRoleIdArray.find(roleId => communityRoles.get(roleId)?.roleType === RoleType.PREDEFINED && communityRoles.get(roleId)?.title === PredefinedRole.Member);
  if (!memberRoleId) {
    console.trace("ERROR (SKIP): Member role not found for communityId:", convertBinaryToUuid(communityId));
    return emptyMemberList();
  }
  const memberIds = userIdsByRoleId.get(memberRoleId);
  if (!memberIds) {
    console.trace("ERROR (SKIP): Member ids not found for memberRoleId:", convertBinaryToUuid(memberRoleId));
    return emptyMemberList();
  }
  const memberListWindow: Models.Community.MemberList = {
    totalCount: memberIds.size,
    resultCount: memberIds.size,
    roles: communityRoleIdArray.map(roleId => ([roleId, userIdsByRoleId.get(roleId)?.size || 0])),
    online: [],
    offline: [],
  };
  const memberList = memberListByCommunityId.get(communityId);
  if (!memberList) {
    console.trace("ERROR (SKIP): Member list not found for communityId:", convertBinaryToUuid(communityId));
    return emptyMemberList();
  }
  const memberSet = memberIdsByCommunityId.get(communityId);
  if (!memberSet) {
    console.trace("ERROR (SKIP): Member set not found for communityId:", convertBinaryToUuid(communityId));
    return emptyMemberList();
  }

  let _offset = offset;
  let _limit = limit;
  if (search === undefined && roleId === undefined) {
    for (const key of ['online', 'offline'] as const) {
      if (_limit > 0) {
        if (_offset >= memberList[key].length) {
          _offset -= memberList[key].length;
        }
        else {
          for (let i = _offset; i < memberList[key].length; i++) {
            if (_limit <= 0) {
              break;
            }
            const userId = memberList[key][i];
            const userData = userDataByUserId.get(userId);
            if (!userData) {
              console.trace("ERROR (SKIP): User data not found for userId:", convertBinaryToUuid(userId));
              continue;
            }
            memberListWindow[key].push([userId, communityRoleIdArray.filter(roleId => userData.roleIds.has(roleId))]);
            _limit--;
          }
          _offset = 0;
        }
      }
      else {
        break;
      }
    }
  }
  else {
    let resultCount = 0;
    for (const userId of memberList._all) {
      const userData = userDataByUserId.get(userId);
      if (!userData) {
        console.trace("ERROR (SKIP): User data not found for userId:", convertBinaryToUuid(userId));
        continue;
      }
      if (
        (search !== undefined && userData.displayNameLower.indexOf(search) === -1) ||
        (roleId !== undefined && !userData.roleIds.has(roleId))
      ) {
        continue;
      }
      resultCount++;
      if (_offset > 0) {
        _offset--;
      }
      else if (_limit > 0) {
        if (memberSet.online.has(userId)) {
          memberListWindow.online.push([userId, communityRoleIdArray.filter(roleId => userData.roleIds.has(roleId))]);
          _limit--;
        }
        else if (memberSet.offline.has(userId)) {
          memberListWindow.offline.push([userId, communityRoleIdArray.filter(roleId => userData.roleIds.has(roleId))]);
          _limit--;
        }
      }
    }
    memberListWindow.resultCount = resultCount;
  }
  
  return memberListWindow;
}

/**
 * The first `limit` members of a community by display name (ties by id),
 * independent of presence: the counts and the member ids, without roles, the
 * presence split (all ids are in `offline`) or the per-role counts.
 */
function getMemberListPreview(options: {
  communityId: string;
  limit: number;
}): Models.Community.MemberList {
  const { communityId, limit } = options;
  const memberList = memberListByCommunityId.get(communityId);
  if (!memberList) {
    // a community created a moment ago is only known after the next batch
    console.trace("ERROR (SKIP): Member list not found for communityId:", convertBinaryToUuid(communityId));
    return emptyMemberList();
  }
  return {
    totalCount: memberList.count,
    resultCount: memberList.count,
    roles: [],
    online: [],
    offline: memberList.byName.slice(0, Math.max(0, limit)).map(userId => [userId, []]),
  };
}

function getChannelMemberListWindow(options: {
  communityId: string;
  channelId: string;
  offset: number;
  limit: number;
  search?: string;
  startsWithSearch?: boolean;
}): Models.Community.ChannelMemberList {
  const { communityId, channelId, offset, limit, search: _search, startsWithSearch } = options;
  const search = _search?.toLocaleLowerCase();
  // a channel this service does not know (yet — a new one appears with the
  // next event batch) answers an empty list, never an empty body
  const memberList = memberListByCommunityIdByChannelId.get(communityId)?.get(channelId);
  if (!memberList) {
    console.trace("ERROR (SKIP): Member list not found for communityId:", convertBinaryToUuid(communityId), "channelId:", convertBinaryToUuid(channelId));
    return emptyChannelMemberList();
  }
  const memberSet = memberIdsByCommunityIdByChannelId.get(communityId)?.get(channelId);
  if (!memberSet) {
    console.trace("ERROR (SKIP): Member set not found for communityId:", convertBinaryToUuid(communityId), "channelId:", convertBinaryToUuid(channelId));
    return emptyChannelMemberList();
  }
  const communityRoles = roleDataByCommunityId.get(communityId);
  if (!communityRoles) {
    console.trace("ERROR (SKIP): Community roles not found for communityId:", convertBinaryToUuid(communityId));
    return emptyChannelMemberList();
  }
  const communityRoleIdArray = Array.from(communityRoles.keys());
  const memberListWindow: Models.Community.ChannelMemberList = {
    count: memberList.count,
    adminCount: memberList.admin.length,
    moderatorCount: memberList.moderator.length,
    writerCount: memberList.writer.length,
    readerCount: memberList.reader.length,
    offlineCount: memberList.offline.length,
    admin: [],
    moderator: [],
    writer: [],
    reader: [],
    offline: [],
  };

  let _offset = offset;
  let _limit = limit;
  if (search === undefined) {
    for (const key of ['admin', 'moderator', 'writer', 'reader', 'offline'] as const) {
      if (_limit > 0) {
        if (_offset >= memberList[key].length) {
          _offset -= memberList[key].length;
        }
        else {
          for (let i = _offset; i < memberList[key].length; i++) {
            if (_limit <= 0) {
              break;
            }
            const userId = memberList[key][i];
            const userData = userDataByUserId.get(userId);
            if (!userData) {
              console.trace("ERROR (SKIP): User data not found for userId:", convertBinaryToUuid(userId));
              continue;
            }
            memberListWindow[key].push([userId, communityRoleIdArray.filter(roleId => userData.roleIds.has(roleId))]);
            _limit--;
          }
          _offset = 0;
        }
      }
      else {
        break;
      }
    }
  }
  else {
    memberListWindow.adminCount = 0;
    memberListWindow.moderatorCount = 0;
    memberListWindow.writerCount = 0;
    memberListWindow.readerCount = 0;
    memberListWindow.offlineCount = 0;
    for (const userId of memberList._all) {
      const userData = userDataByUserId.get(userId);
      if (!userData) {
        console.trace("ERROR (SKIP): User data not found for userId:", convertBinaryToUuid(userId));
        continue;
      }
      if (
        (startsWithSearch && !userData.displayNameLower.startsWith(search)) ||
        (!startsWithSearch && userData.displayNameLower.indexOf(search) === -1)
      ) {
        continue;
      }
      if (memberSet.admin.has(userId)) {
        memberListWindow.adminCount++;
        if (_offset > 0) {
          _offset--;
        }
        else if (limit > 0) {
          memberListWindow.admin.push([userId, communityRoleIdArray.filter(roleId => userData.roleIds.has(roleId))]);
          _limit--;
        }
      }
      else if (memberSet.moderator.has(userId)) {
        memberListWindow.moderatorCount++;
        if (_offset > 0) {
          _offset--;
        }
        else if (limit > 0) {
          memberListWindow.moderator.push([userId, communityRoleIdArray.filter(roleId => userData.roleIds.has(roleId))]);
          _limit--;
        }
      }
      else if (memberSet.writer.has(userId)) {
        memberListWindow.writerCount++;
        if (_offset > 0) {
          _offset--;
        }
        else if (limit > 0) {
          memberListWindow.writer.push([userId, communityRoleIdArray.filter(roleId => userData.roleIds.has(roleId))]);
          _limit--;
        }
      }
      else if (memberSet.reader.has(userId)) {
        memberListWindow.readerCount++;
        if (_offset > 0) {
          _offset--;
        }
        else if (limit > 0) {
          memberListWindow.reader.push([userId, communityRoleIdArray.filter(roleId => userData.roleIds.has(roleId))]);
          _limit--;
        }
      }
      else if (memberSet.offline.has(userId)) {
        memberListWindow.offlineCount++;
        if (_offset > 0) {
          _offset--;
        }
        else if (limit > 0) {
          memberListWindow.offline.push([userId, communityRoleIdArray.filter(roleId => userData.roleIds.has(roleId))]);
          _limit--;
        }
      }
    }
    memberListWindow.count = memberListWindow.adminCount + memberListWindow.moderatorCount + memberListWindow.writerCount + memberListWindow.readerCount + memberListWindow.offlineCount;
  }
  
  return memberListWindow;
}

const app = express();

async function init() {
  const startTime = Date.now();
  await registerListeners();
  await initFromDb();

  console.log("Initialized in", Date.now() - startTime, "ms");
  handleEvents();
}

// started only as the service's entry point; tests import this module for
// `memberListForTests`
const isMain = require.main === module;
const ready: Promise<void> = isMain ? init() : Promise.resolve();

// a failing request (e.g. initialisation failed) answers 500; the api's caller
// turns that into its generic error response
function requestFailed(response: express.Response, error: unknown) {
  console.error('memberlist request failed:', describeErrorForLog(error));
  response.status(500).json({ error: 'memberlist_request_failed' });
}

app.post('/getMemberListWindow', express.json(), asyncRequestHandler(async (req, res) => {
  const { communityId, offset, limit, search, roleId } = req.body as API.Community.getMemberList.Request;
  await ready;
  const memberList = getMemberListWindow({
    communityId,
    offset,
    limit,
    search,
    roleId,
  });
  res.json(memberList);
}, requestFailed));

app.post('/getMemberListPreview', express.json(), asyncRequestHandler(async (req, res) => {
  const { communityId, limit } = req.body as { communityId: string; limit: number };
  await ready;
  res.json(getMemberListPreview({ communityId, limit }));
}, requestFailed));

app.post('/getChannelMemberListWindow', express.json(), asyncRequestHandler(async (req, res) => {
  const { communityId, channelId, offset, limit, search, startsWithSearch } = req.body as API.Community.getChannelMemberList.Request;
  await ready;
  const memberList = getChannelMemberListWindow({
    communityId,
    channelId,
    offset,
    limit,
    search,
    startsWithSearch,
  });
  res.json(memberList);
}, requestFailed));

app.post('/getUserCommunityRoleIds', express.json(), asyncRequestHandler(async (req, res) => {
  const { userId, communityId } = req.body as API.Community.getUserCommunityRoleIds.Request;
  await ready;
  const userData = userDataByUserId.get(userId);
  const communityRoleData = roleDataByCommunityId.get(communityId);
  if (!userData || !communityRoleData) {
    res.json([]);
    return;
  }
  res.json(Array.from(communityRoleData.keys()).filter(roleId => userData.roleIds.has(roleId)));
}, requestFailed));

const shutdown = async (code = 0) => {
  process.exit(code);
}

if (isMain) {
  app.listen(4000);

  fakeHealthcheck();

  process.on("SIGTERM", () => shutdown());
  process.on("unhandledRejection", (reason, promise) => {
    console.trace('Unhandled Rejection at:', promise, 'reason:', reason);
    shutdown(1);
  });
  process.on("uncaughtException", (error, origin) => {
    console.trace('Uncaught Exception at:', error, 'origin:', origin);
    shutdown(1);
  });
}

/** the event processing and the windows, driven by tests (tests/memberListEvents.spec.ts) */
export const memberListForTests = {
  queueEvent: (event: PgNotifyEvent) => { changeEvents.push(event); },
  processChangeEvents,
  getMemberListWindow,
  getMemberListPreview,
  getChannelMemberListWindow,
  hasChannelMemberList: (communityId: string, channelId: string) =>
    memberListByCommunityIdByChannelId.get(communityId)?.has(channelId) === true,
};
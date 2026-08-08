// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from "express";
import communityHelper from "../repositories/communities";
import articleHelper from "../repositories/articles";
import communityEventHelper from "../repositories/communityEvents";
import errors from "../common/errors";
import { convertEventPermissionToCallPermission, registerPostRoute } from "./util";
import validators from "../validators";
import permissionHelper from "../repositories/permissions";
import eventHelper from "../repositories/event";
import onchainHelper from "../repositories/onchain";
import { CallPermission, CallType, ChannelPermission, CommunityApprovalState, CommunityEventPermission, CommunityPermission, PredefinedRole, RoleType, UserBlockState } from "../common/enums";
import callHelper from "../repositories/calls";
import { createTranslator } from "short-uuid";
import fileHelper from "../repositories/files";
import axios from "../util/axios";
import { convertBinaryMemberListToUuid, convertBinaryToUuid, convertUuidToBinary } from "../util/memberListHelpers";
import newsletterHelper from "../repositories/newsletter";
import dayjs from "dayjs";
import emailUtils from "./emails";
import userHelper from "../repositories/users";

const communityRouter = express.Router();
const t = createTranslator();

registerPostRoute<
  API.Community.getCommunityList.Request,
  API.Community.getCommunityList.Response
>(
  communityRouter,
  '/getCommunityList',
  validators.API.Community.getCommunityList,
  async (request, response, data) => {
    return await communityHelper.getCommunityList(data);
  }
);

registerPostRoute<
  API.Community.getCommunitiesById.Request,
  API.Community.getCommunitiesById.Response
>(
  communityRouter,
  '/getCommunitiesById',
  validators.API.Community.getCommunitiesById,
  async (request, response, data) => {
    return await communityHelper.getCommunitiesById(data);
  }
);

registerPostRoute<
  API.Community.getCommunityDetailView.Request,
  API.Community.getCommunityDetailView.Response
>(
  communityRouter,
  '/getCommunityDetailView',
  validators.API.Community.getCommunityDetailView,
  async (request, response, data) => {
    const { user } = request.session;
    return await communityHelper.getCommunityDetailView(data, user?.id);
  }
);

registerPostRoute<
  API.Community.joinCommunity.Request,
  API.Community.joinCommunity.Response
>(
  communityRouter,
  '/joinCommunity',
  validators.API.Community.joinCommunity,
  async (request, response, data) => {
    const { id } = data;
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasTrustOrThrow({ userId: user.id, trust: '1.0' });
    const result = await communityHelper.attemptJoinCommunity(user.id, id, data.questionnaireAnswers, data.password);
    if (!result) {
      return null;
    }
    
    const event: Events.Community.Community = {
      type: "cliCommunityEvent",
      action: "new-or-full-update",
      data: result,
    };
    eventHelper.emit(event, {
      userIds: [user.id],
    }, {
      deviceIds: [user.deviceId],
    });

    return result;
  }
);

registerPostRoute<
  API.Community.leaveCommunity.Request,
  API.Community.leaveCommunity.Response
>(
  communityRouter,
  '/leaveCommunity',
  validators.API.Community.leaveCommunity,
  async (request, response, data) => {
    const { id } = data;
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    return communityHelper.leaveCommunity(user.id, id);
  }
);

registerPostRoute<
  API.Community.setUserBlockState.Request,
  API.Community.setUserBlockState.Response
>(
  communityRouter,
  '/setUserBlockState',
  validators.API.Community.setUserBlockState,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MODERATE,
      ],
      communityId: data.communityId,
      userId: user.id
    });

    await communityHelper.setUserBlockState(data);

    let event: Events.Community.Community | undefined;
    if (data.blockState === UserBlockState.BANNED) {
      event = {
        action: "update",
        type: "cliCommunityEvent",
        data: {
          id: data.communityId,
          updatedAt: new Date().toISOString(),
          myRoleIds: [],
          blockState: {
            state: data.blockState,
            until: data.until,
          },
        },
      }
    }
    else if (data.blockState === UserBlockState.CHAT_MUTED) {
      event = {
        action: "update",
        type: "cliCommunityEvent",
        data: {
          id: data.communityId,
          updatedAt: new Date().toISOString(),
          blockState: {
            state: data.blockState,
            until: data.until,
          },
        },
      }
    }
    else if (data.blockState === null) {
      event = {
        action: "update",
        type: "cliCommunityEvent",
        data: {
          id: data.communityId,
          updatedAt: new Date().toISOString(),
          blockState: {
            state: null,
            until: null,
          },
        },
      }
    }
    if (!!event) {
      eventHelper.emit(event, {
        userIds: [data.userId],
      });
    }
  }
);

registerPostRoute<
API.Community.getMemberList.Request,
API.Community.getMemberList.Response
>(
  communityRouter,
  '/getMemberList',
  validators.API.Community.getMemberList,
  async (request, response, data) => {
    const memberList = await axios.post<API.Community.getMemberList.Response>(
      'http://memberlist:4000/getMemberListWindow',
      JSON.stringify({
        ...data,
        communityId: convertUuidToBinary(data.communityId),
        roleId: !!data.roleId ? convertUuidToBinary(data.roleId) : undefined,
      }),
      {
        headers: {
          'Content-Type': 'application/json'
        }
      },
    );

    return convertBinaryMemberListToUuid(memberList.data);
  }
);

registerPostRoute<
API.Community.getChannelMemberList.Request,
API.Community.getChannelMemberList.Response
>(
  communityRouter,
  '/getChannelMemberList',
  validators.API.Community.getChannelMemberList,
  async (request, response, data) => {
    const memberList = await axios.post<API.Community.getChannelMemberList.Response>(
      'http://memberlist:4000/getChannelMemberListWindow',
      JSON.stringify({
        ...data,
        communityId: convertUuidToBinary(data.communityId),
        channelId: convertUuidToBinary(data.channelId),
      }),
      {
        headers: {
          'Content-Type': 'application/json'
        }
      },
    );

    return convertBinaryMemberListToUuid(memberList.data);
  }
);

registerPostRoute<
API.Community.getMemberNewsletterCount.Request,
API.Community.getMemberNewsletterCount.Response
>(
  communityRouter,
  '/getMemberNewsletterCount',
  validators.API.Community.getMemberNewsletterCount,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_ARTICLES
      ],
      communityId: data.communityId,
      userId: user.id
    });
    return communityHelper.getMemberNewsletterCount(data);
  }
);

registerPostRoute<
API.Community.getUserCommunityRoleIds.Request,
API.Community.getUserCommunityRoleIds.Response
>(
  communityRouter,
  '/getUserCommunityRoleIds',
  validators.API.Community.getUserCommunityRoleIds,
  async (request, response, data) => {
    const roleIdsBinary = await axios.post<API.Community.getUserCommunityRoleIds.Response>(
      'http://memberlist:4000/getUserCommunityRoleIds',
      JSON.stringify({
        ...data,
        userId: convertUuidToBinary(data.userId),
        communityId: convertUuidToBinary(data.communityId),
      }),
      {
        headers: {
          'Content-Type': 'application/json'
        }
      },
    );

    return roleIdsBinary.data.map(convertBinaryToUuid);
  }
);

registerPostRoute<
  API.Community.createCommunity.Request,
  API.Community.createCommunity.Response
>(
  communityRouter,
  '/createCommunity',
  validators.API.Community.createCommunity,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasTrustOrThrow({ userId: user.id, trust: '1.0' });
    const result = await communityHelper.createCommunity(data, user.id);

    const roleIds = result.roles.filter(r => {
      return (
        r.title === PredefinedRole.Admin ||
        r.title === PredefinedRole.Member
      )
    }).map(r => r.id);
    await eventHelper.userJoinRooms(user.id, {
      communityIds: [result.id],
      roleIds,
    });

    const event: Events.Community.Community = {
      type: "cliCommunityEvent",
      action: "new-or-full-update",
      data: result,
    };
    eventHelper.emit(event, {
      userIds: [user.id],
    }, {
      deviceIds: [user.deviceId],
    });

    if (result.logoLargeId !== null) {
      fileHelper.scheduleCommunityPreviewUpdate(user.id, result.id, result.logoLargeId);
    }

    return result;
  }
);

registerPostRoute<
  API.Community.updateCommunity.Request,
  API.Community.updateCommunity.Response
>(
  communityRouter,
  '/updateCommunity',
  validators.API.Community.updateCommunity,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_INFO
      ],
      communityId: data.id,
      userId: user.id
    });

    await communityHelper.updateCommunity(data);
  }
);

registerPostRoute<
  API.Community.createArea.Request,
  API.Community.createArea.Response
>(
  communityRouter,
  '/createArea',
  validators.API.Community.createArea,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_CHANNELS
      ],
      communityId: data.communityId,
      userId: user.id
    });

    const result = await communityHelper.createArea(data);
    const event: Events.Community.Area = {
      type: "cliAreaEvent",
      action: "new",
      data: {
        ...data,
        ...result
      }
    };
    await eventHelper.emit(event, {
      communityIds: [data.communityId],
    });
  }
);

registerPostRoute<
  API.Community.updateArea.Request,
  API.Community.updateArea.Response
>(
  communityRouter,
  '/updateArea',
  validators.API.Community.updateArea,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_CHANNELS
      ],
      communityId: data.communityId,
      userId: user.id
    });
    const result = await communityHelper.updateArea(data);
    const event: Events.Community.Area = {
      type: "cliAreaEvent",
      action: "update",
      data: {
        ...data,
        ...result
      }
    };
    await eventHelper.emit(event, {
      communityIds: [data.communityId],
    });
  }
);

registerPostRoute<
  API.Community.deleteArea.Request,
  API.Community.deleteArea.Response
>(
  communityRouter,
  '/deleteArea',
  validators.API.Community.deleteArea,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_CHANNELS
      ],
      communityId: data.communityId,
      userId: user.id
    });
    await communityHelper.deleteArea(data);
  }
);

registerPostRoute<
  API.Community.createChannel.Request,
  API.Community.createChannel.Response
>(
  communityRouter,
  '/createChannel',
  validators.API.Community.createChannel,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_CHANNELS
      ],
      communityId: data.communityId,
      userId: user.id
    });
    return await communityHelper.createChannel(data);
  }
);

registerPostRoute<
  API.Community.updateChannel.Request,
  API.Community.updateChannel.Response
>(
  communityRouter,
  '/updateChannel',
  validators.API.Community.updateChannel,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_CHANNELS
      ],
      communityId: data.communityId,
      userId: user.id
    });
    try {
      return await communityHelper.updateChannel(data);
    } catch (error) {
      if (error instanceof Error && error.message.includes('duplicate key value')) {
        throw new Error(errors.server.DUPLICATE_KEY);
      }
      throw error;
    }
  }
);

registerPostRoute<
  API.Community.deleteChannel.Request,
  API.Community.deleteChannel.Response
>(
  communityRouter,
  '/deleteChannel',
  validators.API.Community.deleteChannel,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_CHANNELS
      ],
      communityId: data.communityId,
      userId: user.id
    });
    return await communityHelper.deleteChannel(data);
  }
);

registerPostRoute<
  API.Community.createRole.Request,
  API.Community.createRole.Response
>(
  communityRouter,
  '/createRole',
  validators.API.Community.createRole,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_ROLES
      ],
      communityId: data.communityId,
      userId: user.id
    });
    return await communityHelper.createRole(data);
  }
);


registerPostRoute<
  API.Community.updateRole.Request,
  API.Community.updateRole.Response
>(
  communityRouter,
  '/updateRole',
  validators.API.Community.updateRole,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_ROLES
      ],
      communityId: data.communityId,
      userId: user.id
    });
    return await communityHelper.updateRole(data);
  }
);

registerPostRoute<
  API.Community.deleteRole.Request,
  API.Community.deleteRole.Response
>(
  communityRouter,
  '/deleteRole',
  validators.API.Community.deleteRole,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_ROLES
      ],
      communityId: data.communityId,
      userId: user.id
    });
    return await communityHelper.deleteRole(data);
  }
);

registerPostRoute<
  API.Community.checkCommunityRoleClaimability.Request,
  API.Community.checkCommunityRoleClaimability.Response
>(
  communityRouter,
  '/checkCommunityRoleClaimability',
  validators.API.Community.checkCommunityRoleClaimability,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const results = await onchainHelper.checkCommunityRoleClaimability({
      userId: user.id,
      communityId: data.communityId,
    });
    return results;
  }
);

registerPostRoute<
  API.Community.claimRole.Request,
  API.Community.claimRole.Response
>(
  communityRouter,
  '/claimRole',
  validators.API.Community.claimRole,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const [
      isMember,
      role,
    ] = await Promise.all([
      communityHelper.isCommunityMember(user.id, data.communityId),
      communityHelper.getRole(data.roleId),
    ]);

    if (
      isMember &&
      role.communityId === data.communityId
    ) {
      let canClaim = (role.assignmentRules?.type === 'free' && role.type === RoleType.CUSTOM_AUTO_ASSIGN);
      if (role.assignmentRules?.type === 'token' && role.type === RoleType.CUSTOM_AUTO_ASSIGN) {
        canClaim = await communityHelper.canClaimGatedRole(user.id, data.roleId);
      }
      if (canClaim === true) {
        await communityHelper.addUserToRoles({
          communityId: data.communityId,
          roleIds: [data.roleId],
          userId: user.id,
        });
        return true;
      }
    }
    return false;
  }
);

registerPostRoute<
  API.Community.addUserToRoles.Request,
  API.Community.addUserToRoles.Response
>(
  communityRouter,
  '/addUserToRoles',
  validators.API.Community.addUserToRoles,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_ROLES
      ],
      communityId: data.communityId,
      userId: user.id
    });
    return await communityHelper.addUserToRoles(data);
  }
);

registerPostRoute<
  API.Community.removeUserFromRoles.Request,
  API.Community.removeUserFromRoles.Response
>(
  communityRouter,
  '/removeUserFromRoles',
  validators.API.Community.removeUserFromRoles,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_ROLES
      ],
      communityId: data.communityId,
      userId: user.id
    });
    return await communityHelper.removeUserFromRoles(data);
  }
);

/* TOKEN */

registerPostRoute<
  API.Community.addCommunityToken.Request,
  API.Community.addCommunityToken.Response
>(
  communityRouter,
  '/addCommunityToken',
  validators.API.Community.addCommunityToken,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_ROLES
      ],
      communityId: data.communityId,
      userId: user.id
    });
    return await communityHelper.addCommunityToken(data);
  }
);

registerPostRoute<
  API.Community.removeCommunityToken.Request,
  API.Community.removeCommunityToken.Response
>(
  communityRouter,
  '/removeCommunityToken',
  validators.API.Community.removeCommunityToken,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_ROLES
      ],
      communityId: data.communityId,
      userId: user.id
    });
    return await communityHelper.removeCommunityToken(data);
  }
);

/* PREMIUM */

registerPostRoute<
  API.Community.givePointsToCommunity.Request,
  API.Community.givePointsToCommunity.Response
>(
  communityRouter,
  '/givePointsToCommunity',
  validators.API.Community.givePointsToCommunity,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    return await communityHelper.givePointsToCommunity(user.id, data);
  }
);

registerPostRoute<
  API.Community.buyCommunityPremiumFeature.Request,
  API.Community.buyCommunityPremiumFeature.Response
>(
  communityRouter,
  '/buyCommunityPremiumFeature',
  validators.API.Community.buyCommunityPremiumFeature as any,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_ROLES
      ],
      communityId: data.communityId,
      userId: user.id
    });
    return await communityHelper.buyCommunityPremiumFeature(user.id, data);
  }
);

registerPostRoute<
  API.Community.setPremiumFeatureAutoRenew.Request,
  API.Community.setPremiumFeatureAutoRenew.Response
>(
  communityRouter,
  '/setPremiumFeatureAutoRenew',
  validators.API.Community.setPremiumFeatureAutoRenew,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_ROLES
      ],
      communityId: data.communityId,
      userId: user.id
    });
    return await communityHelper.setPremiumFeatureAutoRenew(data);
  }
);

/* ONBOARDING */ 
registerPostRoute<
  API.Community.getCommunityPassword.Request,
  API.Community.getCommunityPassword.Response
>(
  communityRouter,
  '/getCommunityPassword',
  validators.API.Community.getCommunityPassword,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_ROLES
      ],
      communityId: data.communityId,
      userId: user.id
    });
    return await communityHelper.getCommunityPassword(data.communityId);
  }
);

registerPostRoute<
  API.Community.verifyCommunityPassword.Request,
  API.Community.verifyCommunityPassword.Response
>(
  communityRouter,
  '/verifyCommunityPassword',
  validators.API.Community.verifyCommunityPassword,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const password = await communityHelper.getCommunityPassword(data.communityId);
    return {
      valid: (!password.password && !data.password) || password.password === data.password
    }
  }
);

registerPostRoute<
  API.Community.setOnboardingOptions.Request,
  API.Community.setOnboardingOptions.Response
>(
  communityRouter,
  '/setOnboardingOptions',
  validators.API.Community.setOnboardingOptions,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_ROLES
      ],
      communityId: data.communityId,
      userId: user.id
    });
    return await communityHelper.setOnboardingOptions(data.communityId, data.onboardingOptions, data.password);
  }
);

registerPostRoute<
  API.Community.getPendingJoinApprovals.Request,
  API.Community.getPendingJoinApprovals.Response
>(
  communityRouter,
  '/getPendingJoinApprovals',
  validators.API.Community.getPendingJoinApprovals,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_USER_APPLICATIONS
      ],
      communityId: data.communityId,
      userId: user.id
    });
    return await communityHelper.getPendingJoinApprovals(data.communityId);
  }
);

registerPostRoute<
  API.Community.setAllPendingJoinApprovals.Request,
  API.Community.setAllPendingJoinApprovals.Response
>(
  communityRouter,
  '/setAllPendingJoinApprovals',
  validators.API.Community.setAllPendingJoinApprovals,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_USER_APPLICATIONS
      ],
      communityId: data.communityId,
      userId: user.id
    });
    return await communityHelper.setAllPendingJoinApprovals(data.communityId, data.approvalState as CommunityApprovalState);
  }
);

registerPostRoute<
  API.Community.setPendingJoinApproval.Request,
  API.Community.setPendingJoinApproval.Response
>(
  communityRouter,
  '/setPendingJoinApproval',
  validators.API.Community.setPendingJoinApproval,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_USER_APPLICATIONS
      ],
      communityId: data.communityId,
      userId: user.id
    });
    return await communityHelper.setPendingJoinApproval(data.communityId, data.userId, data.approvalState as CommunityApprovalState, data.message);
  }
);

registerPostRoute<
  API.Community.getBannedUsers.Request,
  API.Community.getBannedUsers.Response
>(
  communityRouter,
  '/getBannedUsers',
  validators.API.Community.getBannedUsers,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MODERATE
      ],
      communityId: data.communityId,
      userId: user.id
    });
    return await communityHelper.getBannedUsers(data.communityId, data.limit, data.before);
  }
);

registerPostRoute<
  API.Community.getArticleList.Request,
  API.Community.getArticleList.Response
>(
  communityRouter,
  '/getArticleList',
  validators.API.Community.getArticleList,
  async (request, response, data) => {
    const { user } = request.session;
    if (data.drafts) {
      if (!user) {
        throw new Error(errors.server.LOGIN_REQUIRED);
      }
      if (!data.communityId) {
        console.error("drafts can only be retrieved with communityId");
        throw new Error(errors.server.INVALID_REQUEST);
      }
      await permissionHelper.hasPermissionsOrThrow({
        permissions: [
          CommunityPermission.COMMUNITY_MANAGE_ARTICLES
        ],
        communityId: data.communityId,
        userId: user.id
      });
    }
    return await articleHelper.getCommunityArticleList(user?.id, data);
  }
);

registerPostRoute<
  API.Community.getArticleDetailView.Request,
  API.Community.getArticleDetailView.Response
>(
  communityRouter,
  '/getArticleDetailView',
  validators.API.Community.getArticleDetailView as any, // Todo: Fix type problem
  async (request, response, data) => {
    const { user } = request.session;
    return await articleHelper.getCommunityArticleDetailView(user?.id, data);
  }
);

registerPostRoute<
  API.Community.createArticle.Request,
  API.Community.createArticle.Response
>(
  communityRouter,
  '/createArticle',
  validators.API.Community.createArticle,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      communityId: data.communityArticle.communityId,
      userId: user.id,
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_ARTICLES
      ]
    })
    const result = await articleHelper.createCommunityArticle(user.id, data);
    const communityArticle: Models.Community.CommunityArticle = {
      ...data.communityArticle,
      articleId: result.articleId,
      published: result.published,
      updatedAt: result.updatedAt,
      sentAsNewsletter: null,
      markAsNewsletter: false,
    };
    const article: Models.BaseArticle.DetailView = {
      ...data.article,
      articleId: result.articleId,
      channelId: result.channelId,
      creatorId: user.id,
      commentCount: 0,
      latestCommentTimestamp: null,
    }
    return { communityArticle, article };
  }
);

registerPostRoute<
  API.Community.updateArticle.Request,
  API.Community.updateArticle.Response
>(
  communityRouter,
  '/updateArticle',
  validators.API.Community.updateArticle,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      communityId: data.communityArticle.communityId,
      userId: user.id,
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_ARTICLES
      ]
    })
    return await articleHelper.updateCommunityArticle(data);
  }
);

registerPostRoute<
  API.Community.deleteArticle.Request,
  API.Community.deleteArticle.Response
>(
  communityRouter,
  '/deleteArticle',
  validators.API.Community.deleteArticle,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      communityId: data.communityId,
      userId: user.id,
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_ARTICLES
      ]
    })
    return await articleHelper.deleteCommunityArticle(data);
  }
);

registerPostRoute<
  API.Community.sendArticleAsEmail.Request,
  API.Community.sendArticleAsEmail.Response
>(
  communityRouter, 
  '/sendArticleAsEmail', 
  validators.API.Community.sendArticleAsEmail, 
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      communityId: data.communityId,
      userId: user.id,
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_ARTICLES
      ]
    });
    const isCommunityWhitelisted = await communityHelper.isCommunityWhitelisted(data.communityId);
    if(!isCommunityWhitelisted) {
      throw new Error(errors.server.NOT_ALLOWED);
    } else {
      return await articleHelper.registerCommunityArticleForEmails(data.articleId, data.communityId);
    }
  }
);

registerPostRoute<
  API.Community.getCall.Request,
  API.Community.getCall.Response
>(
  communityRouter,
  '/getCall',
  validators.API.Community.getCall,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    
    await permissionHelper.hasPermissionsOrThrow({
      communityId: data.communityId,
      userId: user.id,
      permissions: [ CommunityPermission.WEBRTC_CREATE ],
    });
    
    return communityHelper.getCall(data);
  }
);

registerPostRoute<
  API.Community.startCall.Request,
  API.Community.startCall.Response
>(
  communityRouter,
  '/startCall',
  validators.API.Community.startCall,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      communityId: data.communityId,
      userId: user.id,
      permissions: [
        data.rolePermissions === undefined ? CommunityPermission.WEBRTC_CREATE : CommunityPermission.WEBRTC_CREATE_CUSTOM
      ],
    });
    const callData = await callHelper.createCall(data);
    const targetRoleIds = callData.rolePermissions
      .filter(rp => rp.permissions.includes(CallPermission.CALL_EXISTS))
      .map(rp => rp.roleId);
      
    const userIdsToNotify = await callHelper.getUserIdsToNotify({
      callId: callData.id,
      communityId: callData.communityId,
    });
    const createdAndUpdated = new Date().toISOString();
    const notification: Models.Notification.ApiNotification = {
      type: 'Call',
      createdAt: createdAndUpdated,
      updatedAt: createdAndUpdated,
      extraData: {
        type: 'callData',
        callId: callData.id,
        callTitle: callData.title,
        channelId: callData.channelId,
        communityUrl: callData.communityUrl,
        communityTitle: callData.communityTitle,
      },
      id: t.uuid(),
      read: false,
      subjectCommunityId: callData.communityId,
      subjectItemId: null,
      subjectUserId: null,
      subjectArticleId: null,
      text: `Call "${callData.title}" started in ${callData.communityTitle}`,
    };
    for (const userId of userIdsToNotify) {
      if (user.id !== userId) {
        eventHelper.sendWsOrWebPushNotificationEvent({
          userId,
          event: {
            type: "cliNotificationEvent",
            action: "new",
            data: notification,
          },
        });
      }
    }

    eventHelper.emit({
      type: 'cliCallEvent',
      action: 'new',
      data: callData,
    }, {
      roleIds: targetRoleIds,
    });
    return callData;
  }
);

registerPostRoute<
  API.Community.startScheduledCall.Request,
  API.Community.startScheduledCall.Response
>(
  communityRouter,
  '/startScheduledCall',
  validators.API.Community.startScheduledCall,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const communityEvent = await communityEventHelper.getCommunityEvent({ id: data.communityEventId }, user.id);

    const hasPermissions = (await Promise.all([
      permissionHelper.hasPermissions({ communityId: communityEvent.communityId, userId: user.id, permissions: [ CommunityPermission.COMMUNITY_MANAGE_EVENTS ]}),
      permissionHelper.hasPermissions({ communityEventId: data.communityEventId, userId: user.id, permissions: [ CommunityEventPermission.EVENT_MODERATE ]}),
    ])).some(p => p === true);
    if (!hasPermissions) {
      throw new Error(errors.server.NOT_ALLOWED);
    }
    
    const callData = await callHelper.startScheduledCall({ communityEventId: data.communityEventId, callStarter: user.id });
    const targetRoleIds = communityEvent.rolePermissions
      .filter(rp => rp.permissions.includes(CommunityEventPermission.EVENT_PREVIEW))
      .map(rp => rp.roleId);
      
    const userIdsToNotify = await callHelper.getUserIdsToNotify({
      callId: callData.id,
      communityId: callData.communityId,
    });
    const createdAndUpdated = new Date().toISOString();
    const notification: Models.Notification.ApiNotification = {
      type: 'Call',
      createdAt: createdAndUpdated,
      updatedAt: createdAndUpdated,
      extraData: {
        type: 'callData',
        callId: callData.id,
        callTitle: callData.title,
        channelId: callData.channelId,
        communityUrl: callData.communityUrl,
        communityTitle: callData.communityTitle,
      },
      id: t.uuid(),
      read: false,
      subjectCommunityId: callData.communityId,
      subjectItemId: null,
      subjectUserId: null,
      subjectArticleId: null,
      text: `Call "${callData.title}" started in ${callData.communityTitle}`,
    };
    for (const userId of userIdsToNotify) {
      if (user.id !== userId) {
        eventHelper.sendWsOrWebPushNotificationEvent({
          userId,
          event: {
            type: "cliNotificationEvent",
            action: "new",
            data: notification,
          },
        });
      }
    }

    eventHelper.emit({
      type: 'cliCallEvent',
      action: 'new',
      data: callData,
    }, {
      roleIds: targetRoleIds,
    });
    return callData;
  }
);

registerPostRoute<
  API.Community.getCurrentCalls.Request,
  API.Community.getCurrentCalls.Response
>(
  communityRouter,
  '/getCurrentCalls',
  validators.API.Community.getCurrentCalls,
  async (request, response, data) => {
    const { user } = request.session;

    return callHelper.getHomepageCalls(user?.id, data.offset);
  }
);

registerPostRoute<
  API.Community.getCallParticipantEvents.Request,
  API.Community.getCallParticipantEvents.Response
>(
  communityRouter,
  '/getCallParticipantEvents',
  validators.API.Community.getCallParticipantEvents,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      callId: data.callId,
      userId: user.id,
      permissions: [
        CallPermission.CALL_EXISTS,
      ],
    });
    return callHelper.getCallParticipantEvents(data.callId);
  }
);

registerPostRoute<
  API.Community.setChannelPinState.Request,
  API.Community.setChannelPinState.Response
>(
  communityRouter,
  '/setChannelPinState',
  validators.API.Community.setChannelPinState,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      communityId: data.communityId,
      channelId: data.channelId,
      userId: user.id,
      permissions: [
        ChannelPermission.CHANNEL_EXISTS,
        ChannelPermission.CHANNEL_READ,
      ],
    });
    await communityHelper.setChannelPinState({
      ...data,
      userId: user.id,
    });
    const event: Events.Community.Channel = {
      type: 'cliChannelEvent',
      action: 'update',
      data,
    };
    eventHelper.emit(event, {
      userIds: [user.id],
    }, {
      deviceIds: [user.deviceId],
    });
  }
);

registerPostRoute<
  API.Community.getTagFrequencyData.Request,
  API.Community.getTagFrequencyData.Response
>(
  communityRouter,
  '/getTagFrequencyData',
  undefined,
  async (request, response, data) => {
    return await communityHelper.getTagFrequencyData();
  }
);

registerPostRoute<
  API.Community.getEventList.Request,
  API.Community.getEventList.Response
>(
  communityRouter,
  '/getEventList',
  validators.API.Community.getEventList,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    return await communityEventHelper.getCommunityEvents(data.communityId, user.id);
  }
);

registerPostRoute<
  API.Community.getMyEvents.Request,
  API.Community.getMyEvents.Response
>(
  communityRouter,
  '/getMyEvents',
  validators.API.Community.getMyEvents,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    return await communityEventHelper.getMyEvents(user.id, data.scheduledBefore, data.beforeId);
  }
);

registerPostRoute<
  API.Community.getUpcomingEvents.Request,
  API.Community.getUpcomingEvents.Response
>(
  communityRouter,
  '/getUpcomingEvents',
  validators.API.Community.getUpcomingEvents,
  async (request, response, data) => {
    const { user } = request.session;
    return await communityEventHelper.getUpcomingEvents(user?.id, data);
  }
);

registerPostRoute<
  API.Community.getEvent.Request,
  API.Community.getEvent.Response
>(
  communityRouter,
  '/getEvent',
  validators.API.Community.getEventById,
  async (request, response, data) => {
    const { user } = request.session;
    return await communityEventHelper.getCommunityEvent(data, user?.id);
  }
);

registerPostRoute<
  API.Community.createCommunityEvent.Request,
  API.Community.createCommunityEvent.Response
>(
  communityRouter,
  '/createCommunityEvent',
  validators.API.Community.createCommunityEvent,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_EVENTS
      ],
      communityId: data.communityId,
      userId: user.id
    });
    if (new Date(data.scheduleDate).getTime() < new Date().getTime()) {
      throw new Error(errors.server.EVENT_SCHEDULE_IN_THE_PAST);
    }
    if (data.duration > 8 * 60) {
      throw new Error(errors.server.EVENT_TOO_LONG);
    }

    if (data.type !== "reminder") {
      const communityCallTier = await communityHelper.getCommunityPremiumTier(data.communityId);
      const callSlots = callHelper.getCallSlots(communityCallTier, data.type === "call" ? CallType.DEFAULT : CallType.BROADCAST);
      const call = await callHelper.createCall({
        callCreator: user.id,
        title: data.title,
        callType: data.type === "call" ? CallType.DEFAULT : CallType.BROADCAST,
        communityId: data.communityId,
        description: data.description ? data.description.slice(0, 200) : null,
        rolePermissions: convertEventPermissionToCallPermission(data.rolePermissions),
        slots: data.callData?.slots || callSlots.overallCallSlots,
        stageSlots: data.callData?.stageSlots || callSlots.stageSlots,
        audioOnly: data.callData?.audioOnly || false,
        hd: data.callData?.hd || false,
      }, data.scheduleDate);
      return await communityEventHelper.createCommunityEvent(data, call.id, user.id);
    }
    else {
      return await communityEventHelper.createCommunityEvent(data, null, user.id);
    }
  }
);

registerPostRoute<
  API.Community.updateCommunityEvent.Request,
  API.Community.updateCommunityEvent.Response
>(
  communityRouter,
  '/updateCommunityEvent',
  validators.API.Community.updateCommunityEvent,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    //check if old event is ongoing
    const isOngoing = await communityEventHelper.isEventOngoingOrInPast(data.id);
    if (isOngoing) {
      throw new Error(errors.server.EVENT_ONGOING);
    }
    
    const eventData = await communityEventHelper.getCommunityEvent({ id: data.id }, user.id);
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_EVENTS
      ],
      communityId: eventData.communityId,
      userId: user.id
    });
    
    if (new Date(data.scheduleDate).getTime() < new Date().getTime()) {
      throw new Error(errors.server.EVENT_SCHEDULE_IN_THE_PAST);
    }

    // // Can't go for something that would delete a call
    // if (eventData.type !== 'external' && data.type === 'external') {
    //   throw new Error(errors.server.EVENT_INVALID_TYPE_CHANGE);
    // }

    // // Can't go for something that would create a call
    // if (eventData.type === 'external' && data.type !== 'external') {
    //   throw new Error(errors.server.EVENT_INVALID_TYPE_CHANGE);
    // }

    const result = await communityEventHelper.updateCommunityEvent(data);
    if (!!eventData.callId && data.type !== 'external') {
      const communityCallTier = await communityHelper.getCommunityPremiumTier(eventData.communityId);
      const callSlots = callHelper.getCallSlots(communityCallTier, data.type === "call" ? CallType.DEFAULT : CallType.BROADCAST);

      if (!!eventData.callId) {
        await callHelper.updateCall({
          id: eventData.callId,
          title: data.title,
          callType: data.type === "call" ? CallType.DEFAULT : CallType.BROADCAST,
          communityId: eventData.communityId,
          description: data.description ? data.description.slice(0, 200) : null,
          rolePermissions: convertEventPermissionToCallPermission(data.rolePermissions),
          slots: data.callData?.slots || callSlots.overallCallSlots,
          stageSlots: data.callData?.stageSlots || callSlots.stageSlots,
          audioOnly: data.callData?.audioOnly || false,
          hd: data.callData?.hd || false,
        }, data.scheduleDate);
      } else {
        await callHelper.createCall({
          callCreator: user.id,
          title: data.title,
          callType: data.type === "call" ? CallType.DEFAULT : CallType.BROADCAST,
          communityId: eventData.communityId,
          description: data.description ? data.description.slice(0, 200) : null,
          rolePermissions: convertEventPermissionToCallPermission(data.rolePermissions),
          slots: data.callData?.slots || callSlots.overallCallSlots,
          stageSlots: data.callData?.stageSlots || callSlots.stageSlots,
          audioOnly: data.callData?.audioOnly || false,
          hd: data.callData?.hd || false,
        }, data.scheduleDate);
      }
    }

    // Todo: If event ever creates notifications, emit them here
    // email failures must not fail the update itself
    try {
      const eventOptions = await communityEventHelper.prepareEventToSendEmail(result.id, user.id, "changed", result);
      const userEmails = await communityEventHelper.getUserEmailsToNotify({eventId: result.id});
      for (const userEmail of userEmails) {
        await emailUtils.sendEventEmail(userEmail, eventOptions);
      }
    } catch (e) {
      console.error("Error sending event update emails", e);
    }
    return result;
  }
);

registerPostRoute<
  API.Community.deleteCommunityEvent.Request,
  API.Community.deleteCommunityEvent.Response
>(
  communityRouter,
  '/deleteCommunityEvent',
  validators.API.Community.deleteCommunityEvent,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const isOngoing = await communityEventHelper.isEventOngoingOrInPast(data.eventId);
    if (isOngoing) {
      throw new Error(errors.server.INVALID_REQUEST);
    }
    const hasPermissions = (await Promise.all([
      permissionHelper.hasPermissions({ communityId: data.communityId, userId: user.id, permissions: [ CommunityPermission.COMMUNITY_MANAGE_EVENTS ]}),
      permissionHelper.hasPermissions({ communityEventId: data.eventId, userId: user.id, permissions: [ CommunityEventPermission.EVENT_MODERATE ]}),
    ])).some(p => p === true);
    if (!hasPermissions) {
      throw new Error(errors.server.NOT_ALLOWED);
    }
    const existingEvent = await communityEventHelper.getCommunityEvent({ id: data.eventId }, user.id);
    await communityEventHelper.deleteCommunityEvent(data.eventId);

    // email failures must not fail the deletion itself
    try {
      const eventOptions = await communityEventHelper.prepareEventToSendEmail(data.eventId, user.id, "cancelled", existingEvent);
      const userEmails = await communityEventHelper.getUserEmailsToNotify({eventId: data.eventId});
      for (const userEmail of userEmails) {
        await emailUtils.sendEventEmail(userEmail, eventOptions);
      }
    } catch (e) {
      console.error("Error sending event cancellation emails", e);
    }
  }
);

registerPostRoute<
  API.Community.getEventParticipants.Request,
  API.Community.getEventParticipants.Response
>(
  communityRouter,
  '/getEventParticipants',
  validators.API.Community.getEventParticipants,
  async (request, response, data) => {
    return await communityEventHelper.getEventParticipants(data.eventId);
  }
);

registerPostRoute<
  API.Community.addEventParticipant.Request,
  API.Community.addEventParticipant.Response
>(
  communityRouter,
  '/addEventParticipant',
  validators.API.Community.addEventParticipant,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await communityEventHelper.insertEventParticipant(user.id, data);
    // email failures must not fail the registration itself
    try {
      const eventOptions = await communityEventHelper.prepareEventToSendEmail(data.eventId, user.id, "attending");
      const userEmail = await userHelper.getUserEmail(user.id);
      if (!!userEmail) {
        await emailUtils.sendEventEmail(userEmail, eventOptions);
      }
    } catch (e) {
      console.error("Error sending event attendance email", e);
    }
  }
);

registerPostRoute<
  API.Community.addEventParticipantByCallId.Request,
  API.Community.addEventParticipantByCallId.Response
>(
  communityRouter,
  '/addEventParticipantByCallId',
  validators.API.Community.addEventParticipantByCallId,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    return await communityEventHelper.insertEventParticipantByCallId(user.id, data);
  }
);

registerPostRoute<
  API.Community.removeEventParticipant.Request,
  API.Community.removeEventParticipant.Response
>(
  communityRouter,
  '/removeEventParticipant',
  validators.API.Community.removeEventParticipant,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    return await communityEventHelper.eventParticipantLeave(user.id, data);
  }
);

registerPostRoute<
  API.Community.getTransactionData.Request,
  API.Community.getTransactionData.Response
>(
  communityRouter,
  '/getTransactionData',
  validators.API.Community.getTransactionData,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_INFO,
      ],
      communityId: data.communityId,
      userId: user.id
    });
    return await communityHelper.getTransactionData(data.communityId);
  }
);

registerPostRoute<
  API.Community.updateNotificationState.Request,
  API.Community.updateNotificationState.Response
>(
  communityRouter,
  '/updateNotificationState',
  validators.API.Community.updateNotificationState,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    return await communityHelper.updateNotificationState(user.id, data);
  }
);

registerPostRoute<
  API.Community.subscribeToCommunityNewsletter.Request,
  API.Community.subscribeToCommunityNewsletter.Response
>(
  communityRouter,
  '/subscribeToCommunityNewsletter',
  validators.API.Community.subscribeToCommunityNewsletter,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    return await newsletterHelper.subscribeUser(user.id, data.communityIds);
  }
);

registerPostRoute<
  API.Community.unsubscribeFromCommunityNewsletter.Request,
  API.Community.unsubscribeFromCommunityNewsletter.Response
>(
  communityRouter,
  '/unsubscribeFromCommunityNewsletter',
  validators.API.Community.unsubscribeFromCommunityNewsletter,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    return await newsletterHelper.unsubscribeUser(user.id, data.communityIds);
  }
);

registerPostRoute<
  API.Community.getLatestArticleSentAsNewsletterDate.Request,
  API.Community.getLatestArticleSentAsNewsletterDate.Response
>(
  communityRouter,
  '/getLatestArticleSentAsNewsletterDate',
  validators.API.Community.getLatestArticleSentAsNewsletterDate,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_INFO,
      ],
      communityId: data.communityId,
      userId: user.id
    });

    const isWhitelisted = await communityHelper.isCommunityWhitelisted(data.communityId);
    if (!isWhitelisted) {
      throw new Error(errors.server.NOT_ALLOWED);
    }

    return await newsletterHelper.getLatestCommunityNewsletterSentDate(data.communityId);
  }
);

registerPostRoute<
  API.Community.getNewsletterHistory.Request,
  API.Community.getNewsletterHistory.Response
>(
  communityRouter,
  '/getNewsletterHistory',
  validators.API.Community.getNewsletterHistory,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }

    await permissionHelper.hasPermissionsOrThrow({
      permissions: [
        CommunityPermission.COMMUNITY_MANAGE_INFO,
      ],
      communityId: data.communityId,
      userId: user.id
    });
    
    let cutDate: string;
    if (data.timeframe === '30days' || data.timeframe === '90days') {
      cutDate = dayjs().subtract(data.timeframe === '30days' ? 30 : 90, 'days').toISOString()
    } else {
      cutDate = dayjs().subtract(1, 'year').toISOString()
    }

    const isWhitelisted = await communityHelper.isCommunityWhitelisted(data.communityId);
    if (!isWhitelisted) {
      throw new Error(errors.server.NOT_ALLOWED);
    }

    const history = await newsletterHelper.getNewsletterHistory(user.id, data.communityId, cutDate);
    return {
      entries: history
    }
  }
);

registerPostRoute<
  API.Community.getAirdropClaimHistory.Request,
  API.Community.getAirdropClaimHistory.Response
>(
  communityRouter,
  '/getAirdropClaimHistory',
  validators.API.Community.getAirdropClaimHistory,
  async (request, response, data) => {
    const result = await communityHelper.getAirdropClaimHistory(data.communityId, data.roleId);
    const claimData = result.map(item => ({
      userId: item.userId,
      claimedAt: item.claimedAt,
    }));
    return {
      claimData,
    };
  }
);

registerPostRoute<
  API.Community.getAirdropCommunities.Request,
  API.Community.getAirdropCommunities.Response
>(
  communityRouter,
  '/getAirdropCommunities',
  validators.API.Community.getAirdropCommunities,
  async (request, response, data) => {
    const result = await communityHelper.getAirdropCommunities(data.status, request.session.user?.id);
    return result;
  }
);

export default communityRouter;
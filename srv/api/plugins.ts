// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from "express";
import errors from "../common/errors";
import validators from "../validators";
import { registerPostRoute } from "./util";
import pluginHelper from "../repositories/plugins";
import crypto from "crypto";
import userHelper from "../repositories/users";
import { getDisplayNameString } from "../util";
import communityHelper from "../repositories/communities";
import redisManager from "../redis";
import { PluginPermission, PredefinedRole, RoleType } from "../common/enums";
import eventHelper from "../repositories/event";
import fileHelper from "../repositories/files";
import config from "../common/config";
import dayjs from "dayjs";
import ipRateLimitHandler from "../util/rateLimit";
const pluginRouter = express.Router();

const dataClient = redisManager.getClient('data');

/** Signed plugin requests are accepted for this long after they were issued. */
const PLUGIN_REQUEST_MAX_AGE_MS = 10 * 60 * 1000;
/** Tolerated clock difference for request timestamps in the future. */
const PLUGIN_REQUEST_MAX_SKEW_MS = 2 * 60 * 1000;
/** Replay keys must outlive the acceptance window above. */
const PLUGIN_REQUEST_REPLAY_TTL_S = 15 * 60;

/**
 * Plugins call this for every user/community lookup; the client throttles
 * each iframe to 100 requests per minute, so the per-user budget leaves room
 * for several plugins at once.
 */
const pluginRequestRateLimiter = ipRateLimitHandler({
  windowMs: 1000 * 60, // 1 min
  identity: (req) => req.session?.user?.id,
  limit_identity: 300,
  limit_v4_v6_64: 300,
  limit_v6_56: 600,
  limit_v6_48: 1200,
});

async function emitEventFilterConfigForNonAdmins({ event, adminRoleId, communityId }: { event: Events.Community.Plugin, adminRoleId: string, communityId: string }) {
  const nonAdminEvent: Events.Community.Plugin = JSON.parse(JSON.stringify(event));
  if ('config' in nonAdminEvent.data) {
    nonAdminEvent.data.config = null;
  }

  await eventHelper.emit(event, {
    roleIds: [adminRoleId],
  });

  await eventHelper.emit(nonAdminEvent, {
    communityIds: [communityId],
  }, {
    roleIds: [adminRoleId],
  });
}

registerPostRoute<
  API.Plugins.createPlugin.Request,
  API.Plugins.createPlugin.Response
>(
  pluginRouter,
  '/createPlugin',
  validators.API.Plugin.createPlugin,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }

    // Only admins can create plugins
    const community = await communityHelper.getCommunityDetailView({ id: data.communityId }, user.id);
    const adminRole = community.roles.find(role => role.title === PredefinedRole.Admin && role.type === RoleType.PREDEFINED);
    if (!adminRole || !community.myRoleIds.includes(adminRole.id)) {
      throw new Error(errors.server.NOT_ALLOWED);
    }

    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });

    // Check if the community has reached the plugin limit
    if (community.plugins.length >= config.PREMIUM.COMMUNITY_FREE.PLUGIN_LIMIT) {
      throw new Error(errors.server.PLUGIN_LIMIT_EXCEEDED);
    }

    const plugin = await pluginHelper.createPlugin(data, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey.export({ type: 'spki', format: 'pem' }).toString());

    const event: Events.Community.Plugin = {
      type: "cliPluginEvent",
      action: "new",
      data: {
        ...plugin,
        reportFlagged: false,
      },
    };

    await emitEventFilterConfigForNonAdmins({
      event,
      adminRoleId: adminRole.id,
      communityId: data.communityId,
    });

    return {
      id: plugin.id,
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
  }
);

registerPostRoute<
  API.Plugins.clonePlugin.Request,
  API.Plugins.clonePlugin.Response
>(
  pluginRouter,
  '/clonePlugin',
  validators.API.Plugin.clonePlugin,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }

    // Only admins can clone plugins
    const community = await communityHelper.getCommunityDetailView({ id: data.targetCommunityId }, user.id);
    const adminRole = community.roles.find(role => role.title === PredefinedRole.Admin && role.type === RoleType.PREDEFINED);
    if (!adminRole || !community.myRoleIds.includes(adminRole.id)) {
      throw new Error(errors.server.NOT_ALLOWED);
    }

    // Check if the community has reached the plugin limit
    if (community.plugins.length >= config.PREMIUM.COMMUNITY_FREE.PLUGIN_LIMIT) {
      throw new Error(errors.server.PLUGIN_LIMIT_EXCEEDED);
    }

    const clonedPluginId = await pluginHelper.clonePlugin(data);

    const targetCommunity = await communityHelper.getCommunityDetailView({ id: data.targetCommunityId }, user.id);
    const clonedPlugin = targetCommunity.plugins.find(plugin => plugin.id === clonedPluginId);

    if (clonedPlugin) {
      const event: Events.Community.Plugin = {
        type: "cliPluginEvent",
        action: "new",
        data: clonedPlugin,
      };

      await emitEventFilterConfigForNonAdmins({
        event,
        adminRoleId: adminRole.id,
        communityId: data.targetCommunityId,
      });
    }

    return {
      ok: true,
    };
  }
);

registerPostRoute<
  API.Plugins.updatePlugin.Request,
  API.Plugins.updatePlugin.Response
>(
  pluginRouter,
  '/updatePlugin',
  validators.API.Plugin.updatePlugin,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }

    // Only admins can update plugins
    const community = await communityHelper.getCommunityDetailView({ id: data.communityId }, user.id);
    const adminRole = community.roles.find(role => role.title === PredefinedRole.Admin && role.type === RoleType.PREDEFINED);
    if (!adminRole || !community.myRoleIds.includes(adminRole.id)) {
      throw new Error(errors.server.NOT_ALLOWED);
    }
    // Check if plugin really exists in this community
    const plugin = community.plugins.find(plugin => plugin.id === data.id);
    if (!plugin) {
      throw new Error(errors.server.NOT_FOUND);
    }

    // If trying to update plugin data, check if community is the plugin owner
    if (data.pluginData) {
      if (!plugin || plugin.ownerCommunityId !== data.communityId) {
        throw new Error(errors.server.NOT_ALLOWED);
      }
    }

    await pluginHelper.updatePlugin(data);

    // If url is changed, reset accepted permissions
    const urlChanged = data.pluginData && plugin.url !== data.pluginData.url;
    if (urlChanged) {
      await pluginHelper.resetPluginStatePermissions(plugin.pluginId);
    }

    // Basic update event
    const event: Events.Community.Plugin = {
      type: "cliPluginEvent",
      action: "update",
      data: {
        id: data.id,
        communityId: data.communityId,
        name: data.name,
        config: data.config,
      },
    };

    await emitEventFilterConfigForNonAdmins({
      event,
      adminRoleId: adminRole.id,
      communityId: data.communityId,
    });

    if (data.pluginData) {
      const dataUpdateData: Events.Community.Plugin['data'] = {
        pluginId: data.pluginData.pluginId,
        url: data.pluginData.url,
        description: data.pluginData.description,
        imageId: data.pluginData.imageId,
        permissions: data.pluginData.permissions,
        clonable: data.pluginData.clonable,
      }

      if (urlChanged) {
        dataUpdateData.acceptedPermissions = [];
      }

      const dataUpdateEvent: Events.Community.Plugin = {
        type: "cliPluginEvent",
        action: "dataUpdate",
        data: dataUpdateData,
      };

      const targetCommunityIds = await pluginHelper.getCommunitiesWithPlugin(plugin.pluginId);

      await eventHelper.emit(dataUpdateEvent, {
        communityIds: targetCommunityIds,
      });
    }

    return {
      ok: true,
    };
  }
);

registerPostRoute<
  API.Plugins.deletePlugin.Request,
  API.Plugins.deletePlugin.Response
>(
  pluginRouter,
  '/deletePlugin',
  validators.API.Plugin.deletePlugin,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }

    const communityPlugin = await pluginHelper.getCommunityPlugin(data.id);
    const plugin = await pluginHelper.getPlugin(communityPlugin.pluginId);
    if (!communityPlugin || !plugin) {
      throw new Error(errors.server.NOT_FOUND);
    }

    // Only admins can delete plugins
    const community = await communityHelper.getCommunityDetailView({ id: communityPlugin.communityId }, user.id);
    const adminRole = community.roles.find(role => role.title === PredefinedRole.Admin && role.type === RoleType.PREDEFINED);
    if (!adminRole || !community.myRoleIds.includes(adminRole.id)) {
      throw new Error(errors.server.NOT_ALLOWED);
    }

    // Check if plugin really exists in this community
    if (!community.plugins.some(plugin => plugin.id === data.id)) {
      throw new Error(errors.server.NOT_FOUND);
    }

    const { deletedForCommunityIds } = await pluginHelper.deletePlugin(data.id);

    // If plugin is owned by the original community, emit event to all communities
    if (plugin.ownerCommunityId === communityPlugin.communityId) {
      const dataDeleteEvent: Events.Community.Plugin = {
        type: "cliPluginEvent",
        action: "dataDelete",
        data: {
          pluginId: plugin.id,
        },
      };

      await eventHelper.emit(dataDeleteEvent, {
        communityIds: deletedForCommunityIds,
      });
    }
    // If plugin is not owned by the original community, emit event to the original community
    else {
      const event: Events.Community.Plugin = {
        type: "cliPluginEvent",
        action: "delete",
        data: {
          id: communityPlugin.id,
          communityId: communityPlugin.communityId,
        },
      };

      await eventHelper.emit(event, {
        communityIds: [communityPlugin.communityId],
      });
    }

    return {
      ok: true,
    };
  }
);

registerPostRoute<
  API.Plugins.pluginRequest.Request,
  API.Plugins.pluginRequest.Response
>(
  pluginRouter,
  '/pluginRequest',
  validators.API.Plugin.pluginRequest,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await pluginRequestRateLimiter(request, response);

    // Parse and validate the inner request
    let pluginRequest: API.Plugins.pluginRequest.RequestInner;
    try {
      pluginRequest = await validators.API.Plugin.pluginRequestInner.validateAsync(JSON.parse(data.request));
    } catch (error) {
      console.error(error);
      throw new Error(errors.server.INVALID_REQUEST);
    }

    // The request must be at most 10 minutes old (and not more than a small
    // clock skew in the future), so the replay key below outlives it.
    const requestTime = Number(pluginRequest.requestId.split('-')[1]);
    const now = Date.now();
    if (
      !Number.isSafeInteger(requestTime) ||
      now - requestTime > PLUGIN_REQUEST_MAX_AGE_MS ||
      requestTime - now > PLUGIN_REQUEST_MAX_SKEW_MS
    ) {
      throw new Error(errors.server.SIGNED_REQUEST_EXPIRED);
    }

    // Get plugin
    const communityPlugin = await pluginHelper.getCommunityPlugin(pluginRequest.pluginId);
    if (!communityPlugin) {
      throw new Error(errors.server.NOT_FOUND);
    }

    const plugin = await pluginHelper.getPlugin(communityPlugin.pluginId);
    if (!plugin) {
      throw new Error(errors.server.NOT_FOUND);
    }

    // Check request signature
    const verify = crypto.createVerify('SHA256');
    verify.update(data.request);
    verify.end();

    const isValid = verify.verify(plugin.publicKey, Buffer.from(data.signature, 'base64'));
    if (!isValid) {
      throw new Error(errors.server.INVALID_SIGNATURE);
    }

    // Check if request is unique for this plugin installation. Only signed
    // requests get here, and the validator bounds the requestId length.
    const requestKey = `pluginRequest:${pluginRequest.pluginId}:${pluginRequest.requestId}`;
    const setResult = await dataClient.set(requestKey, "1", {
      expiration: { type: 'EX', value: PLUGIN_REQUEST_REPLAY_TTL_S },
      condition: 'NX',
    });
    if (setResult !== 'OK') {
      throw new Error(errors.server.DUPLICATED_SIGNED_REQUEST);
    }

    let responseInner: API.Plugins.pluginRequest.ResponseInner | undefined = undefined;
    const userPermissions = await pluginHelper.getUserPluginPermissions(user.id, plugin.id);

    if (pluginRequest.type === 'request') {
      if (pluginRequest.data.type === 'userInfo') {
        const ownData = await userHelper.getOwnDataById(user.id);
        const roles = await communityHelper.getUserRoles(user.id, communityPlugin.communityId);

        let twitterResponse: {
          username: string;
        } | undefined = undefined;
        let luksoResponse: {
          username: string;
          address: string;
        } | undefined = undefined;
        let farcasterResponse: {
          displayName: string;
          username: string;
          fid: number;
        } | undefined = undefined;
        let emailResponse: string | undefined = undefined;

        const pluginPermissions = [...(plugin.permissions?.mandatory || []), ...(plugin.permissions?.optional || [])];

        if (
          pluginPermissions.includes(PluginPermission.READ_TWITTER) &&
          userPermissions.acceptedPermissions.includes(PluginPermission.READ_TWITTER)
        ) {
          twitterResponse = {
            username: ownData.accounts.find(account => account.type === 'twitter')?.displayName || '',
          }
        }

        if (
          pluginPermissions.includes(PluginPermission.READ_LUKSO) &&
          userPermissions.acceptedPermissions.includes(PluginPermission.READ_LUKSO)
        ) {
          const luksoAccount = ownData.accounts.find(account => account.type === 'lukso');
          if (luksoAccount) {
            luksoResponse = {
              username: luksoAccount.displayName || '',
              address: luksoAccount.extraData?.type === 'lukso' ? luksoAccount.extraData.upAddress : '',
            }
          }
        }

        if (
          pluginPermissions.includes(PluginPermission.READ_FARCASTER) &&
          userPermissions.acceptedPermissions.includes(PluginPermission.READ_FARCASTER)
        ) {
          const farcasterAccount = ownData.accounts.find(account => account.type === 'farcaster');
          if (farcasterAccount) {
            farcasterResponse = {
              displayName: farcasterAccount.displayName || '',
              username: farcasterAccount.extraData?.type === 'farcaster' ? farcasterAccount.extraData.username : '',
              fid: farcasterAccount.extraData?.type === 'farcaster' ? farcasterAccount.extraData.fid : 0,
            }
          }
        }

        if (
          pluginPermissions.includes(PluginPermission.READ_EMAIL) &&
          userPermissions.acceptedPermissions.includes(PluginPermission.READ_EMAIL) &&
          ownData.emailVerified
        ) {
          emailResponse = ownData.email || undefined;
        }
        

        const cgAccount = ownData.accounts.find(account => account.type === 'cg');
        const activeAccount = ownData.accounts.filter(account => ownData.displayAccount === account.type)[0];
        const imageId = activeAccount?.imageId || cgAccount?.imageId || '';
        const [imageUrl] = await fileHelper.getSignedUrls([imageId]);

        let premium: 'FREE' | 'SILVER' | 'GOLD' = 'FREE';
        for (const premiumFeature of ownData.premiumFeatures) {
          if (dayjs(premiumFeature.activeUntil).isAfter(dayjs())) {
            if (premium === 'FREE') {
              premium = premiumFeature.featureName === 'SUPPORTER_1' ? 'SILVER' : 'GOLD';
            } else if (premium === 'SILVER' && premiumFeature.featureName === 'SUPPORTER_2') {
              premium = 'GOLD';
            }
          }
        }

        responseInner = {
          data: {
            id: user.id,
            name: getDisplayNameString(ownData),
            imageUrl: imageUrl?.url || '',
            roles,
            premium,
            email: emailResponse,
            twitter: twitterResponse,
            lukso: luksoResponse,
            farcaster: farcasterResponse,
          },
          pluginId: pluginRequest.pluginId,
          requestId: pluginRequest.requestId,
        }
      } else if (pluginRequest.data.type === 'communityInfo') {
        const community = await communityHelper.getCommunityDetailView({ id: communityPlugin.communityId }, user.id);
        if (!community) {
          throw new Error(errors.server.NOT_FOUND);
        }

        const [smallLogo, largeLogo, headerImage] = await fileHelper.getSignedUrls([community.logoSmallId || '', community.logoLargeId || '', community.headerImageId || '']);

        let communityPremium: Models.Community.PremiumName | 'FREE' = 'FREE';
        if (community.premium && dayjs(community.premium.activeUntil).isAfter(dayjs())) {
          communityPremium = community.premium.featureName;
        }

        responseInner = {
          data: {
            id: community.id,
            title: community.title,
            url: community.url,
            smallLogoUrl: smallLogo.url,
            largeLogoUrl: largeLogo.url,
            headerImageUrl: headerImage.url,
            official: community.official,
            premium: communityPremium,
            roles: community.roles.map((role) => ({
              id: role.id,
              title: role.title,
              type: role.type,
              permissions: role.permissions,
              assignmentRules: role.assignmentRules,
            })),
          },
          pluginId: pluginRequest.pluginId,
          requestId: pluginRequest.requestId,
        }
      } else if (pluginRequest.data.type === 'userFriends') {
        if (!userPermissions.acceptedPermissions.includes(PluginPermission.READ_FRIENDS)) {
          throw new Error(errors.server.NOT_ALLOWED);
        }

        const friends = await userHelper.getFriendsWithName(user.id, pluginRequest.data.limit, pluginRequest.data.offset);
        const imageUrls = await fileHelper.getSignedUrls(friends.map(friend => friend.imageId || ''));
        const friendsWithImage = friends.map((friend, index) => {
          const { imageId, ...friendRest } = friend;
          return {
            ...friendRest,
            imageUrl: imageUrls[index]?.url || '',
          }
        });

        responseInner = {
          data: {
            friends: friendsWithImage,
          },
          pluginId: pluginRequest.pluginId,
          requestId: pluginRequest.requestId,
        }
      }
    }

    if (pluginRequest.type === 'action') {
      if (pluginRequest.data.type === 'giveRole') {
        if (!communityPlugin.config?.canGiveRole || !communityPlugin.config?.giveableRoleIds?.includes(pluginRequest.data.roleId)) {
          throw new Error(errors.server.NOT_ALLOWED);
        }

        const { roleId, userId } = pluginRequest.data;

        const role = await communityHelper.getRole(roleId);
        if (!role) {
          throw new Error(errors.server.NOT_FOUND);
        }

        if (role.type === RoleType.PREDEFINED) {
          throw new Error(errors.server.NOT_ALLOWED);
        }

        if (role.communityId !== communityPlugin.communityId) {
          throw new Error(errors.server.INVALID_REQUEST);
        }

        try {
          await communityHelper.addUserToRoles({
            communityId: communityPlugin.communityId,
            roleIds: [roleId],
            userId,
          });
        } catch (error) {
          throw new Error(errors.server.INVALID_REQUEST);
        }

        responseInner = {
          data: {
            success: true,
          },
          pluginId: pluginRequest.pluginId,
          requestId: pluginRequest.requestId,
        }
      }
    }

    if (!responseInner) {
      throw new Error(errors.server.INVALID_REQUEST);
    }

    const sign = crypto.createSign('SHA256');
    sign.update(JSON.stringify(responseInner));
    sign.end();

    const signature = sign.sign(plugin.privateKey, 'base64');

    return {
      response: JSON.stringify(responseInner),
      signature,
    };
  }
);

registerPostRoute<
  API.Plugins.acceptPluginPermissions.Request,
  API.Plugins.acceptPluginPermissions.Response
>(
  pluginRouter,
  '/acceptPluginPermissions',
  validators.API.Plugin.acceptPluginPermissions,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }

    const communityPlugin = await pluginHelper.getCommunityPlugin(data.pluginId);
    if (!communityPlugin) {
      throw new Error(errors.server.NOT_FOUND);
    }

    const permissionsSet = new Set(data.permissions);
    permissionsSet.add(PluginPermission.USER_ACCEPTED);
    const permissions = Array.from(permissionsSet);
    await pluginHelper.updatePluginStatePermissions(user.id, communityPlugin.pluginId, permissions);

    const community = await communityHelper.getCommunityDetailView({ id: communityPlugin.communityId }, user.id);

    const event: Events.Community.Community = {
      type: "cliCommunityEvent",
      action: "update",
      data: {
        id: communityPlugin.communityId,
        updatedAt: new Date().toISOString(),
        plugins: community.plugins
      },
    };

    await eventHelper.emit(event, {
      userIds: [user.id],
    });

    return {
      ok: true,
    };
  }
);

registerPostRoute<
  API.Plugins.getAppstorePlugin.Request,
  API.Plugins.getAppstorePlugin.Response
>(
  pluginRouter,
  '/getAppstorePlugin',
  validators.API.Plugin.getAppstorePlugin,
  async (request, response, data) => {
    const plugin = await pluginHelper.getAppstorePlugin(data.pluginId);
    return plugin;
  }
);

registerPostRoute<
  API.Plugins.getAppstorePlugins.Request,
  API.Plugins.getAppstorePlugins.Response
>(
  pluginRouter,
  '/getAppstorePlugins',
  validators.API.Plugin.getAppstorePlugins,
  async (request, response, data) => {
    const plugins = await pluginHelper.getAppstorePlugins(data);
    return {
      plugins,
    };
  }
);

registerPostRoute<
  API.Plugins.getPluginCommunities.Request,
  API.Plugins.getPluginCommunities.Response
>(
  pluginRouter,
  '/getPluginCommunities',
  validators.API.Plugin.getPluginCommunities,
  async (request, response, data) => {
    const communityIds = await pluginHelper.getCommunitiesWithPlugin(data.pluginId, data.limit, data.offset);
    
    return {
      communityIds,
    };
  }
);

export default pluginRouter;
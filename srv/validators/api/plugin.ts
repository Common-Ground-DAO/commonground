// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Joi from "joi";
import common from "../common";
import { PluginPermission } from "../../common/enums";
import config from "../../common/config";
import urls from "../../util/urls";
import { getProcessRpIdOrNull, isSameOrSubdomain } from "../../util/passkeyConfig";

const pluginConfigSchema = Joi.object<Models.Plugin.PluginConfig>({
  canGiveRole: Joi.boolean(),
  giveableRoleIds: Joi.array().items(common.Uuid),
}).required();

const pluginPermissionsSchema = Joi.object<Models.Plugin.PluginPermissions>({
  mandatory: Joi.array().items(Joi.string().valid(...Object.values(PluginPermission))).required(),
  optional: Joi.array().items(Joi.string().valid(...Object.values(PluginPermission))).required(),
}).required();

// Plugin content must never be served from this instance's own host or any
// subdomain of it (nor of the passkey RP ID): a page there could run WebAuthn
// ceremonies for the instance's relying party. Not enforced in dev, where
// plugins are commonly served from another localhost port.
export function isForbiddenPluginHost(host: string, forbiddenDomains: string[]): boolean {
  return forbiddenDomains.some(domain => isSameOrSubdomain(host, domain));
}

const PluginUrl = Joi.string().max(2048).custom((value: string) => {
  if (config.DEPLOYMENT === 'dev') {
    return value;
  }
  let host: string;
  try {
    host = new URL(value).hostname;
  }
  catch {
    throw new Error('plugin url must be an absolute URL');
  }
  const forbidden = [urls.APP_HOSTNAME];
  const rpId = getProcessRpIdOrNull();
  if (rpId) {
    forbidden.push(rpId);
  }
  if (isForbiddenPluginHost(host, forbidden)) {
    throw new Error('plugin url must not point to this instance or its subdomains');
  }
  return value;
});

const pluginApi = {
  createPlugin: Joi.object<API.Plugins.createPlugin.Request>({
    name: Joi.string().required(),
    url: PluginUrl.required(),
    description: Joi.alternatives().try(Joi.string().allow('').required(), Joi.equal(null)),
    imageId: Joi.alternatives().try(Joi.string().required(), Joi.equal(null)),
    communityId: common.Uuid.required(),
    config: pluginConfigSchema,
    permissions: pluginPermissionsSchema,
    clonable: Joi.boolean().strict(true).required(),
    requiresIsolationMode: Joi.boolean().strict(true).required(),
    tags: Joi.alternatives().try(common.Tags, Joi.equal(null)).required(),
  }).strict(true).required(),

  clonePlugin: Joi.object<API.Plugins.clonePlugin.Request>({
    pluginId: common.Uuid.required(),
    copiedFromCommunityId: common.Uuid.required(),
    targetCommunityId: common.Uuid.required(),
  }).strict(true).required(),

  updatePlugin: Joi.object<API.Plugins.updatePlugin.Request>({
    id: common.Uuid.required(),
    communityId: common.Uuid.required(),
    name: Joi.string().required(),
    config: pluginConfigSchema,
    pluginData: Joi.alternatives().try(
      Joi.object<API.Plugins.updatePlugin.Request['pluginData']>({
        pluginId: common.Uuid.required(),
        clonable: Joi.boolean().strict(true).required(),
        url: PluginUrl.required(),
        description: Joi.alternatives().try(Joi.string().allow('').required(), Joi.equal(null)),
        imageId: Joi.alternatives().try(Joi.string().required(), Joi.equal(null)),
        permissions: pluginPermissionsSchema,
        requiresIsolationMode: Joi.boolean().strict(true).required(),
        tags: Joi.alternatives().try(common.Tags, Joi.equal(null)),
      }).required(),
      Joi.equal(null),
    ),
  }).strict(true).required(),

  deletePlugin: Joi.object<API.Plugins.deletePlugin.Request>({
    id: common.Uuid.required(),
  }).strict(true).required(),

  pluginRequest: Joi.object<API.Plugins.pluginRequest.Request>({
    request: Joi.string().max(8192).required(),
    signature: Joi.string().max(2048).required(),
  }).strict(true).required(),

  pluginRequestInner: Joi.object<API.Plugins.pluginRequest.RequestInner>({
    type: Joi.string().valid('request', 'action').required(),
    pluginId: common.Uuid.required(),
    // `<prefix>-<unix ms>[-<random>]`: the plugin library sends
    // `requestId-<ms>-<uuid>`, the reference client `<counter>-<ms>`
    requestId: Joi.string().max(128).pattern(/^[A-Za-z0-9]{1,32}-\d{1,16}(-[A-Za-z0-9-]{1,64})?$/).required(),
    iframeUid: Joi.string().max(128).required(),
    data: Joi.alternatives().try(
      Joi.object({
        type: Joi.string().valid('userInfo').required(),
      }),
      Joi.object({
        type: Joi.string().valid('communityInfo').required(),
      }),
      Joi.object({
        type: Joi.string().valid('userFriends').required(),
        limit: Joi.number().required(),
        offset: Joi.number().required(),
      }),
      Joi.object({
        type: Joi.string().valid('giveRole').required(),
        userId: common.Uuid.required(),
        roleId: common.Uuid.required(),
      }),
    ).required(),
  }).strict(true).required(),

  acceptPluginPermissions: Joi.object<API.Plugins.acceptPluginPermissions.Request>({
    pluginId: common.Uuid.required(),
    permissions: Joi.array().items(Joi.string().valid(...Object.values(PluginPermission))).required(),
  }).strict(true).required(),

  getAppstorePlugin: Joi.object<API.Plugins.getAppstorePlugin.Request>({
    pluginId: common.Uuid.required(),
  }).strict(true).required(),

  getAppstorePlugins: Joi.object<API.Plugins.getAppstorePlugins.Request>({
    query: Joi.string().allow(''),
    tags: common.Tags,
    limit: Joi.number().required(),
    offset: Joi.number().required(),
  }).strict(true).required(),

  getPluginCommunities: Joi.object<API.Plugins.getPluginCommunities.Request>({
    pluginId: common.Uuid.required(),
    limit: Joi.number().required(),
    offset: Joi.number().required(),
  }).strict(true).required(),
}

export default pluginApi;
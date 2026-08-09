// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Joi, { any } from "joi";
import {
  CommunityPermission,
  ChannelPermission,
  ArticlePermission,
  PredefinedRole,
  RoleType,
  CallPermission,
  UserBlockState,
  CommunityPremiumFeatureName,
  PremiumRenewal,
  CommunityEventPermission,
  CommunityEventType,
  CommunityApprovalState,
} from "../../common/enums";
import common from "../common";
import baseArticleApi, { articleCursorPairing } from "./basearticle";

const title = Joi.string().max(255);
const imageId = Joi.alternatives().try(
  common.ImageId,
  Joi.equal(null)
);
const shortDescription = Joi.string().allow('').max(50);
const description = Joi.string().allow('', null).max(1000);
const links = Joi.array().items(common.Link);
const order = Joi.number().integer().strict(true);
const userBlockState = Joi.string().valid(...Object.values(UserBlockState));
const premiumFeature = Joi.string().valid(...Object.values(CommunityPremiumFeatureName));
const premiumRenewal = Joi.string().valid(...Object.values(PremiumRenewal)).allow(null);
const communityEventType = Joi.string().valid(...Object.values(CommunityEventType));

const createRolePermissionsValidator = (
  allowedPermissions: CommunityPermission[] | ChannelPermission[] | ArticlePermission[] | CallPermission[]
) => Joi.array().items(
  Joi.object({
    roleTitle: Joi.string().required(),
    roleId: common.Uuid.required(),
    permissions: Joi.array().items(
      Joi.string().valid(...allowedPermissions)
    ).required().unique(),
  }).strict(true)
).unique((a, b) => a.roleId === b.roleId);

const createCallsRolePermissionsValidator = (
  allowedPermissions: CallPermission[]
) => Joi.array().items(
  Joi.object({
    roleId: common.Uuid.required(),
    permissions: Joi.array().items(
      Joi.string().valid(...allowedPermissions)
    ).required().unique(),
  }).strict(true)
).unique((a, b) => a.roleId === b.roleId);

const createCommunityEventRolePermissionsValidator = (
  allowedPermissions: CommunityEventPermission[]
) => Joi.array().items(
  Joi.object({
    roleTitle: Joi.string().required(),
    roleId: common.Uuid.required(),
    permissions: Joi.array().items(
      Joi.string().valid(...allowedPermissions)
    ).required().unique(),
  }).strict(true)
).unique((a, b) => a.roleId === b.roleId);

const communityRolePermissionsValidator = Joi.array().items(Joi.string().valid(...Object.values(CommunityPermission))).unique();

const articleRolePermissionsValidator = createRolePermissionsValidator(
  Object.values(ArticlePermission)
);

const channelRolePermissionsValidator = createRolePermissionsValidator(
  Object.values(ChannelPermission)
);

const callsRolePermissionsValidator = createCallsRolePermissionsValidator(
  Object.values(CallPermission)
);

const callsCommunityEventPermissionsValidator = createCommunityEventRolePermissionsValidator(
  Object.values(CommunityEventPermission)
);

const roleTitleValidator = Joi.string().trim().custom((value, helpers) => {
  if (
    PredefinedRole.Admin.toLowerCase() === value.toLowerCase()
  ) {
    return helpers.error("any.invalid");
  }
  return value;
});

const allowedRoleTypes = new Set(Object.values(RoleType).filter(v => v !== RoleType.PREDEFINED));
const roleTypeValidator = Joi.string().custom((value, helpers) => {
  if (!allowedRoleTypes.has(value)) {
    return helpers.error("any.invalid");
  }
  return value;
});

const roleAssignmentOperation = Joi.object({
  userId: common.Uuid.required(),
  communityId: common.Uuid.required(),
  roleIds: Joi.array().items(common.Uuid).min(1).unique().required(),
}).strict(true);

// @Todo
const assignmentRulesValidator = Joi.alternatives().try(
  Joi.equal(null),
  Joi.object()
);

const communityApi = {
  getCommunityList: Joi.object<API.Community.getCommunityList.Request>({
    offset: Joi.number().integer().min(0).strict(true).required(),
    sort: Joi.string().trim().regex(/^(new|popular)$/).required(),
    tags: common.Tags.required(),
    limit: Joi.number().integer().min(1).max(100).strict(true),
    search: Joi.string(),
  }).strict(true).required(),

  getCommunitiesById: Joi.object<API.Community.getCommunitiesById.Request>({
    ids: Joi.array().items(common.Uuid).min(1).required(),
  }).strict(true).required(),

  getCommunityDetailView: Joi.object<any>({
    id: common.Uuid,
    url: common.ItemUrl,
  }).xor('id', 'url').strict(true).required(),

  joinCommunity: Joi.object<API.Community.joinCommunity.Request>({
    id: common.Uuid.required(),
    questionnaireAnswers: Joi.array().max(5).items(Joi.object<Models.Community.QuestionnaireAnswer>({
      type: Joi.string().valid('text','multi-choice','multi-select').required(),
      question: Joi.string().required(),
      answer: Joi.array().max(5).items(Joi.string())
    }).strict(true)),
    password: Joi.string()
  }).strict(true).required(),

  leaveCommunity: Joi.object<API.Community.leaveCommunity.Request>({
    id: common.Uuid.required(),
  }).strict(true).required(),

  setUserBlockState: Joi.object<API.Community.setUserBlockState.Request>({
    userId: common.Uuid.required(),
    communityId: common.Uuid.required(),
    until: Joi.alternatives().try(common.DateString, Joi.equal(null)).required(),
    blockState: Joi.alternatives().try(userBlockState, Joi.equal(null)).required(),
  }).strict(true).required(),

  getMemberList: Joi.object<API.Community.getMemberList.Request>({
    communityId: common.Uuid.required(),
    offset: Joi.number().integer().min(0).strict(true).required(),
    limit: Joi.number().integer().min(1).max(100).strict(true).required(),
    search: Joi.string(),
    roleId: common.Uuid,
  }).strict(true).required(),

  getChannelMemberList: Joi.object<API.Community.getChannelMemberList.Request>({
    communityId: common.Uuid.required(),
    channelId: common.Uuid.required(),
    offset: Joi.number().integer().min(0).strict(true).required(),
    limit: Joi.number().integer().min(1).max(100).strict(true).required(),
    search: Joi.string(),
    startsWithSearch: Joi.boolean().strict(true),
  }).strict(true).required(),

  getMemberNewsletterCount: Joi.object<API.Community.getMemberNewsletterCount.Request>({
    communityId: common.Uuid.required(),
    roleIds: Joi.array().items(common.Uuid.required()).required().min(1)
  }).strict(true).required(),

  getUserCommunityRoleIds: Joi.object<API.Community.getUserCommunityRoleIds.Request>({
    userId: common.Uuid.required(),
    communityId: common.Uuid.required(),
  }).strict(true).required(),

  /* COMMUNITY */

  createCommunity: Joi.object<API.Community.createCommunity.Request>({
    title: title.required(),
    logoSmallId: imageId.required(),
    logoLargeId: imageId.required(),
    shortDescription: shortDescription.required(),
    description: description.required(),
    headerImageId: imageId.required(),
    links: links.required(),
    tags: common.Tags.required(),
  }).strict(true).required(),

  updateCommunity: Joi.object<API.Community.updateCommunity.Request>({
    id: common.Uuid.required(),
    title,
    logoSmallId: imageId,
    logoLargeId: imageId,
    shortDescription,
    description,
    headerImageId: imageId,
    links,
    tags: common.Tags,
  }).strict(true).required(),

  /* AREA */

  createArea: Joi.object<API.Community.createArea.Request>({
    communityId: common.Uuid.required(),
    title: title.required(),
    order: order.required(),
  }).strict(true).required(),

  updateArea: Joi.object<API.Community.updateArea.Request>({
    id: common.Uuid.required(),
    communityId: common.Uuid.required(),
    title,
    order,
  }).strict(true).required(),

  deleteArea: Joi.object<API.Community.deleteArea.Request>({
    id: common.Uuid.required(),
    communityId: common.Uuid.required(),
  }).strict(true).required(),

  /* CHANNEL */

  createChannel: Joi.object<API.Community.createChannel.Request>({
    communityId: common.Uuid.required(),
    areaId: common.Uuid.required(),
    title: title.required(),
    order: order.required(),
    description: description.required(),
    emoji: common.Emoji.required(),
    url: common.ItemUrlNullable.required(),
    rolePermissions: channelRolePermissionsValidator.required(),
  }).strict(true).required(),

  updateChannel: Joi.object<API.Community.updateChannel.Request>({
    channelId: common.Uuid.required(),
    communityId: common.Uuid.required(),
    areaId: common.Uuid,
    title,
    order,
    description,
    emoji: common.Emoji,
    url: common.ItemUrlNullable,
    rolePermissions: channelRolePermissionsValidator,
    pinnedMessageIds: Joi.array().items(common.Uuid).unique().min(0).max(2),
  }).strict(true).required(),

  deleteChannel: Joi.object<API.Community.deleteChannel.Request>({
    channelId: common.Uuid.required(),
    communityId: common.Uuid.required(),
  }).strict(true).required(),

  /* ROLE */

  createRole: Joi.object<API.Community.createRole.Request>({
    communityId: common.Uuid.required(),
    title: roleTitleValidator.required(),
    type: roleTypeValidator.required(),
    assignmentRules: assignmentRulesValidator.required(),
    permissions: communityRolePermissionsValidator.required(),
    description: Joi.alternatives().try(Joi.string().allow('').max(150), Joi.equal(null)).required(),
    imageId: Joi.alternatives().try(common.ImageId, Joi.equal(null)).required(),
  }).strict(true).required(),

  updateRole: Joi.object<API.Community.updateRole.Request>({
    id: common.Uuid.required(),
    communityId: common.Uuid.required(),
    title: roleTitleValidator,
    type: roleTypeValidator,
    assignmentRules: assignmentRulesValidator,
    permissions: communityRolePermissionsValidator,
    description: Joi.alternatives().try(Joi.string().allow('').max(150), Joi.equal(null)),
    imageId: Joi.alternatives().try(common.ImageId, Joi.equal(null)),
  }).strict(true).required(),

  deleteRole: Joi.object<API.Community.deleteRole.Request>({
    id: common.Uuid.required(),
    communityId: common.Uuid.required(),
  }).strict(true).required(),

  checkCommunityRoleClaimability: Joi.object<API.Community.checkCommunityRoleClaimability.Request>({
    communityId: common.Uuid.required(),
  }).strict(true).required(),

  claimRole: Joi.object<API.Community.claimRole.Request>({
    communityId: common.Uuid.required(),
    roleId: common.Uuid.required(),
  }).strict(true).required(),

  addUserToRoles: roleAssignmentOperation.required(),

  removeUserFromRoles: roleAssignmentOperation.required(),

  /* TOKENS */

  addCommunityToken: Joi.object<API.Community.addCommunityToken.Request>({
    communityId: common.Uuid.required(),
    contractId: common.Uuid.required(),
    order: Joi.number().integer().min(0).required(),
  }).strict(true).required(),

  removeCommunityToken: Joi.object<API.Community.removeCommunityToken.Request>({
    communityId: common.Uuid.required(),
    contractId: common.Uuid.required(),
  }).strict(true).required(),

  /* PREMIUM */
  
  givePointsToCommunity: Joi.object<API.Community.givePointsToCommunity.Request>({
    communityId: common.Uuid.required(),
    amount: Joi.number().integer().min(1000).required(),
  }).strict(true).required(),

  buyCommunityPremiumFeature: Joi.object<API.Community.buyCommunityPremiumFeature.Request>({
    communityId: common.Uuid.required(),
    featureName: premiumFeature.valid("URL_CHANGE").required(),
    duration: Joi.when('featureName', {
      is: 'URL_CHANGE',
      then: Joi.forbidden(),
      otherwise: Joi.string().valid("month", "year", "upgrade").required(),
    }),
    url: Joi.when('featureName', {
      is: 'URL_CHANGE',
      then: common.ItemUrl.required(),
      otherwise: Joi.forbidden(),
    }),
  }).strict(true).required(),

  setPremiumFeatureAutoRenew: Joi.object<API.Community.setPremiumFeatureAutoRenew.Request>({
    communityId: common.Uuid.required(),
    featureName: premiumFeature.required(),
    autoRenew: premiumRenewal.required(),
  }).strict(true).required(),

  /* ONBOARDING */
  getCommunityPassword: Joi.object<API.Community.getCommunityPassword.Request>({
    communityId: common.Uuid.required()
  }).strict(true),

  verifyCommunityPassword: Joi.object<API.Community.verifyCommunityPassword.Request>({
    communityId: common.Uuid.required(),
    password: Joi.string().required()
  }).strict(true),

  setOnboardingOptions: Joi.object<API.Community.setOnboardingOptions.Request>({
    communityId: common.Uuid.required(),
    onboardingOptions: Joi.object<Models.Community.OnboardingOptions>({
      manuallyApprove: Joi.object<Models.Community.OnboardingOptions['manuallyApprove']>({
        enabled: Joi.boolean().strict(true),
        email: Joi.string()
      }),
      customWelcome: Joi.object<Models.Community.OnboardingOptions['customWelcome']>({
        enabled: Joi.boolean().strict(true),
        welcomeString: Joi.string(),
        rules: Joi.array().max(5).items(Joi.string()),
      }),
      questionnaire: Joi.object<Models.Community.OnboardingOptions['questionnaire']>({
        enabled: Joi.boolean().strict(true),
        questions: Joi.array().min(1).max(5).items(Joi.object<Models.Community.OnboardingOptionsQuestion>({
          type: Joi.string().valid('text','multi-choice','multi-select').required(),
          question: Joi.string().required().max(180),
          options: Joi.array().max(5).items(Joi.string().max(180))
        }).strict(true))
      }),
      requirements: Joi.object<Models.Community.OnboardingOptions['requirements']>({
        enabled: Joi.boolean().strict(true),
        minAccountTimeEnabled: Joi.boolean().strict(true),
        minAccountTimeDays: Joi.number().integer().strict(true),
        universalProfileEnabled: Joi.boolean().strict(true),
        xProfileEnabled: Joi.boolean().strict(true),
      }),
      passwordProtected: Joi.object<Models.Community.OnboardingOptions['passwordProtected']>({
        enabled: Joi.boolean().strict(true),
      }),
    }),
    password: Joi.alternatives(Joi.string().allow('').max(30), Joi.equal(null))
  }).strict(true),

  getPendingJoinApprovals: Joi.object<API.Community.getPendingJoinApprovals.Request>({
    communityId: common.Uuid.required(),
  }).strict(true),

  setAllPendingJoinApprovals: Joi.object<API.Community.setAllPendingJoinApprovals.Request>({
    communityId: common.Uuid.required(),
    approvalState: Joi.string().valid('APPROVED', 'DENIED')
  }).strict(true),

  setPendingJoinApproval: Joi.object<API.Community.setPendingJoinApproval.Request>({
    communityId: common.Uuid.required(),
    userId: common.Uuid.required(),
    approvalState: Joi.string().valid(...Object.values(CommunityApprovalState)),
    message: Joi.string().allow('')
  }).strict(true),

  getBannedUsers: Joi.object<API.Community.getBannedUsers.Request>({
    communityId: common.Uuid.required(),
    limit: Joi.number().integer().min(1).max(100).default(100),
    before: common.DateString,
  }).strict(true),

  /* ARTICLES */

  getArticleList: Joi.object<API.Community.getArticleList.Request>({
    ...baseArticleApi._getArticleListRequest,
    communityId: common.Uuid,
    tags: common.Tags,
    anyTags: common.Tags,
    communityTags: common.Tags,
    anyCommunityTags: common.Tags,
  }).strict(true).custom(articleCursorPairing).required(),

  getArticleDetailView: Joi.object<API.Community.getArticleDetailView.Request>({
    communityId: common.Uuid.required(),
    articleId: common.Uuid,
    url: common.ItemUrl,
  }).xor('articleId', 'url').strict(true).required(),

  createArticle: Joi.object<API.Community.createArticle.Request>({
    communityArticle: Joi.object<API.Community.createArticle.Request["communityArticle"]>({
      communityId: common.Uuid.required(),
      url: common.ItemUrlNullable.required(),
      published: Joi.alternatives().try(common.DateString, Joi.equal(null)).required(),
      rolePermissions: articleRolePermissionsValidator.required(),
    }).strict(true).required(),
    article: baseArticleApi._createArticle.required(),
  }).strict(true).required(),

  updateArticle: Joi.object<API.Community.updateArticle.Request>({
    communityArticle: Joi.object({
      communityId: common.Uuid.required(),
      articleId: common.Uuid.required(),
      url: common.ItemUrlNullable,
      published: Joi.alternatives().try(Joi.equal(null), common.DateString),
      rolePermissions: articleRolePermissionsValidator,
    }).strict(true).required(),
    article: baseArticleApi._updateArticle,
  }).custom((value, helpers) => {
    if (!!value?.article && value.article.articleId !== value.communityArticle?.articleId) {
      return helpers.error("any.invalid");
    }
    return value;
  }).strict(true).required(),

  deleteArticle: Joi.object<API.Community.deleteArticle.Request>({
    communityId: common.Uuid.required(),
    articleId: common.Uuid.required(),
  }).strict(true).required(),

  sendArticleAsEmail: Joi.object<API.Community.sendArticleAsEmail.Request>({
    communityId: common.Uuid.required(),
    articleId: common.Uuid.required(),
  }).strict(true).required(),

  setChannelPinState: Joi.object<API.Community.setChannelPinState.Request>({
    communityId: common.Uuid.required(),
    channelId: common.Uuid.required(),
    pinnedUntil: Joi.when('pinType', {
      is: 'autopin',
      then: Joi.alternatives().try(common.DateString, Joi.equal(null)),
      otherwise: Joi.equal(null),
    }),
    pinType: Joi.string().valid("autopin", "permapin", "never"),
    notifyType: Joi.string().valid("always", "while_pinned", "never"),
  }).strict(true).min(3).required(),

  getCall: Joi.object<API.Community.getCall.Request>({
    id: common.Uuid.required(),
    communityId: common.Uuid.required(),
  }).strict(true).required(),

  getCallParticipantEvents: Joi.object<API.Community.getCallParticipantEvents.Request>({
    callId: common.Uuid.required(),
  }).strict(true).required(),

  startCall: Joi.object<API.Community.startCall.Request>({
    communityId: common.Uuid.required(),
    title: Joi.string().max(100).required(),
    description: Joi.alternatives().try(Joi.string().allow("").max(200), Joi.equal(null)).required(),
    rolePermissions: callsRolePermissionsValidator,
    callType: Joi.string().valid("broadcast", "default").required(),
    callCreator: common.Uuid.required(),
    slots: Joi.number().integer().min(2).required(),
    stageSlots: Joi.number().integer().min(1).required(),
    audioOnly: Joi.boolean().required(),
    hd: Joi.boolean().required(),
  }).strict(true).required(),

  startScheduledCall: Joi.object<API.Community.startScheduledCall.Request>({
    communityEventId: common.Uuid.required(),
  }).strict(true).required(),

  getCurrentCalls: Joi.object<API.Community.getCurrentCalls.Request>({
    offset: Joi.number().required(),
  }).strict(true).required(),

  /* EVENTS */
  getEventList: Joi.object<API.Community.getEventList.Request>({
    communityId: common.Uuid.required(),
  }).strict(true).required(),

  getMyEvents: Joi.object<API.Community.getMyEvents.Request>({
    scheduledBefore: common.DateString.allow(null),
    // Second cursor field: tiebreaker for events sharing a scheduleDate. The
    // public type and repository already support it; it was missing here, so a
    // strict validator rejected any client that paginated per the contract.
    beforeId: common.Uuid.allow(null),
  }).strict(true).required(),

  getUpcomingEvents: Joi.object<API.Community.getUpcomingEvents.Request>({
    scheduledAfter: Joi.alternatives().try(common.DateString, Joi.equal(null)),
    afterId: Joi.alternatives().try(common.Uuid, Joi.equal(null)),
    tags: Joi.alternatives().try(common.Tags, Joi.equal(null)),
    anyTags: Joi.alternatives().try(common.Tags, Joi.equal(null)),
    type: Joi.string().valid("verified", "following"),
  }).strict(true).required(),

  createCommunityEvent: Joi.object<API.Community.createCommunityEvent.Request>({
    type: communityEventType.required(),
    communityId: common.Uuid.required(),
    title: Joi.string().required().max(100),
    description: Joi.string().max(2000).allow('', null).required(),
    duration: Joi.number().integer().min(0).required(),
    url: Joi.string().allow(null).required(),
    imageId: imageId.required(),
    scheduleDate: common.DateString.required().custom((value, helpers) => {
      if (new Date(value) < new Date()) {
        return helpers.error("any.invalid");
      }
      return value;
    }),
    rolePermissions: callsCommunityEventPermissionsValidator.required(),
    externalUrl: Joi.when('type', {
      is: 'external',
      then: Joi.string().max(200),
      otherwise: Joi.equal(null),
    }),
    location: Joi.when('type', {
      is: 'external',
      then: Joi.alternatives().try(Joi.string().max(200), Joi.equal(null)),
      otherwise: Joi.equal(null),
    }),
    callData: Joi.object<API.Community.createCommunityEvent.Request['callData']>({
      slots: Joi.number().integer().min(2).required(),
      stageSlots: Joi.number().integer().min(1).required(),
      audioOnly: Joi.boolean().required(),
      hd: Joi.boolean().required(),
    })
  }).strict(true).required(),

  getEventById: Joi.object<any>({
    id: common.Uuid,
    url: common.ItemUrl,
  }).xor('id', 'url').strict(true).required(),

  updateCommunityEvent: Joi.object<API.Community.updateCommunityEvent.Request>({
    id: common.Uuid.required(),
    type: communityEventType.required(),
    title: Joi.string().required(),
    description: Joi.string().max(2000).allow('', null).required(),
    duration: Joi.number().integer().required(),
    imageId: imageId.required(),
    scheduleDate: common.DateString.required().custom((value, helpers) => {
      if (new Date(value) < new Date()) {
        return helpers.error("any.invalid");
      }
      return value;
    }),
    rolePermissions: callsCommunityEventPermissionsValidator.required(),
    externalUrl: Joi.when('type', {
      is: 'external',
      then: Joi.string().max(200),
      otherwise: Joi.equal(null),
    }),
    location: Joi.when('type', {
      is: 'external',
      then: Joi.alternatives().try(Joi.string().max(200), Joi.equal(null)),
      otherwise: Joi.equal(null),
    }),
    callData: Joi.object<API.Community.updateCommunityEvent.Request['callData']>({
      slots: Joi.number().integer().min(2).required(),
      stageSlots: Joi.number().integer().min(1).required(),
      audioOnly: Joi.boolean().required(),
      hd: Joi.boolean().required(),
    })
  }).strict(true).required(),

  deleteCommunityEvent: Joi.object<API.Community.deleteCommunityEvent.Request>({
    eventId: common.Uuid.required(),
    communityId: common.Uuid.required(),
  }).strict(true).required(),
  
  getEventParticipants: Joi.object<API.Community.getEventParticipants.Request>({
    eventId: common.Uuid.required(),
  }).strict(true).required(),
  
  addEventParticipant: Joi.object<API.Community.addEventParticipant.Request>({
    eventId: common.Uuid.required(),
  }).strict(true).required(),

  addEventParticipantByCallId: Joi.object<API.Community.addEventParticipantByCallId.Request>({
    callId: common.Uuid.required(),
  }).strict(true).required(),
  
  removeEventParticipant: Joi.object<API.Community.removeEventParticipant.Request>({
    eventId: common.Uuid.required(),
  }).strict(true).required(),

  getTransactionData: Joi.object<API.Community.getTransactionData.Request>({
    communityId: common.Uuid.required(),
  }).strict(true).required(),

  updateNotificationState: Joi.object<API.Community.updateNotificationState.Request>({
    data: Joi.array().items(Joi.object<API.Community.updateNotificationState.Request['data'][number]>({
      communityId: common.Uuid.required(),
      notifyMentions: Joi.boolean().strict().required(),
      notifyReplies: Joi.boolean().strict().required(),
      notifyPosts: Joi.boolean().strict().required(),
      notifyEvents: Joi.boolean().strict().required(),
      notifyCalls: Joi.boolean().strict().required(),
    }))
  }).strict(true).min(1).required(),

  subscribeToCommunityNewsletter: Joi.object<API.Community.subscribeToCommunityNewsletter.Request>({
    communityIds: Joi.array().items(common.Uuid.required()).required(),
  }).strict(true).required(),

  unsubscribeFromCommunityNewsletter: Joi.object<API.Community.unsubscribeFromCommunityNewsletter.Request>({
    communityIds: Joi.array().items(common.Uuid.required()).required(),
  }).strict(true).required(),

  getLatestArticleSentAsNewsletterDate: Joi.object<API.Community.getLatestArticleSentAsNewsletterDate.Request>({
    communityId: common.Uuid.required(),
  }).strict(true).required(),

  getNewsletterHistory: Joi.object<API.Community.getNewsletterHistory.Request>({
    communityId: common.Uuid.required(),
    timeframe: Joi.string().valid('30days', '90days', '1year')
  }).strict(true).required(),

  getAirdropClaimHistory: Joi.object<API.Community.getAirdropClaimHistory.Request>({
    communityId: common.Uuid.required(),
    roleId: common.Uuid.required(),
  }).strict(true).required(),

  getAirdropCommunities: Joi.object<API.Community.getAirdropCommunities.Request>({
    status: Joi.string().valid('ongoing', 'finished').required(),
  }).strict(true).required(),
}

export default communityApi;
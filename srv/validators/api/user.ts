// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Joi from "joi";
import { tlds } from "@hapi/tlds";
import common from "../common";
import baseArticleApi, { articleCursorPairing } from "./basearticle";
import {
  UserProfileTypeEnum,
  UserPremiumFeatureName,
  PremiumRenewal,
} from "../../common/enums";

const humanAccountTypes = Object.values(UserProfileTypeEnum)
  .filter(type => type !== UserProfileTypeEnum.BOT);
const premiumFeature = Joi.string().valid(...Object.values(UserPremiumFeatureName));
const premiumRenewal = Joi.string().valid(...Object.values(PremiumRenewal)).allow(null);

const newDeviceValidator = Joi.object({
  publicKey: common.JsonWebKey.required()
}).strict(true);

const cgProfileExtraDataValidator = Joi.object<Models.User.UserAccountExtraData_CG>({
  type: Joi.string().valid("cg").required(),
  description: Joi.string().max(2000).allow('').required(),
  homepage: Joi.string().max(100).allow('').required(),
  links: Joi.array().items(common.Link).required(),
}).strict(true);

const TldSafeEmailValidator = Joi.string().email({ tlds: { allow: tlds } });

const signableWalletDataValidator = Joi.object({
  type: Joi.string().valid("evm").required(),
  address: common.Address.required(),
  siweMessage: Joi.string().required(),
  secret: common.Secret.required(),
}).strict(true);

const walletValidator = Joi.object({
  signature: common.EIP712Signature.required(),
  data: signableWalletDataValidator.required(),
}).strict(true);

const userApi = {
  verifyCaptcha: Joi.object<API.User.verifyCaptcha.Request>({
    token: Joi.string().max(4096).required(),
  }).required().strict(true),

  login: Joi.alternatives().try(
    Joi.object({
      type: Joi.equal("wallet").required(),
      device: newDeviceValidator.required(),
    }).strict(true),
    Joi.object({
      type: Joi.equal("device").required(),
      secret: common.Secret.required(),
      deviceId: common.Uuid.required(),
      base64Signature: common.Base64DeviceSignature.required(),
    }).strict(true),
    Joi.object({
      type: Joi.equal("password").required(),
      aliasOrEmail: Joi.alternatives().try(common.CgProfileDisplayName, TldSafeEmailValidator).required(),
      password: common.Password.required(),
      device: newDeviceValidator.required(),
    }).strict(true),
    Joi.object({
      type: Joi.string().valid("twitter", "passkey-success", "farcaster").required(),
      device: newDeviceValidator.required(),
    }),
    Joi.object({
      type: Joi.equal("lukso").required(),
      device: newDeviceValidator.required(),
    }),
    Joi.object({
      type: Joi.equal("verificationCode").required(),
      email: TldSafeEmailValidator.required(),
      code: Joi.string().required(),
      device: newDeviceValidator.required(),
    }),
  ).required().strict(true),

  createUser: Joi.object<API.User.createUser.Request>({
    useTwitterCredentials: Joi.bool().strict(),
    useLuksoCredentials: Joi.bool().strict(),
    usePreparedWallet: Joi.bool().strict(),
    usePreparedPasskey: Joi.bool().strict(),
    usePreparedFarcaster: Joi.bool().strict(),
    useEmailAndPassword: Joi.object<API.User.createUser.Request["useEmailAndPassword"]>({
      email: TldSafeEmailValidator.required(),
      password: common.Password,
    }).strict(true),
    useCgProfile: Joi.object<API.User.createUser.Request["useCgProfile"]>({
      type: Joi.string().valid("cg").required(),
      displayName: common.CgProfileDisplayName.required(),
      imageId: common.ImageId.allow(null).required(),
      extraData: cgProfileExtraDataValidator.required(),
    }).strict(true),
    displayAccount: Joi.string().valid(...humanAccountTypes).required(),
    recaptchaToken: Joi.string().required(),
    device: newDeviceValidator.required(),
  }).required().strict(true),

  updateOwnData: Joi.object<API.User.updateOwnData.Request>({
    communityOrder: Joi.array().items(common.Uuid).unique(),
    finishedTutorials: Joi.array().items(common.TutorialName).unique(),
    newsletter: Joi.boolean(),
    weeklyNewsletter: Joi.boolean(),
    email: TldSafeEmailValidator.allow(null),
    displayAccount: Joi.string().valid(...humanAccountTypes),
    dmNotifications: Joi.boolean(),
    tags: Joi.alternatives().try(common.Tags, Joi.equal(null)),
  }).strict(true).min(1).required(),

  setOwnExtraDataField: Joi.alternatives<any>().try(
    Joi.object<API.User.setOwnExtraDataField.Request>({
      key: Joi.string().valid("installedPWA").required(),
      value: Joi.boolean().required(),
    }).strict(true).required(),
    /* Add new non-boolean types here like this:
      Joi.object<API.User.setOwnExtraDataField.Request>({
        key: Joi.string("propertyName").valid().required(),
        value: Joi.boolean().required(),
      }).strict(true).required(),
    */
  ).strict(true).required(),

  addUserAccount: Joi.object<API.User.addUserAccount.Request>({
    type: Joi.string().valid(...humanAccountTypes).required(),
    displayName: Joi.when('type', {
      is: 'cg',
      then: common.CgProfileDisplayName.required(),
      otherwise: Joi.forbidden(),
    }),
    description: Joi.when('type', {
      is: 'cg',
      then: Joi.string().max(2000).allow(''),
      otherwise: Joi.forbidden(),
    }),
    homepage: Joi.when('type', {
      is: 'cg',
      then: Joi.string().max(100).allow(''),
      otherwise: Joi.forbidden(),
    }),
    links: Joi.when('type', {
      is: 'cg',
      then: Joi.array().items(common.Link),
      otherwise: Joi.forbidden(),
    }),
  }).required().strict(true),

  updateUserAccount: Joi.object<API.User.updateUserAccount.Request>({
    type: Joi.string().valid(UserProfileTypeEnum.CG).required(),
    displayName: common.CgProfileDisplayName,
    description: Joi.string().allow('').max(2000),
    homepage: Joi.string().allow('').max(100),
    links: Joi.array().items(common.Link),
  }).min(2).required().strict(true),

  removeUserAccount: Joi.object<API.User.addUserAccount.Request>({
    type: Joi.string().valid(...humanAccountTypes).required(),
  }).required().strict(true),

  prepareWalletAction: Joi.object<API.User.prepareWalletAction.Request>({
    type: Joi.string().valid("cg_evm", "evm").required(),
    signature: common.EIP712Signature.required(),
    data: signableWalletDataValidator.required(),
  }).required().strict(true),

  addPreparedWallet: Joi.object<API.User.addPreparedWallet.Request>({
    loginEnabled: Joi.bool().strict(true).required(),
    visibility: common.WalletVisibility.required(),
  }).required().strict(true),

  updateWallet: Joi.object<API.User.updateWallet.Request>({
    id: common.Uuid.required(),
    loginEnabled: Joi.bool().strict(true),
    visibility: common.WalletVisibility,
  }).required().min(2).strict(true),

  deleteWallet: Joi.object<API.User.deleteWallet.Request>({
    id: common.Uuid.required(),
  }).required().strict(true),

  getWallets: Joi.object<API.User.getWallets.Request>({
    userId: common.Uuid,
  }).required().strict(true),

  getUserData: Joi.object<API.User.getUserData.Request>({
    userIds: Joi.array().items(common.Uuid).min(1).unique(),
  }).required().strict(true),

  getSuggestedUsers: Joi.object<API.User.getSuggestedUsers.Request>({
    limit: Joi.number().integer().min(1).max(50).required(),
    cursor: Joi.string(),
  }).required().strict(true),

  getUserProfileDetails: Joi.object<API.User.getUserProfileDetails.Request>({
    userId: common.Uuid.required(),
  }).required().strict(true),

  setOwnStatus: Joi.object<API.User.setOwnStatus.Request>({
    status: common.OnlineStatus.required(),
  }).required().strict(true),

  isCgProfileNameAvailable: Joi.object<API.User.isCgProfileNameAvailable.Request>({
    displayName: common.CgProfileDisplayName.required(),
  }).required().strict(true),

  isEmailAvailable: Joi.object<API.User.isEmailAvailable.Request>({
    email: TldSafeEmailValidator.required(),
  }).required().strict(true),

  setPassword: Joi.object<API.User.setPassword.Request>({
    password: common.Password.required(),
  }).required().strict(true),

  subscribeNewsletter: Joi.object<API.User.subscribeNewsletter.Request>({
    email: TldSafeEmailValidator,
  }).strict(true).required(),

  unsubscribeNewsletter: Joi.object<API.User.unsubscribeNewsletter.Request>({
    email: TldSafeEmailValidator,
  }).strict(true).required(),

  followUser: Joi.object<API.User.followUser.Request>({
    userId: common.Uuid.required(),
  }).required().strict(true),

  unfollowUser: Joi.object<API.User.unfollowUser.Request>({
    userId: common.Uuid.required(),
  }).required().strict(true),

  getArticleList: Joi.object<API.User.getArticleList.Request>({
    ...baseArticleApi._getArticleListRequest,
    userId: common.Uuid,
    followingOnly: Joi.equal(true),
  }).strict(true).custom(articleCursorPairing).required(),

  getArticleDetailView: Joi.object<API.User.getArticleDetailView.Request>({
    userId: common.Uuid.required(),
    articleId: common.Uuid,
    url: common.ItemUrl,
  }).xor('articleId', 'url').strict(true).required(),

  createArticle: Joi.object<API.User.createArticle.Request>({
    userArticle: Joi.object({
      url: common.ItemUrlNullable.required(),
      published: Joi.alternatives().try(Joi.equal(null), common.DateString).required(),
    }).strict(true).required(),
    article: baseArticleApi._createArticle.required(),
  }).strict(true).required(),

  updateArticle: Joi.object<API.User.updateArticle.Request>({
    userArticle: Joi.object({
      articleId: common.Uuid.required(),
      url: common.ItemUrlNullable,
      published: Joi.alternatives().try(Joi.equal(null), common.DateString),
    }).strict(true).required(),
    article: baseArticleApi._updateArticle,
  }).strict(true).custom((value, helpers) => {
    // only cross-check the ids when an `article` body is actually present —
    // updating just the userArticle (e.g. publishing) is valid on its own.
    // The community variant already guards this; the user one did not, so a
    // userArticle-only update wrongly failed VALIDATION.
    if (!!value?.article && value.userArticle?.articleId !== value.article.articleId) {
      return helpers.error("any.invalid");
    }
    return value;
  }).required(),

  deleteArticle: Joi.object<API.User.deleteArticle.Request>({
    articleId: common.Uuid.required(),
  }).strict(true).required(),

  getFollowers: Joi.object<API.User.getFollowers.Request>({
    userId: common.Uuid.required(),
    limit: Joi.number().integer().min(1).max(30).strict(true),
    offset: Joi.number().integer().min(0).strict(true).required(),
  }).strict(true).required(),

  getFollowing: Joi.object<API.User.getFollowing.Request>({
    userId: common.Uuid.required(),
    limit: Joi.number().integer().min(1).max(30).strict(true),
    offset: Joi.number().integer().min(0).strict(true).required(),
  }).strict(true).required(),

  getFriends: Joi.object<API.User.getFriends.Request>({
    userId: common.Uuid.required(),
    limit: Joi.number().integer().min(1).max(30).strict(true),
    offset: Joi.number().integer().min(0).strict(true).required(),
  }).strict(true).required(),

  buyUserPremiumFeature: Joi.object<API.User.buyUserPremiumFeature.Request>({
    featureName: premiumFeature.required(),
    duration: Joi.string().valid("month", "year", "upgrade").required(),
  }).strict(true).required(),

  setPremiumFeatureAutoRenew: Joi.object<API.User.setPremiumFeatureAutoRenew.Request>({
    featureName: premiumFeature.required(),
    autoRenew: premiumRenewal.required(),
  }).strict(true).required(),

  getUserCommunityIds: Joi.object<API.User.getUserCommunityIds.Request>({
    userId: common.Uuid.required(),
  }).strict(true).required(),

  requestEmailVerification: Joi.object<API.User.requestEmailVerification.Request>({
    email: TldSafeEmailValidator.required(),
  }).strict(true).required(),

  verifyEmail: Joi.object<API.User.verifyEmail.Request>({
    email: TldSafeEmailValidator.required(),
    token: Joi.string().required(),
  }).strict(true).required(),

  sendOneTimePasswordForLogin: Joi.object<API.User.sendOneTimePasswordForLogin.Request>({
    email: TldSafeEmailValidator.required(),
  }).strict(true).required(),
}

export default userApi;

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { convertContentToPreviewText } from "common/converters";
import BaseApiConnector from "./baseConnector";

class UserApiConnector extends BaseApiConnector {
  constructor() {
    super('User');
  }
  
  public async getSignableSecret(): Promise<API.User.getSignableSecret.Response> {
    return await this.ajax<API.User.getSignableSecret.Response>(
      "POST",
      "/getSignableSecret"
    );
  }

  public async verifyCaptcha(data: API.User.verifyCaptcha.Request): Promise<API.User.verifyCaptcha.Response> {
    return await this.ajax<API.User.verifyCaptcha.Response>(
      "POST",
      "/verifyCaptcha",
      data,
    );
  }

  public async clearLoginSession(): Promise<void> {
    return await this.ajax<void>(
      "POST",
      "/clearLoginSession"
    );
  }

  public async login(
    data: API.User.login.Request
  ): Promise<API.User.login.Response> {
    return await this.ajax<API.User.login.Response>(
      "POST",
      "/login",
      data,
    );
  }

  public async checkLoginStatus() {
    return await this.ajax<API.User.checkLoginStatus.Response>(
      "POST",
      "/checkLoginStatus"
    );
  }

  public async logout() {
    return await this.ajax<API.User.logout.Response>(
      "POST",
      "/logout"
    );
  }

  public async createUser(
    data: API.User.createUser.Request
  ): Promise<API.User.createUser.Response> {
    return await this.ajax<API.User.createUser.Response>(
      "POST",
      "/createUser",
      data,
    );
  }

  public async updateOwnData(
    data: API.User.updateOwnData.Request
  ): Promise<API.User.updateOwnData.Response> {
    return await this.ajax<API.User.updateOwnData.Response>(
      "POST",
      "/updateOwnData",
      data,
    );
  }

  public async setOwnExtraDataField(
    data: API.User.setOwnExtraDataField.Request
  ): Promise<API.User.setOwnExtraDataField.Response> {
    return await this.ajax<API.User.setOwnExtraDataField.Response>(
      "POST",
      "/setOwnExtraDataField",
      data,
    );
  }

  public async addUserAccount(
    data: API.User.addUserAccount.Request
  ): Promise<API.User.addUserAccount.Response> {
    return await this.ajax<API.User.addUserAccount.Response>(
      "POST",
      "/addUserAccount",
      data,
    );
  }

  public async updateUserAccount(
    data: API.User.updateUserAccount.Request
  ): Promise<API.User.updateUserAccount.Response> {
    return await this.ajax<API.User.updateUserAccount.Response>(
      "POST",
      "/updateUserAccount",
      data,
    );
  }

  public async removeUserAccount(
    data: API.User.removeUserAccount.Request
  ): Promise<API.User.removeUserAccount.Response> {
    return await this.ajax<API.User.removeUserAccount.Response>(
      "POST",
      "/removeUserAccount",
      data,
    );
  }

  public async prepareWalletAction(
    data: API.User.prepareWalletAction.Request
  ): Promise<API.User.prepareWalletAction.Response> {
    return await this.ajax<API.User.prepareWalletAction.Response>(
      "POST",
      "/prepareWalletAction",
      data,
    );
  }

  public async addPreparedWallet(
    data: API.User.addPreparedWallet.Request
  ): Promise<API.User.addPreparedWallet.Response> {
    return await this.ajax<API.User.addPreparedWallet.Response>(
      "POST",
      "/addPreparedWallet",
      data,
    );
  }

  public async updateWallet(
    data: API.User.updateWallet.Request
  ): Promise<API.User.updateWallet.Response> {
    return await this.ajax<API.User.updateWallet.Response>(
      "POST",
      "/updateWallet",
      data,
    );
  }

  public async deleteWallet(
    data: API.User.deleteWallet.Request
  ): Promise<API.User.deleteWallet.Response> {
    return await this.ajax<API.User.deleteWallet.Response>(
      "POST",
      "/deleteWallet",
      data,
    );
  }

  public async getWallets(
    data: API.User.getWallets.Request
  ): Promise<API.User.getWallets.Response> {
    return await this.ajax<API.User.getWallets.Response>(
      "POST",
      "/getWallets",
      data,
    );
  }

  public async getUserData(
    data: API.User.getUserData.Request
  ): Promise<API.User.getUserData.Response> {
    return await this.ajax<API.User.getUserData.Response>(
      "POST",
      "/getUserData",
      data,
    );
  }

  public async getUserProfileDetails(
    data: API.User.getUserProfileDetails.Request
  ): Promise<API.User.getUserProfileDetails.Response> {
    return await this.ajax<API.User.getUserProfileDetails.Response>(
      "POST",
      "/getUserProfileDetails",
      data,
    );
  }

  public async setOwnStatus(
    data: API.User.setOwnStatus.Request
  ): Promise<API.User.setOwnStatus.Response> {
    return await this.ajax<API.User.setOwnStatus.Response>(
      "POST",
      "/setOwnStatus",
      data,
    );
  }

  public async isCgProfileNameAvailable(
    data: API.User.isCgProfileNameAvailable.Request
  ): Promise<API.User.isCgProfileNameAvailable.Response> {
    return await this.ajax<API.User.isCgProfileNameAvailable.Response>(
      "POST",
      "/isCgProfileNameAvailable",
      data,
    );
  }

  public async isEmailAvailable(
    data: API.User.isEmailAvailable.Request
  ): Promise<API.User.isEmailAvailable.Response> {
    return await this.ajax<API.User.isEmailAvailable.Response>(
      "POST",
      "/isEmailAvailable",
      data,
    );
  }

  public async setPassword(
    data: API.User.setPassword.Request
  ): Promise<API.User.setPassword.Response> {
    return await this.ajax<API.User.setPassword.Response>(
      "POST",
      "/setPassword",
      data,
    );
  }

  public async subscribeNewsletter(
    data: API.User.subscribeNewsletter.Request
  ): Promise<API.User.subscribeNewsletter.Response> {
    return await this.ajax<API.User.subscribeNewsletter.Response>(
      "POST",
      "/subscribeNewsletter",
      data,
    );
  }

  public async unsubscribeNewsletter(
    data: API.User.unsubscribeNewsletter.Request
  ): Promise<API.User.unsubscribeNewsletter.Response> {
    return await this.ajax<API.User.unsubscribeNewsletter.Response>(
      "POST",
      "/unsubscribeNewsletter",
      data,
    );
  }

  public async followUser(
    data: API.User.followUser.Request
  ): Promise<API.User.followUser.Response> {
    return await this.ajax<API.User.followUser.Response>(
      "POST",
      "/followUser",
      data,
    );
  }

  public async unfollowUser(
    data: API.User.unfollowUser.Request
  ): Promise<API.User.unfollowUser.Response> {
    return await this.ajax<API.User.unfollowUser.Response>(
      "POST",
      "/unfollowUser",
      data,
    );
  }

  public async getArticleList(
    data: API.User.getArticleList.Request
  ): Promise<API.User.getArticleList.Response> {
    return await this.ajax<API.User.getArticleList.Response>(
      "POST",
      "/getArticleList",
      data,
    );
  }

  public async getArticleDetailView(
    data: API.User.getArticleDetailView.Request
  ): Promise<API.User.getArticleDetailView.Response> {
    return await this.ajax<API.User.getArticleDetailView.Response>(
      "POST",
      "/getArticleDetailView",
      data,
    );
  }

  public async createArticle(
    data: API.User.createArticle.Request
  ): Promise<API.User.createArticle.Response> {
    return await this.ajax<API.User.createArticle.Response>(
      "POST",
      "/createArticle",
      {
        article: {
          ...data.article,
          previewText: convertContentToPreviewText(data.article.content)
        },
        userArticle: data.userArticle,
      },
    );
  }

  public async updateArticle(
    data: API.User.updateArticle.Request
  ): Promise<API.User.updateArticle.Response> {
    if (data?.article?.content !== undefined) {
      data.article.previewText = convertContentToPreviewText(data.article.content);
    }
    return await this.ajax<API.User.updateArticle.Response>(
      "POST",
      "/updateArticle",
      data,
    );
  }

  public async deleteArticle(
    data: API.User.deleteArticle.Request
  ): Promise<API.User.deleteArticle.Response> {
    return await this.ajax<API.User.deleteArticle.Response>(
      "POST",
      "/deleteArticle",
      data,
    );
  }

  public async getFollowers(data: API.User.getFollowers.Request): Promise<{ userId: string, createdAt: string }[]> {
    return await this.ajax<API.User.getFollowers.Response>(
      "POST",
      "/getFollowers",
      data,
    );
  }

  public async getFollowing(data: API.User.getFollowing.Request): Promise<{ userId: string, createdAt: string }[]> {
    return await this.ajax<API.User.getFollowing.Response>(
      "POST",
      "/getFollowing",
      data,
    );
  }

  public async getFriends(data: API.User.getFriends.Request): Promise<{ userId: string, createdAt: string }[]> {
    return await this.ajax<API.User.getFriends.Response>(
      "POST",
      "/getFriends",
      data,
    );
  }

  public async buyUserPremiumFeature(
    data: API.User.buyUserPremiumFeature.Request
  ): Promise<API.User.buyUserPremiumFeature.Response> {
    await this.ajax<API.User.buyUserPremiumFeature.Response>(
      "POST",
      '/buyUserPremiumFeature',
      data
    );
  }

  public async setPremiumFeatureAutoRenew(
    data: API.User.setPremiumFeatureAutoRenew.Request
  ): Promise<API.User.setPremiumFeatureAutoRenew.Response> {
    await this.ajax<API.User.setPremiumFeatureAutoRenew.Response>(
      "POST",
      '/setPremiumFeatureAutoRenew',
      data
    );
  }

  public async getUserCommunityIds(data: API.User.getUserCommunityIds.Request): Promise<string[]> {
    return await this.ajax<API.User.getUserCommunityIds.Response>(
      "POST",
      "/getUserCommunityIds",
      data,
    );
  }

  public async getTransactionData(): Promise<API.User.getTransactionData.Response> {
    return await this.ajax<API.User.getTransactionData.Response>(
      "POST",
      '/getTransactionData'
    );
  }

  public async requestEmailVerification(data: API.User.requestEmailVerification.Request): Promise<void> {
    await this.ajax<API.User.requestEmailVerification.Response>(
      "POST",
      "/requestEmailVerification",
      data,
    );
  }

  public async verifyEmail(data: API.User.verifyEmail.Request): Promise<void> {
    await this.ajax<API.User.verifyEmail.Response>(
      "POST",
      "/verifyEmail",
      data,
    );
  }
  
  public async composed_addWallet(prepareData: API.User.prepareWalletAction.Request, walletOptions: API.User.addPreparedWallet.Request) {
    const prepareResponse = await this.prepareWalletAction(prepareData);
    if (prepareResponse.readyForCreation) {
      await this.addPreparedWallet(walletOptions);
    }
    else {
      // analyze prepareResult to throw correct error
    }
  }

  public async sendOneTimePasswordForLogin(data: API.User.sendOneTimePasswordForLogin.Request): Promise<void> {
    await this.ajax<API.User.sendOneTimePasswordForLogin.Response>(
      "POST",
      "/sendOneTimePasswordForLogin",
      data,
    );
  }
}

const userApi = new UserApiConnector();
export default userApi;

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import BaseApiConnector from "./baseConnector";

class CommunityApiConnector extends BaseApiConnector {
  constructor() {
    super('Community');
  }
  
  public async getCommunityList(
    data: API.Community.getCommunityList.Request
  ): Promise<Models.Community.ListView[]> {
    const result = await this.ajax<API.Community.getCommunityList.Response>(
      "POST",
      '/getCommunityList',
      data
    );
    return result;
  }

  public async getCommunitiesById(
    data: API.Community.getCommunitiesById.Request
  ): Promise<Models.Community.ListView[]> {
    const result = await this.ajax<API.Community.getCommunitiesById.Response>(
      "POST",
      '/getCommunitiesById',
      data
    );
    return result;
  }

  public async getCommunityDetailView(
    data: API.Community.getCommunityDetailView.Request
  ): Promise<API.Community.getCommunityDetailView.Response> {
    const result = await this.ajax<API.Community.getCommunityDetailView.Response>(
      "POST",
      `/getCommunityDetailView`,
      data
    );
    return result;
  }

  public async joinCommunity(
    data: API.Community.joinCommunity.Request
  ): Promise<API.Community.joinCommunity.Response> {
    const result = await this.ajax<API.Community.joinCommunity.Response>(
      "POST",
      '/joinCommunity',
      data
    );
    return result;
  }

  public async leaveCommunity(
    data: API.Community.leaveCommunity.Request
  ): Promise<API.Community.leaveCommunity.Response> {
    const result = await this.ajax<API.Community.leaveCommunity.Response>(
      "POST",
      '/leaveCommunity',
      data
    );
    return result;
  }

  public async setUserBlockState(
    data: API.Community.setUserBlockState.Request
  ): Promise<API.Community.setUserBlockState.Response> {
    const result = await this.ajax<API.Community.setUserBlockState.Response>(
      "POST",
      '/setUserBlockState',
      data
    );
    return result;
  }

  public async getMemberList(
    data: API.Community.getMemberList.Request
  ): Promise<API.Community.getMemberList.Response> {
    const result = await this.ajax<API.Community.getMemberList.Response>(
      "POST",
      '/getMemberList',
      data
    );
    return result;
  }

  public async getChannelMemberList(
    data: API.Community.getChannelMemberList.Request
  ): Promise<API.Community.getChannelMemberList.Response> {
    const result = await this.ajax<API.Community.getChannelMemberList.Response>(
      "POST",
      '/getChannelMemberList',
      data
    );
    return result;
  }

  public async getMemberNewsletterCount(
    data: API.Community.getMemberNewsletterCount.Request
  ): Promise<API.Community.getMemberNewsletterCount.Response> {
    const result = await this.ajax<API.Community.getMemberNewsletterCount.Response>(
      "POST",
      '/getMemberNewsletterCount',
      data
    );
    return result;
  }

  public async getUserCommunityRoleIds(
    data: API.Community.getUserCommunityRoleIds.Request
  ): Promise<API.Community.getUserCommunityRoleIds.Response> {
    const result = await this.ajax<API.Community.getUserCommunityRoleIds.Response>(
      "POST",
      '/getUserCommunityRoleIds',
      data
    );
    return result;
  }

  /* COMMUNITY */

  public async createCommunity(
    data: API.Community.createCommunity.Request
  ): Promise<API.Community.createCommunity.Response> {
    const result = await this.ajax<API.Community.createCommunity.Response>(
      "POST",
      '/createCommunity',
      data
    );
    return result;
  }

  public async updateCommunity(
    data: API.Community.updateCommunity.Request
  ): Promise<API.Community.updateCommunity.Response> {
    await this.ajax<API.Community.updateCommunity.Response>(
      "POST",
      '/updateCommunity',
      data
    );
  }

  /* AREA */

  public async createArea(
    data: API.Community.createArea.Request
  ): Promise<API.Community.createArea.Response> {
    await this.ajax<API.Community.createArea.Response>(
      "POST",
      '/createArea',
      data
    );
  }

  public async updateArea(
    data: API.Community.updateArea.Request
  ): Promise<API.Community.updateArea.Response> {
    await this.ajax<API.Community.updateArea.Response>(
      "POST",
      '/updateArea',
      data
    );
  }

  public async deleteArea(
    data: API.Community.deleteArea.Request
  ): Promise<API.Community.deleteArea.Response> {
    await this.ajax<API.Community.deleteArea.Response>(
      "POST",
      '/deleteArea',
      data
    );
  }

  /* CHANNEL */

  public async createChannel(
    data: API.Community.createChannel.Request
  ): Promise<API.Community.createChannel.Response> {
    await this.ajax<API.Community.createChannel.Response>(
      "POST",
      '/createChannel',
      data
    );
  }

  public async updateChannel(
    data: API.Community.updateChannel.Request
  ): Promise<API.Community.updateChannel.Response> {
    await this.ajax<API.Community.updateChannel.Response>(
      "POST",
      '/updateChannel',
      data
    );
  }

  public async deleteChannel(
    data: API.Community.deleteChannel.Request
  ): Promise<API.Community.deleteChannel.Response> {
    await this.ajax<API.Community.deleteChannel.Response>(
      "POST",
      '/deleteChannel',
      data
    );
  }

  /* ROLE */

  public async createRole(
    data: API.Community.createRole.Request
  ): Promise<API.Community.createRole.Response> {
    return await this.ajax<API.Community.createRole.Response>(
      "POST",
      '/createRole',
      data
    );
  }

  public async updateRole(
    data: API.Community.updateRole.Request
  ): Promise<API.Community.updateRole.Response> {
    await this.ajax<API.Community.updateRole.Response>(
      "POST",
      '/updateRole',
      data
    );
  }

  public async deleteRole(data: API.Community.deleteRole.Request): Promise<API.Community.deleteRole.Response> {
    await this.ajax<API.Community.deleteRole.Response>(
      "POST",
      '/deleteRole',
      data
    );
  }

  public async checkCommunityRoleClaimability(
    data: API.Community.checkCommunityRoleClaimability.Request
  ): Promise<API.Community.checkCommunityRoleClaimability.Response> {
    return await this.ajax<API.Community.checkCommunityRoleClaimability.Response>(
      "POST",
      '/checkCommunityRoleClaimability',
      data
    );
  }

  public async claimRole(
    data: API.Community.claimRole.Request
  ): Promise<API.Community.claimRole.Response> {
    return await this.ajax<API.Community.claimRole.Response>(
      "POST",
      '/claimRole',
      data
    );
  }

  public async addUserToRoles(
    data: API.Community.addUserToRoles.Request
  ): Promise<API.Community.addUserToRoles.Response> {
    await this.ajax<API.Community.addUserToRoles.Response>(
      "POST",
      '/addUserToRoles',
      data
    );
  }

  public async removeUserFromRoles(
    data: API.Community.removeUserFromRoles.Request
  ): Promise<API.Community.removeUserFromRoles.Response> {
    await this.ajax<API.Community.removeUserFromRoles.Response>(
      "POST",
      '/removeUserFromRoles',
      data
    );
  }

  /* TOKEN */

  public async addCommunityToken(
    data: API.Community.addCommunityToken.Request
  ): Promise<API.Community.addCommunityToken.Response> {
    return await this.ajax<API.Community.addCommunityToken.Response>(
      "POST",
      '/addCommunityToken',
      data
    );
  }

  public async removeCommunityToken(
    data: API.Community.removeCommunityToken.Request
  ): Promise<API.Community.removeCommunityToken.Response> {
    await this.ajax<API.Community.removeCommunityToken.Response>(
      "POST",
      '/removeCommunityToken',
      data
    );
  }

  /* PREMIUM */

  public async givePointsToCommunity(
    data: API.Community.givePointsToCommunity.Request
  ): Promise<API.Community.givePointsToCommunity.Response> {
    await this.ajax<API.Community.givePointsToCommunity.Response>(
      "POST",
      '/givePointsToCommunity',
      data
    );
  }

  public async buyCommunityPremiumFeature(
    data: API.Community.buyCommunityPremiumFeature.Request
  ): Promise<API.Community.buyCommunityPremiumFeature.Response> {
    await this.ajax<API.Community.buyCommunityPremiumFeature.Response>(
      "POST",
      '/buyCommunityPremiumFeature',
      data
    );
  }

  public async setPremiumFeatureAutoRenew(
    data: API.Community.setPremiumFeatureAutoRenew.Request
  ): Promise<API.Community.setPremiumFeatureAutoRenew.Response> {
    await this.ajax<API.Community.setPremiumFeatureAutoRenew.Response>(
      "POST",
      '/setPremiumFeatureAutoRenew',
      data
    );
  }

  /* ONBOARDING */
  public async getCommunityPassword(
    data: API.Community.getCommunityPassword.Request
  ): Promise<API.Community.getCommunityPassword.Response> {
    return await this.ajax<API.Community.getCommunityPassword.Response>(
      "POST",
      '/getCommunityPassword',
      data
    );
  }

  public async verifyCommunityPassword(
    data: API.Community.verifyCommunityPassword.Request
  ): Promise<API.Community.verifyCommunityPassword.Response> {
    return await this.ajax<API.Community.verifyCommunityPassword.Response>(
      "POST",
      '/verifyCommunityPassword',
      data
    );
  }

  public async setOnboardingOptions(
    data: API.Community.setOnboardingOptions.Request
  ): Promise<API.Community.setOnboardingOptions.Response> {
    await this.ajax<API.Community.setOnboardingOptions.Response>(
      "POST",
      '/setOnboardingOptions',
      data
    );
  }

  public async getPendingJoinApprovals(
    data: API.Community.getPendingJoinApprovals.Request
  ): Promise<API.Community.getPendingJoinApprovals.Response> {
    return await this.ajax<API.Community.getPendingJoinApprovals.Response>(
      "POST",
      '/getPendingJoinApprovals',
      data
    );
  }

  public async setAllPendingJoinApprovals(
    data: API.Community.setAllPendingJoinApprovals.Request
  ): Promise<API.Community.setAllPendingJoinApprovals.Response> {
    return await this.ajax<API.Community.setAllPendingJoinApprovals.Response>(
      "POST",
      '/setAllPendingJoinApprovals',
      data
    );
  }

  public async setPendingJoinApproval(
    data: API.Community.setPendingJoinApproval.Request
  ): Promise<API.Community.setPendingJoinApproval.Response> {
    return await this.ajax<API.Community.setPendingJoinApproval.Response>(
      "POST",
      '/setPendingJoinApproval',
      data
    );
  }

  public async getBannedUsers(
    data: API.Community.getBannedUsers.Request
  ): Promise<API.Community.getBannedUsers.Response> {
    return await this.ajax<API.Community.getBannedUsers.Response>(
      "POST",
      '/getBannedUsers',
      data
    );
  }
  
  /* ARTICLES */

  public async getArticleList(
    data: API.Community.getArticleList.Request
  ): Promise<API.Community.getArticleList.Response> {
    return await this.ajax<API.Community.getArticleList.Response>(
      "POST",
      '/getArticleList',
      data
    );
  }

  public async getArticleDetailView(
    data: API.Community.getArticleDetailView.Request
  ): Promise<API.Community.getArticleDetailView.Response> {
    return await this.ajax<API.Community.getArticleDetailView.Response>(
      "POST",
      '/getArticleDetailView',
      data
    );
  }

  public async createArticle(
    data: API.Community.createArticle.Request
  ): Promise<API.Community.createArticle.Response> {
    return await this.ajax<API.Community.createArticle.Response>(
      "POST",
      '/createArticle',
      data
    );
  }

  public async updateArticle(
    data: API.Community.updateArticle.Request
  ): Promise<API.Community.updateArticle.Response> {
    await this.ajax<API.Community.updateArticle.Response>(
      "POST",
      '/updateArticle',
      data
    );
  }

  public async deleteArticle(
    data: API.Community.deleteArticle.Request
  ): Promise<API.Community.deleteArticle.Response> {
    await this.ajax<API.Community.deleteArticle.Response>(
      "POST",
      '/deleteArticle',
      data
    );
  }

  public async sendArticleAsEmail(
    data: API.Community.sendArticleAsEmail.Request
  ): Promise<API.Community.sendArticleAsEmail.Response> {
    await this.ajax<API.Community.sendArticleAsEmail.Response>(
      "POST",
      '/sendArticleAsEmail',
      data
    );
  }

  public async getCall(
    data: API.Community.getCall.Request
  ): Promise<API.Community.getCall.Response> {
    return await this.ajax<API.Community.getCall.Response>(
      "POST",
      '/getCall',
      data
    );
  }

  public async startCall(
    data: API.Community.startCall.Request
  ): Promise<API.Community.startCall.Response> {
    return await this.ajax<API.Community.startCall.Response>(
      "POST",
      '/startCall',
      data
    );
  }

  public async startScheduledCall(
    data: API.Community.startScheduledCall.Request
  ): Promise<API.Community.startScheduledCall.Response> {
    return await this.ajax<API.Community.startScheduledCall.Response>(
      "POST",
      '/startScheduledCall',
      data
    );
  }

  public async getCurrentCalls(
    data: API.Community.getCurrentCalls.Request
  ): Promise<API.Community.getCurrentCalls.Response> {
    return await this.ajax<API.Community.getCurrentCalls.Response>(
      "POST",
      '/getCurrentCalls',
      data
    );
  }

  public async getCallParticipantEvents(
    data: API.Community.getCallParticipantEvents.Request
  ): Promise<API.Community.getCallParticipantEvents.Response> {
    return await this.ajax<API.Community.getCallParticipantEvents.Response>(
      "POST",
      '/getCallParticipantEvents',
      data
    );
  }

  public async setChannelPinState(
    data: API.Community.setChannelPinState.Request
  ): Promise<API.Community.setChannelPinState.Response> {
    return await this.ajax<API.Community.setChannelPinState.Response>(
      "POST",
      '/setChannelPinState',
      data
    );
  }

  public async getTagFrequencyData(): Promise<API.Community.getTagFrequencyData.Response> {
    return await this.ajax<API.Community.getTagFrequencyData.Response>(
      "POST",
      '/getTagFrequencyData'
    );
  }

  public async getEvent(data: API.Community.getEvent.Request): Promise<API.Community.getEvent.Response> {
    return await this.ajax<API.Community.getEvent.Response>(
      "POST",
      '/getEvent',
      data
    );
  }

  public async createCommunityEvent(data: API.Community.createCommunityEvent.Request): Promise<API.Community.createCommunityEvent.Response> {
    return await this.ajax<API.Community.createCommunityEvent.Response>(
      "POST",
      '/createCommunityEvent',
      data
    );
  }

  public async updateCommunityEvent(data: API.Community.updateCommunityEvent.Request): Promise<API.Community.updateCommunityEvent.Response> {
    return await this.ajax<API.Community.updateCommunityEvent.Response>(
      "POST",
      '/updateCommunityEvent',
      data
    );
  }

  public async deleteCommunityEvent(data: API.Community.deleteCommunityEvent.Request): Promise<API.Community.deleteCommunityEvent.Response> {
    return await this.ajax<API.Community.deleteCommunityEvent.Response>(
      "POST",
      '/deleteCommunityEvent',
      data
    );
  }

  public async getEventList(data: API.Community.getEventList.Request): Promise<API.Community.getEventList.Response> {
    return await this.ajax<API.Community.getEventList.Response>(
      "POST",
      '/getEventList',
      data
    );
  }

  public async getMyEvents(data: API.Community.getMyEvents.Request): Promise<API.Community.getMyEvents.Response> {
    return await this.ajax<API.Community.getMyEvents.Response>(
      "POST",
      '/getMyEvents',
      data
    );
  }

  public async getUpcomingEvents(data: API.Community.getUpcomingEvents.Request): Promise<API.Community.getUpcomingEvents.Response> {
    return await this.ajax<API.Community.getUpcomingEvents.Response>(
      "POST",
      '/getUpcomingEvents',
      data
    );
  }

  public async addEventParticipant(data: API.Community.addEventParticipant.Request): Promise<API.Community.addEventParticipant.Response> {
    return await this.ajax<API.Community.addEventParticipant.Response>(
      "POST",
      '/addEventParticipant',
      data
    );
  }

  public async addEventParticipantByCallId(data: API.Community.addEventParticipantByCallId.Request): Promise<API.Community.addEventParticipantByCallId.Response> {
    return await this.ajax<API.Community.addEventParticipantByCallId.Response>(
      "POST",
      '/addEventParticipantByCallId',
      data
    );
  }

  public async removeEventParticipant(data: API.Community.removeEventParticipant.Request): Promise<API.Community.removeEventParticipant.Response> {
    return await this.ajax<API.Community.removeEventParticipant.Response>(
      "POST",
      '/removeEventParticipant',
      data
    );
  }

  public async getTransactionData(data: API.Community.getTransactionData.Request): Promise<API.Community.getTransactionData.Response> {
    return await this.ajax<API.Community.getTransactionData.Response>(
      "POST",
      '/getTransactionData',
      data
    );
  }

  public async getCommunityCount(data: API.Community.getCommunityCount.Request): Promise<API.Community.getCommunityCount.Response> {
    return await this.ajax<API.Community.getCommunityCount.Response>(
      "POST",
      '/getCommunityCount',
      data
    );
  }

  public async updateNotificationState(
    data: API.Community.updateNotificationState.Request
  ): Promise<API.Community.updateNotificationState.Response> {
    return await this.ajax<API.Community.updateNotificationState.Response>(
      "POST",
      '/updateNotificationState',
      data
    );
  }

  public async subscribeToCommunityNewsletter(
    data: API.Community.subscribeToCommunityNewsletter.Request
  ): Promise<API.Community.subscribeToCommunityNewsletter.Response> {
    return await this.ajax<API.Community.subscribeToCommunityNewsletter.Response>(
      "POST",
      '/subscribeToCommunityNewsletter',
      data
    );
  }

  public async unsubscribeFromCommunityNewsletter(
    data: API.Community.unsubscribeFromCommunityNewsletter.Request
  ): Promise<API.Community.unsubscribeFromCommunityNewsletter.Response> {
    return await this.ajax<API.Community.unsubscribeFromCommunityNewsletter.Response>(
      "POST",
      '/unsubscribeFromCommunityNewsletter',
      data
    );
  }
  
  public async getLatestArticleSentAsNewsletterDate(
    data: API.Community.getLatestArticleSentAsNewsletterDate.Request
  ): Promise<API.Community.getLatestArticleSentAsNewsletterDate.Response> {
    return await this.ajax<API.Community.getLatestArticleSentAsNewsletterDate.Response>(
      "POST",
      '/getLatestArticleSentAsNewsletterDate',
      data
    );
  }

  public async getNewsletterHistory(
    data: API.Community.getNewsletterHistory.Request
  ): Promise<API.Community.getNewsletterHistory.Response> {
    return await this.ajax<API.Community.getNewsletterHistory.Response>(
      "POST",
      '/getNewsletterHistory',
      data
    );
  }

  public async getAirdropClaimHistory(
    data: API.Community.getAirdropClaimHistory.Request
  ): Promise<API.Community.getAirdropClaimHistory.Response> {
    return await this.ajax<API.Community.getAirdropClaimHistory.Response>(
      "POST",
      '/getAirdropClaimHistory',
      data
    );
  }

  public async getAirdropCommunities(
    data: API.Community.getAirdropCommunities.Request
  ): Promise<API.Community.getAirdropCommunities.Response> {
    return await this.ajax<API.Community.getAirdropCommunities.Response>(
      "POST",
      '/getAirdropCommunities',
      data
    );
  }
}

const communityApi = new CommunityApiConnector();
export default communityApi;
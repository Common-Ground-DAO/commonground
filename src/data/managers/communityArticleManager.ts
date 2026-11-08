// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { convertContentToPreviewText } from "common/converters";
import { PredefinedRole } from "common/enums";
import communityApi from "data/api/community";
import { Dexie } from "dexie";
import _ from "lodash";
import { isPredefinedRolePermission } from "util/predefinedRoles";

class CommunityArticleManager {
  public async getArticleList(data: API.Community.getArticleList.Request) {
    return await new Dexie.Promise<API.Community.getArticleList.Response>((resolve, reject) => {
      communityApi.getArticleList(data).then(resolve).catch(reject);
    });
  }

  public async getArticle(data: API.Community.getArticleDetailView.Request) {
    return await new Dexie.Promise<API.Community.getArticleDetailView.Response>((resolve, reject) => {
      communityApi.getArticleDetailView(data).then(resolve).catch(reject);
    });
  }

  public async createArticle(data: API.Community.createArticle.Request) {
    const newData: API.Community.createArticle.Request = {
      ...data,
      article: {
        ...data.article,
        previewText: convertContentToPreviewText(data.article.content)
      }
    }
    return await communityApi.createArticle(newData);
  }

  public async updateArticle(data: API.Community.updateArticle.Request) {
    const newData: API.Community.updateArticle.Request = {
      ...data,
      article: {
        ...data.article,
        articleId: data.communityArticle.articleId,
      }
    }
    if (newData.article?.content) {
      newData.article.previewText = convertContentToPreviewText(newData.article.content)
    }
    // Can't update creator id
    if (newData.article && 'creatorId' in newData.article) {
      delete (newData.article as any).creatorId;
    }
    // Can't update creator id
    if (newData.communityArticle && 'updatedAt' in newData.communityArticle) {
      delete (newData.communityArticle as any).updatedAt;
    }
    // Don't update admin role NEVER
    if (newData.communityArticle.rolePermissions) {
      newData.communityArticle.rolePermissions = newData.communityArticle.rolePermissions.filter(role => !isPredefinedRolePermission(role, PredefinedRole.Admin));
    }
    return await communityApi.updateArticle(newData);
  }

  public async deleteArticle(data: API.Community.deleteArticle.Request) {
    return await communityApi.deleteArticle(data);
  }

  public async sendArticleAsEmail(data: API.Community.sendArticleAsEmail.Request) {
    return await communityApi.sendArticleAsEmail(data);
  }
};

const communityArticleManager = new CommunityArticleManager();
export default communityArticleManager;
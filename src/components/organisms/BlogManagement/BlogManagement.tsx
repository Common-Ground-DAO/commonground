// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md


import "./BlogManagement.css";
import { useMemo, useRef } from "react";
import { useNavigate } from "react-router";
import { useOwnUser } from "context/OwnDataProvider";
import userApi from "data/api/user";
import { getUrl } from 'common/util';
import GenericArticleManagement, { ItemArticleType } from "../GenericArticleManagement/GenericArticleManagement";

type Props = {
  articleId?: string;
}

function prepareTypeToCreate(item: ItemArticleType) {
  const { communityId, rolePermissions, ...rest } = item;
  return rest;
}

function prepareArticleToUpdate(article: Models.BaseArticle.DetailView) {
  const { creatorId, channelId, commentCount, latestCommentTimestamp, ...rest } = article;
  return rest;
}

function prepareTypeToUpdate(item: ItemArticleType & { articleId: string }) {
  return {
    published: item.published,
    articleId: item.articleId,
    url: item.url,
  };
}

export default function BlogManagement(props: Props) {
  const { articleId } = props;
  const ownUser = useOwnUser();
  const navigate = useNavigate();

  const emptyUserArticle: Pick<Models.User.UserArticle, 'url' | 'published'> = useMemo(() => ({
    url: null,
    published: null,
  }), []);

  const userArticleRef = useRef<typeof emptyUserArticle>(emptyUserArticle);

  return <GenericArticleManagement
    articleId={articleId}
    itemArticleRef={userArticleRef}
    loadItem={async (articleId) => {
      const userArticle = await userApi.getArticleDetailView({
        articleId,
        userId: ownUser?.id || ''
      });
      return {
        article: userArticle.article,
        itemArticle: userArticle.userArticle
      };
    }}
    createArticleCall={async (_article, userArticle) => {
      const { channelId, commentCount, latestCommentTimestamp, ...article } = _article;
      const response = await userApi.createArticle({
        article,
        userArticle: prepareTypeToCreate(userArticle)
      });
      return { articleId: response.userArticle.articleId };
    }}
    updateArticleCall={async (article, userArticle) => {
      await userApi.updateArticle({
        article: prepareArticleToUpdate(article as any),
        userArticle: prepareTypeToUpdate(userArticle)
      });
    }}
    removeArticleCall={async (articleId) => {
      await userApi.deleteArticle({ articleId });
    }}
    goBack={() => {
      if (ownUser) {
        navigate(getUrl({ type: 'user', user: ownUser }))
      }
      else {
        navigate(getUrl({ type: 'home' }));
      }
    }}
  />;
}
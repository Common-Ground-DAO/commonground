// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './Blog.css';
import React from 'react';
import { useNavigate } from 'react-router';
import { blogViewReducer, initialState } from './Blog.reducer';
import { getUrl } from "common/util";
import userArticleManager from 'data/managers/userArticleManager';
import GenericArticle from '../GenericArticle/GenericArticle';
import { useOwnUser } from 'context/OwnDataProvider';

type Props = {
  articleId: string;
  userId: string;
  sidebarMode?: boolean;
  goBack?: () => void;
}

const RELATED_BLOGS_LIMIT = 3;

const Blog: React.FC<Props> = ({ articleId, userId, sidebarMode, goBack }) => {
  const navigate = useNavigate();
  const [dataState, dispatch] = React.useReducer(blogViewReducer, initialState);
  const ownUser = useOwnUser();
  const isSelf = ownUser?.id === userId;

  // Fetch blog
  React.useEffect(() => {
    const fetch = async (userId: string, articleId: string) => {
      dispatch({ type: 'StartLoading' });
      try {
        const blog = await userArticleManager.getArticle({ userId, articleId });
        if (blog) {
          dispatch({ type: 'LoadBlog', blog: blog });

          const blogs = await userArticleManager.getArticleList({
            order: 'DESC',
            limit: RELATED_BLOGS_LIMIT + 1,
            userId
          });
          dispatch({ type: 'LoadRelatedBlogs', relatedBlogs: blogs.filter(currBlog => currBlog.article.articleId !== blog.article.articleId) });
        } else {
          dispatch({ type: 'ShowError', error: 'Blog not found' });
        }
      } catch (err) {
        console.log('going back why?');
        console.error('Error fetching user post:', err);
        navigate(getUrl({ type: 'user', user: { id: userId } }));
      }
    }
    fetch(userId, articleId);
  }, [articleId, navigate, userId]);

  return <GenericArticle
    article={dataState.blog?.article}
    itemArticle={dataState.blog?.userArticle}
    moreArticles={dataState.relatedBlogs}
    url={dataState.blog ? getUrl({ type: 'user-article', user: { id: userId }, article: dataState.blog.article }) : ''}
    goBack={goBack || (() => navigate(getUrl({ type: 'user', user: { id: userId } })))}
    isLoading={dataState.stateNode === 'LOADING'}
    error={dataState.error}
    sidebarMode={sidebarMode}
    canEdit={isSelf}
  />;
}

export default React.memo(Blog);
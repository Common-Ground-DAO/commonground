// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import './Article.css';
import { useNavigate } from 'react-router';
import { articleViewReducer, initialState } from './Article.reducer';
import { getUrl } from 'common/util';
import communityArticleManager from 'data/managers/communityArticleManager';
import { useAsyncMemo } from 'hooks/useAsyncMemo';
import { calculatePermissions } from '../GatedDialogModal/GatedDialogModal';
import errors from 'common/errors';
import { useCommunityListView } from 'context/CommunityListViewProvider';
import GenericArticle from '../GenericArticle/GenericArticle';
import { useSafeCommunityContext } from 'context/CommunityProvider';

const RELATED_ARTICLE_LIMIT = 3;

type Props = {
  articleId: string;
  communityId: string;
  sidebarMode?: boolean;
  goBack?: () => void;
}

const Article: React.FC<Props> = ({ articleId, communityId, sidebarMode, goBack }) => {
  const navigate = useNavigate();
  const [dataState, dispatch] = React.useReducer(articleViewReducer, initialState);
  const [showGatedDialog, setShowGatedDialog] = React.useState(false);
  const communityContext = useSafeCommunityContext();
  const community = useCommunityListView(communityId);

  const gatedState = useAsyncMemo(async () => {
    if (showGatedDialog) {
      const [article] = await communityArticleManager.getArticleList({ communityId, limit: 1, ids: [articleId] });
      if (article) {
        return calculatePermissions(article);
      }
    }
    return null;
  }, [showGatedDialog, communityId, articleId]);

  // Fetch article and display correct data
  React.useEffect(() => {
    const fetchArticle = async (communityId: string, articleId: string) => {
      dispatch({ type: 'StartLoading' });
      try {
        const article = await communityArticleManager.getArticle({ communityId, articleId });

        if (article) {
          dispatch({ type: 'LoadArticle', article });

          const articles = await communityArticleManager.getArticleList({
            order: 'DESC',
            limit: RELATED_ARTICLE_LIMIT + 1,
            communityId,
          });

          dispatch({ type: 'LoadMoreArticles', loadedArticles: articles.filter(currArticle => currArticle.article.articleId !== article.article.articleId) });
        } else {
          dispatch({ type: 'ShowError', error: 'Article not found' });
        }
      } catch (err) {
        if ((err as Error).message === errors.server.NOT_ALLOWED) {
          setShowGatedDialog(true);
          dispatch({ type: 'ShowError', error: 'Not allowed' });
        } else {
          console.log(err);
          if (community?.url && !sidebarMode) navigate(getUrl({ type: 'community-lobby', community: { url: community.url } }));
        }
      }
    }

    if (communityId && articleId) {
      fetchArticle(communityId, articleId);
    }
  }, [community?.url, navigate, articleId, communityId, sidebarMode]);

  return <GenericArticle
    article={dataState?.article?.article}
    itemArticle={dataState?.article?.communityArticle}
    isLoading={dataState.stateNode === 'LOADING'}
    error={dataState.error}
    url={community && dataState.article ? getUrl({
      type: 'community-article',
      community: community,
      article: dataState?.article?.article
    }) : ''}
    gatedState={gatedState}
    showGatedDialog={showGatedDialog}
    setShowGatedDialog={setShowGatedDialog}
    goBack={goBack}
    moreArticles={dataState.moreArticles}
    sidebarMode={sidebarMode}
    canEdit={communityContext.state === 'loaded' && communityContext.communityPermissions.has('COMMUNITY_MANAGE_ARTICLES')}
  />;
}

export default React.memo(Article);

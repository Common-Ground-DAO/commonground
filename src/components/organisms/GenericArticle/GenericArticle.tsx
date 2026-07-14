// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useMemo } from 'react'
import './GenericArticle.css';
import Button from '../../../components/atoms/Button/Button';
import UserTag from '../../atoms/UserTag/UserTag';
import { useSignedUrl } from '../../../hooks/useSignedUrl';
import { useNavigate } from 'react-router-dom';
import useLocalStorage, { ReadArticlesState } from '../../../hooks/useLocalStorage';
import dayjs from 'dayjs';
import ShareButton from '../../../components/atoms/ShareButton/ShareButton';
import { AllContentRenderer } from '../../../components/molecules/MesssageBodyRenderer/MessageBodyRenderer';
import MarkdownContent, { toMarkdownSource } from '../../../components/molecules/MesssageBodyRenderer/MarkdownContent';
import ContentSlider from '../../../components/molecules/ContentSlider/ContentSlider';

import { ArrowLeftCircleIcon, ArrowLeftIcon, PencilIcon } from '@heroicons/react/20/solid';
import { useUserData } from 'context/UserDataProvider';
import LoginBanner from 'components/molecules/LoginBanner/LoginBanner';
import { useOwnUser } from 'context/OwnDataProvider';
import GatedDialogModal, { CalculatedPermission } from '../GatedDialogModal/GatedDialogModal';
import { ArrowsOutSimple, Chat, Spinner } from '@phosphor-icons/react';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import Tag, { TagIcon } from 'components/atoms/Tag/Tag';
import { tagStringToPredefinedTag } from 'components/molecules/inputs/TagInputField/TagInputField';
import ArticleCommentSection from '../ArticleCommentSection/ArticleCommentSection';

const RELATED_ARTICLE_LIMIT = 3;

type Props = {
  article?: Models.BaseArticle.DetailView;
  itemArticle?: Models.User.UserArticle | Models.Community.CommunityArticle;
  url: string;
  isLoading: boolean;
  error: string | undefined;
  canEdit: boolean;
  moreArticles?: API.Community.getArticleList.Response | API.User.getArticleList.Response;
  sidebarMode?: boolean;
  goBack?: () => void;

  gatedState?: CalculatedPermission | null;
  showGatedDialog?: boolean;
  setShowGatedDialog?: (show: boolean) => void;
}

function formatDate(date: Date): string {
  return dayjs(date).format('MMM DD, YYYY');
}

const GenericArticle: React.FC<Props> = ({ article, itemArticle, url, isLoading, error, canEdit, moreArticles, sidebarMode, goBack, gatedState, showGatedDialog, setShowGatedDialog }) => {
  const navigate = useNavigate();
  const ownUser = useOwnUser();
  const { isMobile } = useWindowSizeContext();
  const [, setContentReadState] = useLocalStorage<ReadArticlesState>({}, 'content-read-state');
  const imageUrl = useSignedUrl(article?.headerImageId);

  const goToArticlePage = useCallback(() => {
    navigate(url);
  }, [navigate, url]);

  const creator = useUserData(article?.creatorId);

  const tags = useMemo(() => tagStringToPredefinedTag(article?.tags || []), [article?.tags])

  // Update local storage with read articles
  React.useEffect(() => {
    setContentReadState(oldContentReadState => {
      if (article) {
        const contentReadStateCopy = { ...oldContentReadState };
        contentReadStateCopy[article.articleId] = true;
        return contentReadStateCopy;
      } else {
        return oldContentReadState;
      }
    });
  }, [article, setContentReadState]);

  let content: JSX.Element;
  // Loading
  if (isLoading) {
    content = <div className='articleViewLoading'>
      <Spinner className="spinner w-14 h-14" />
    </div>;
  } else if (!!error) {
    content = <div className='articleViewLockedView'>
      <span className='articleViewTitle'>{error}</span>
      <Button
        className='button'
        onClick={goBack}
        text="Go to Community"
        role="secondary"
        iconLeft={<ArrowLeftCircleIcon />}
      />
    </div>;
  } else {
    // Actual article
    const publishedDate = itemArticle?.published;

    let sectionEnd: JSX.Element | null = null;

    if (!sidebarMode) {
      sectionEnd = <Button role='secondary' className='section-end-button' onClick={goBack} text='Back' />;
    }

    if (moreArticles && moreArticles.length > 0) {
      sectionEnd = <div className='flex flex-col gap-2 w-full sectionEndSliderContainer'>
        <h3>Read more:</h3>
        <ContentSlider
          items={moreArticles}
          cardCountLimit={RELATED_ARTICLE_LIMIT}
          hideAuthors
        />
      </div>;
    }

    content = <>
      <div className="articleViewContent">
        {sidebarMode && <div className={`flex justify-between absolute top-4 ${isMobile ? 'left-4 right-4' : 'left-8 right-8'}`}>
          <Button
            role="secondary"
            iconLeft={<ArrowLeftIcon className="w-5 h-5" />}
            onClick={goBack}
            className="cg-circular tray-btn z-10"
          />
          <Button
            role="secondary"
            iconLeft={<ArrowsOutSimple weight="duotone" className="w-5 h-5" />}
            text='Go to Article'
            onClick={goToArticlePage}
            className="cg-circular tray-btn z-10"
          />
        </div>}
        {article?.headerImageId && <img className='articleViewHeader' src={imageUrl} alt='Header' />}
        <div className='articleViewTitle'>
          <span className='articleViewTitleInfo'>{article?.title || ''}</span>

          <div className='flex flex-wrap gap-2'>
            {tags.map(tag => <Tag
              variant='tag'
              iconLeft={<TagIcon tag={tag} />}
              key={tag.name}
              label={tag.name}
            />)}
          </div>

          <div className='articleViewSubtitleInfo'>
            <div className='articleViewSubtitleInfoAuthor'>
              {creator && <UserTag userData={creator} noOfflineDimming />}
              <span>{publishedDate && formatDate(new Date(publishedDate))}</span>
              <div className='flex items-center gap-1 cg-bg-subtle cg-border-l p-2'>
                <Chat weight='duotone' className='w-5 h-5' />
                <span>{article?.commentCount || 0} Comments</span>
              </div>
            </div>
            <div className='flex gap-2'>
              <ShareButton
                role='chip'
                relativeUrl={url}
                buttonText='Share' contentTitle={article?.title || ''}
                contentText={`Read "${article?.title}" on Common Ground`}
              />
              {canEdit && <Button
                iconLeft={<PencilIcon className='w-5 h-5' />}
                role='chip'
                text={`Edit`}
                onClick={() =>
                  navigate(`${url}edit`)}
              />}
            </div>
          </div>
          <div className='articleViewDivider' />
        </div>
        <div className='articleViewText'>
          {article?.content.version === '1' && <MarkdownContent source={toMarkdownSource(article.content.text.split('\n'))} />}
          {article?.content.version === '2' && <AllContentRenderer content={article?.content.content} showMidwayLoginBanner renderInternalLinks />}
        </div>
        <div className='articleViewDivider long' />
        {sectionEnd}
        <ArticleCommentSection
          articleId={article?.articleId || ''}
          channelId={article?.channelId || ''}
          articleCommunityId={itemArticle && 'communityId' in itemArticle ? itemArticle.communityId : undefined}
          articleUserId={itemArticle && 'userId' in itemArticle ? itemArticle.userId : undefined}
        />
        <div className='h-8 w-full' />
      </div>
    </>;
  }

  return (
    <div className={`articleView ${sidebarMode ? 'sidebarMode' : ''}`}>
      {!ownUser && <LoginBanner stickyMode />}
      {content}
      {gatedState && <GatedDialogModal
        requiredPermissions={gatedState}
        isOpen={showGatedDialog || false}
        onClose={(redirect) => {
          setShowGatedDialog?.(false);
          if (redirect) {
            window.location.reload();
          }
        }}
      />}
    </div>
  );
}

export default React.memo(GenericArticle);

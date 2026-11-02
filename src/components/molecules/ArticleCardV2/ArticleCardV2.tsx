// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect, useMemo, useRef, useState } from "react";
import "./ArticleCardV2.css";
import dayjs from "dayjs";

import ArticleClayIcon from '../../../components/atoms/icons/40/articleClay.png';
import { getCommunityDisplayName, getDisplayName, } from "../../../util";
import { getUrl } from "common/util";
import { createSearchParams, useNavigate } from "react-router";
import useLocalStorage, { ReadArticlesState, ReadLatestArticleCommentsState } from "hooks/useLocalStorage";
import { useWindowSizeContext } from "context/WindowSizeProvider";
import CommunityPhoto from "components/atoms/CommunityPhoto/CommunityPhoto";
import { useSignedUrl } from "hooks/useSignedUrl";
import NotificationDot from "components/atoms/NotificationDot/NotificationDot";
import { useUserData } from "context/UserDataProvider";
import GatedDialogModal, { calculatePermissions } from "components/organisms/GatedDialogModal/GatedDialogModal";
import { useAsyncMemo } from "hooks/useAsyncMemo";
import { calculateArticleAgeString, isArticleGated, isRecentUnread } from "./ArticleCardV2.helper";
import { useCommunityListView } from "context/CommunityListViewProvider";
import ArticleExclusiveTooltip from "./ArticleExclusiveTooltip";
import Jdenticon from "components/atoms/Jdenticon/Jdenticon";
import { useSidebarDataDisplayContext } from "context/SidebarDataDisplayProvider";
import { Chat } from "@phosphor-icons/react";

const MINIMUM_COLLAPSED_WIDTH = 400;

type Props = {
  article: API.User.getArticleList.Response[0] | API.Community.getArticleList.Response[0];
  isPreview?: boolean;
  hideAuthor?: boolean;
}

export default function ArticleCard(props: Props) {
  const {
    article,
    hideAuthor
  } = props;

  const navigate = useNavigate();
  const { isMobile } = useWindowSizeContext();
  const { showTooltip } = useSidebarDataDisplayContext();
  const [contentReadState,] = useLocalStorage<ReadArticlesState>({}, 'content-read-state');
  const [contentCommentReadState,] = useLocalStorage<ReadLatestArticleCommentsState>({}, 'content-comment-read-state');
  const isRead = contentReadState[article.article.articleId] === true;
  const cardDateString = ('communityArticle' in article) ? article.communityArticle.published : article.userArticle.published;
  const cardDate = dayjs(cardDateString);
  const [showGatedDialog, setShowGatedDialog] = useState(false);
  const [isSmallMode, setSmallMode] = useState(false);
  const articleCardRef = useRef<HTMLDivElement>(null);

  const isLastCommentRead = useMemo(() => {
    const localLastRead = contentCommentReadState[article.article.articleId];
    const articleLastRead = article.article.latestCommentTimestamp;

    if (!localLastRead && !articleLastRead) return true;

    return dayjs(localLastRead).isSame(dayjs(articleLastRead), 'second');
  }, [contentCommentReadState, article.article.latestCommentTimestamp, article.article.articleId]);

  const gatedState = useAsyncMemo(async () => {
    if (('communityArticle' in article)) {
      return calculatePermissions(article);
    }
    return null;
  }, [article]);
  // (if community article)
  const community = useCommunityListView('communityArticle' in article ? article.communityArticle.communityId : undefined);

  // (if user article)
  const authorId = article.article.creatorId;
  const author = useUserData(authorId);

  const exclusiveState = useAsyncMemo(async () => {
    if ('communityArticle' in article) {
      return isArticleGated(article.communityArticle);
    }
    return null;
  }, [article]);

  const isScheduled = dayjs(cardDate).isAfter(dayjs());
  let isDraftOrScheduled = false;
  if ('communityArticle' in article) {
    isDraftOrScheduled = !article.communityArticle.published || dayjs(cardDate).isAfter(dayjs());
  } else {
    isDraftOrScheduled = !article.userArticle.published || dayjs(cardDate).isAfter(dayjs());
  }

  const cardImgSrc = useSignedUrl(article.article.headerImageId);
  const cardDateText = useMemo(() => {
    if (!cardDateString) return 'Unpublished';
    return calculateArticleAgeString(cardDate);
  }, [cardDate, cardDateString]);

  const recentUnread = useMemo(() => isRecentUnread(cardDate, isDraftOrScheduled, isRead), [cardDate, isDraftOrScheduled, isRead]);

  const onCardClick = React.useCallback(() => {
    if (gatedState) {
      setShowGatedDialog(true);
    } else if (('communityArticle' in article) && community) {
      if (isDraftOrScheduled) {
        navigate({
          pathname: getUrl({ type: 'community-article-edit', article: article.article, community }),
          search: createSearchParams({
            draft: 'true'
          }).toString()
        });
      } else {
        showTooltip({
          type: 'article',
          articleId: article.article.articleId,
          communityId: community.id
        });
        // navigate(getUrl({ type: 'community-article', article: article.article, community }));
      }
    } else if (('userArticle' in article) && author) {
      if (isDraftOrScheduled) {
        navigate({
          pathname: getUrl({ type: 'user-article-edit', article: article.article, user: author }),
          search: createSearchParams({
            draft: 'true'
          }).toString()
        });
      } else {
        showTooltip({
          type: 'user-article',
          articleId: article.article.articleId,
          userId: authorId
        });
        // navigate(getUrl({ type: 'community-article', article: article.article, community }));
      }
    }
  }, [article, author, authorId, community, gatedState, isDraftOrScheduled, navigate, showTooltip]);

  useEffect(() => {
    const listener: ResizeObserverCallback = async ([entry]) => {
      if (entry) {
        const width = entry.contentRect.width;
        const useSmallMode = width < MINIMUM_COLLAPSED_WIDTH;
        setSmallMode(useSmallMode);
      }
    }

    const observer = new ResizeObserver(listener);
    if (articleCardRef.current) {
      observer.observe(articleCardRef.current);
    }

    return () => observer.disconnect();
  }, []);

  return (<>
    <div className={`article-card-v3 cursor-pointer flex gap-4${isMobile || isSmallMode ? ' collapsed' : ''}`} ref={articleCardRef} onClick={onCardClick}>
      <div className="relative">
        {cardImgSrc && <img loading='lazy' className={`article-card-v3-image`} src={cardImgSrc} alt='Event' />}
        {!cardImgSrc && <div className={`article-card-v3-image no-image`}>
          <img className='w-10 h-10' src={ArticleClayIcon} alt={'Article'} />
        </div>}
        {recentUnread && <NotificationDot className="absolute top-0 right-0" />}
      </div>
      <div className='flex flex-col gap-4 flex-1'>
        <div className='flex flex-col gap-1'>
          <div className='flex flex-col gap-2'>
            <span className='cg-heading-3 cg-text-main'>{article.article.title}</span>
          </div>
          {!!article.article.previewText && <div className='article-card-v3-description cg-text-md-400 cg-text-secondary'>
            {article.article.previewText}
          </div>}
        </div>
        <div className="flex items-center gap-1 cg-text-md-400 cg-text-secondary flex-wrap">
          {isDraftOrScheduled && <>
            {isScheduled ? 
              <span className='cg-text-success cg-text-md-500'>Scheduled</span> :
              <span className='cg-text-warning cg-text-md-500'>Draft</span>
            }
            <span className='cg-text-lg-400 cg-text-secondary'>·</span>
          </>}
          
          {!hideAuthor && community && <>
            <div className='flex items-center gap-1 cg-text-md-400 cg-text-secondary'>
              <CommunityPhoto community={community} size='tiny-20' noHover />
              {getCommunityDisplayName(community)}
            </div>
            <span className='cg-text-lg-400 cg-text-secondary'>·</span>
          </>}

          {!hideAuthor && author && <div className="flex gap-1">
            <Jdenticon
              userId={authorId}
              predefinedSize="20"
              hideStatus
            />
            {getDisplayName(author)}
          </div>}
          
          {!hideAuthor && <span className='cg-text-lg-400 cg-text-secondary'>·</span>}

          <span className="whitespace-nowrap">{cardDateText}</span>

          {!!exclusiveState && <>
            <span className='cg-text-lg-400 cg-text-secondary'>·</span>
            <ArticleExclusiveTooltip gatedState={exclusiveState} />
          </>}

          <span className='cg-text-lg-400 cg-text-secondary'>·</span>
          <div className={`flex items-center gap-1${!isLastCommentRead ? ' cg-text-main' : ''}`}>
            <span>{article.article.commentCount > 10 ? '10+' : article.article.commentCount}</span>
            <Chat weight="duotone" className="w-5 h-5"/>
          </div>
        </div>
      </div>
    </div>
    {gatedState && <GatedDialogModal
      requiredPermissions={gatedState}
      isOpen={showGatedDialog}
      onClose={(redirect) => {
        setShowGatedDialog(false);
        if (redirect && community) {
          navigate(getUrl({ type: 'community-article', article: article.article, community }));
        }
      }}
    />}
  </>);

  // return (<>
  //   <div
  //     className={className}
  //     onClick={onCardClick}
  //   >
  //     {isDraft && <span className='draft-tag'>Draft</span>}
  //     {isEditable && (
  //       <Button
  //         iconLeft={<EditIcon className="edit-icon" />}
  //         onClick={onEditClick}
  //         role="primary"
  //         className="absolute top-4 right-4 edit-content-btn"
  //       />
  //     )}
  //     <div className="article-card-v2-top-content">
  //       <div className="article-card-v2-text">
  //         <div className="flex flex-col gap-2">
  //           {!hideAuthor && <div className="article-card-v2-article-owner">
  //             {owner}
  //           </div>}
  //           <div className="article-card-v2-article-title">
  //             {article.article.title}
  //           </div>
  //         </div>
  //         <div className="article-card-v2-article-excerpt">
  //           {article.article.previewText}
  //         </div>
  //         {!isMobile && footer}
  //       </div>
  //       <div className="article-card-v2-image-container">
  //         <div className="article-card-v2-image" style={{ backgroundImage: `url(${cardImgSrc})` }} />
  //       </div>
  //     </div>
  //     {isMobile && footer}
  //     {recentUnread && <NotificationDot />}
  //   </div>
  //   {gatedState && <GatedDialogModal
  //     requiredPermissions={gatedState}
  //     isOpen={showGatedDialog}
  //     onClose={(redirect) => {
  //       setShowGatedDialog(false);
  //       if (redirect && community) {
  //         navigate(getUrl({ type: 'community-article', article: article.article, community }));
  //       }
  //     }}
  //   />}
  // </>);
}
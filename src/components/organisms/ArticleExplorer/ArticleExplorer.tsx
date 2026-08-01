// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useMemo, useState, useEffect, useReducer, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import Button from "../../atoms/Button/Button";
import ContentSlider from '../../molecules/ContentSlider/ContentSlider';
import FrontPageSectionHeader from '../../molecules/FrontPageSectionHeader/FrontPageSectionHeader';

import {
  communityHomeReducer,
  fetchFrontpageContent,
  loadMoreContent,
  fetchCommunityContent,
  getInitialStateTryCache,
} from '../../templates/CommunityLobby/CommunityHome/CommunityContent.reducer';
import { isRecentUnread } from 'components/molecules/ArticleCardV2/ArticleCardV2.helper';
import useLocalStorage, { ReadArticlesState } from 'hooks/useLocalStorage';
import dayjs from 'dayjs';

import './ArticleExplorer.css';
import { getUrl } from 'common/util';
import { useConnectionContext } from 'context/ConnectionProvider';
import { RectangleStackIcon } from '@heroicons/react/20/solid';
import { Spinner } from '@phosphor-icons/react';
import _ from 'lodash';

type Props = {
  mode: 'limited' | 'unlimited';
  loadingAmount?: number;
  onFinishedLoading?: () => void;
  communityData?: {
    community: Readonly<Models.Community.DetailView>;
    communityPermissions: Readonly<Set<Common.CommunityPermission>>;
  };
  hideEndButton?: boolean;
  emptyState?: JSX.Element;
  showCount?: boolean;
  useLargeHeader?: boolean;
  hideHeader?: boolean;
  tags?: string[];
  followingOnly?: boolean;
  hideOnEmpty?: boolean;
}

type ArticleOption = {
  value: string;
  text: string;
};

const commonOptions: ArticleOption[] = [
  {
    value: 'all',
    text: 'All'
  },
  // {
  //   value: 'announcement',
  //   text: 'Announcements'
  // },
  // {
  //   value: 'article',
  //   text: 'Articles'
  // },
  // {
  //   value: 'guide',
  //   text: 'Guides'
  // }
];

const adminOptions: ArticleOption[] = [
  {
    value: 'draft',
    text: 'Drafts'
  }
];

const ArticleExplorer: React.FC<Props> = (props) => {
  const { mode, loadingAmount, onFinishedLoading, communityData, hideEndButton, emptyState, showCount, useLargeHeader, hideHeader, tags } = props;
  const isLimitedMode = mode === 'limited';
  const navigate = useNavigate();
  const [activeContentFilter, setActiveContentFilter] = useState<"all" | "draft">("all");

  // empty string is used since CommunityHomeDataState has communityId: "",
  // which is then automatically used for the cache entry
  const [dataState, dispatch] = useReducer(communityHomeReducer, getInitialStateTryCache(communityData?.community.id || ""));

  const [contentReadState,] = useLocalStorage<ReadArticlesState>({}, 'content-read-state');
  const dataStateState = activeContentFilter === 'draft' ? dataState.draftState : dataState.state;
  const endOfListRef = useRef<HTMLDivElement>(null);
  const communityIdRef = useRef<string | undefined>();
  const tagsRef = useRef<string[] | undefined>();
  const followingRef = useRef<boolean | undefined>();
  const { loginState } = useConnectionContext();
  const lastLoginStateRef = useRef<Common.LoginState>(loginState);
  const fetchTimeoutRef = useRef<any>();

  const isEditor = useMemo(() => {
    return communityData?.communityPermissions.has('COMMUNITY_MANAGE_ARTICLES') || false;
  }, [communityData]);

  const MAX_CONTENT = useMemo((): number | undefined => {
    if (isLimitedMode) {
      return 12;
    }
    return undefined;
  }, [isLimitedMode]);

  const fetchContent = useCallback(() => {
    if (fetchTimeoutRef.current) {
      clearTimeout(fetchTimeoutRef.current);
    }
    if (communityIdRef.current) {
      fetchCommunityContent(communityIdRef.current, isEditor, dispatch, (MAX_CONTENT || 20) + 1);
    } else {
      fetchFrontpageContent(dispatch, (MAX_CONTENT || 20) + 1, tags, props.followingOnly || false);
    }
  }, [isEditor, MAX_CONTENT, tags, props.followingOnly]);

  // initial load
  useEffect(() => {
    if (
      dataStateState === 'INITIALIZING' ||
      dataStateState === 'FROM_CACHE' ||
      (communityIdRef.current !== communityData?.community.id) ||
      (!_.isEqual(tagsRef.current, tags)) ||
      (followingRef.current !== props.followingOnly)
    ) {
      communityIdRef.current = communityData?.community.id;
      followingRef.current = props.followingOnly;
      tagsRef.current = tags;
      if (!communityIdRef.current) dispatch({ type: 'ResetFrontpage' });
      fetchContent();
    }
  }, [communityData?.community.id, dataStateState, fetchContent, props.followingOnly, tags]);

  useEffect(() => {
    if (
      (lastLoginStateRef.current === "loggingin" && loginState === "loggedin") ||
      (lastLoginStateRef.current === "loggingout" && loginState === "anonymous")
    ) {
      // if isEditor changes too, this will be cleared
      fetchTimeoutRef.current = setTimeout(() => {
        fetchTimeoutRef.current = undefined;
        fetchContent();
      }, 300);
    }
    lastLoginStateRef.current = loginState;
  }, [fetchContent, loginState]);

  const endOfListObserver = useMemo(() => {
    return new IntersectionObserver((results) => {
      for (const element of results) {
        const isIdle = dataStateState === 'IDLE';
        if (element.isIntersecting && isIdle) {
          loadMoreContent(
            activeContentFilter,
            dataState,
            dispatch,
            onFinishedLoading,
            {
              communityId: communityData?.community.id,
              tags: !!communityIdRef.current ? tags : undefined,
              anyTags: !!communityIdRef.current ? undefined : tags,
              following: props.followingOnly || false
            }
          );
        }
      }
    });
  }, [dataStateState, activeContentFilter, dataState, onFinishedLoading, communityData?.community.id, tags, props.followingOnly]);

  useEffect(() => {
    if (endOfListRef.current) {
      endOfListObserver.observe(endOfListRef.current);
    }

    return () => {
      endOfListObserver.disconnect();
    }
  }, [endOfListObserver]);

  const contentSliderItems = React.useMemo(() => {
    if (activeContentFilter === 'draft') {
      return dataState.drafts;
    } else if (activeContentFilter === 'all') {
      return dataState.content;
    } else {
      return dataState.content.filter(article => article.article.tags?.[0] === activeContentFilter);
    }
  }, [activeContentFilter, dataState.content, dataState.drafts]);

  const [contentSliderCounts, contentSliderUnread] = React.useMemo(() => {
    const tags = ['announcement', 'article', 'guide'];
    const count: Record<string, number> = {};
    const hasUnread: Record<string, boolean> = {};
    for (const tag of tags) {
      count[tag] = 0;
      hasUnread[tag] = false;
      for (const article of dataState.content) {
        if (article.article.tags?.includes(tag)) {
          count[tag] += 1;
          hasUnread[tag] = hasUnread[tag] || isRecentUnread(dayjs(article.communityArticle.published), false, contentReadState[article.article.articleId]);
        }
      }
    }
    count['all'] = dataState.content.length;
    count['draft'] = dataState.drafts.length;
    hasUnread['all'] = Object.values(hasUnread).some(unread => unread);

    return [count, hasUnread];
  }, [contentReadState, dataState.content, dataState.drafts.length]);

  const title = React.useMemo(() => {
    const isDraftsActive = activeContentFilter === 'draft';
    const draftCount = contentSliderCounts['draft'];

    return <div className='flex py-2 justify-between items-center self-stretch'>
      <div className='flex items-center gap-2 p-2 cg-text-main'>
        <RectangleStackIcon className='w-5 h-5' />
        <h3 className='cg-heading-3'>Posts</h3>
      </div>
      {isEditor && draftCount > 0 && <Button
        role='chip'
        text={`${draftCount} Draft${draftCount !== 1 ? 's' : ''}`}
        onClick={() => setActiveContentFilter(isDraftsActive ? 'all' : 'draft')}
        className={`${isDraftsActive ? ' active' : undefined}`}
      />}
    </div>;


    // let options = commonOptions;
    // if (communityData && communityData.communityPermissions.has("COMMUNITY_MANAGE_ARTICLES")) { options = commonOptions.concat(adminOptions); }

    // return <div className='article-explorer-title'>
    //   <span className='article-explorer-title-text cg-heading-3'>Community news</span>
    //   <div className='article-explorer-btnFilter-container'>
    //     {isMobile && <div className='pr-2' />}
    //     {/* Only show if there's more than one option */}
    //     {options.length > 1 && options.map(opt => {
    //       let dataLength = contentSliderCounts[opt.value] || 0;
    //       let unread = contentSliderUnread[opt.value] || false;

    //       const buttonText = showCount ? <span className='flex flex-row gap-1'>{opt.text}<span className='btnFilter-data-length'>{dataLength}</span></span> : opt.text;
    //       return <div className='explorer-btnFilter-container' key={opt.text}>
    //         <Button
    //           role='chip'
    //           text={buttonText}
    //           onClick={() => setActiveContentFilter(opt.value)}
    //           className={`${opt.value === activeContentFilter ? ' active' : undefined}`}
    //         />
    //         {unread && <NotificationDot />}
    //       </div>
    //     })}
    //   </div>
    // </div>
  }, [activeContentFilter, isEditor, contentSliderCounts]);

  if (props.hideOnEmpty && dataState.content.length === 0 && dataState.drafts.length === 0) return null;

  return (
    <div className='article-explorer-container'>
      {!hideHeader && <FrontPageSectionHeader
        sectionTitle={title}
        useLargeHeader={useLargeHeader}
      />}
      <ContentSlider
        items={contentSliderItems}
        cardCountLimit={MAX_CONTENT}
        loadingAmount={loadingAmount}
        isLoading={dataStateState === 'LOADING'}
        onViewAllClick={() => navigate(getUrl({ type: 'feed' }))}
        emptyState={emptyState}
        hideAuthors={!!communityData} // Hide authors when community is given
      />
      <div ref={endOfListRef} />
      {dataStateState === 'LOADING' && <Spinner className="spinner" />}
    </div>
  );
}

export default React.memo(ArticleExplorer);

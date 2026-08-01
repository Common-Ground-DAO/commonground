// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect, useMemo, useReducer, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import Button from '../../../components/atoms/Button/Button';
import FrontPageSectionHeader from '../../../components/molecules/FrontPageSectionHeader/FrontPageSectionHeader';
import ContentSlider from 'components/molecules/ContentSlider/ContentSlider';

import { blogsReducer, fetchFrontpageContent, initialState, loadMoreContent } from "./Blogs.reducer";
import { useWindowSizeContext } from 'context/WindowSizeProvider';

import './BlogExplorer.css';
import { getUrl } from 'common/util';

type Props = {
  mode: 'limited' | 'unlimited';
  loadingAmount?: number;
  loadMore?: boolean;
  onFinishedLoading?: () => void;
  gridOnMobile?: boolean;
}

type BlogType = 'blog' | 'following' | 'draft'

type BlogOption = {
  value: BlogType;
  text: string;
}

const options: BlogOption[] = [
  { value: 'blog', text: 'All' },
  { value: 'following', text: 'By people you follow' },
]

const BlogExplorer: React.FC<Props> = ({ mode, loadingAmount, loadMore, onFinishedLoading, gridOnMobile }) => {
  const isLimitedMode = mode === 'limited';
  const navigate = useNavigate();
  const [ dataState, dispatch ] = useReducer(blogsReducer, initialState);
  const [ activeContentFilter, setActiveContentFilter ] = useState<BlogType>("blog");
  const { isMobile } = useWindowSizeContext();
  
  const currentDataState = useMemo(() => {
    if (activeContentFilter === 'blog') return dataState.state;
    else if (activeContentFilter === 'draft') return dataState.draftState;
    else if (activeContentFilter === 'following') return dataState.followingState;
  }, [activeContentFilter, dataState.draftState, dataState.followingState, dataState.state])

  const MAX_CONTENT = useMemo((): number | undefined => {
    if (isLimitedMode) {
      return 6;
    }
    return undefined;
  }, [isLimitedMode]);

  // initial load
  useEffect(() => {
    fetchFrontpageContent(dispatch, (MAX_CONTENT || 20) + 1);
  }, [MAX_CONTENT]);

  useEffect(() => {
    if (!isLimitedMode && loadMore && currentDataState === 'IDLE') {
      loadMoreContent(activeContentFilter, dataState, dispatch, onFinishedLoading);
    }
  }, [isLimitedMode, activeContentFilter, loadMore, dataState, onFinishedLoading, currentDataState]);

  const contentSliderItems: API.User.getArticleList.Response = React.useMemo(() => {
    switch (activeContentFilter) {
      case 'draft':
        return dataState.drafts;
      case 'blog':
        return dataState.blogs;
      case 'following':
        return dataState.followings;
      default:
        return [];
    }
  }, [activeContentFilter, dataState.drafts, dataState.blogs, dataState.followings]);

  const title = React.useMemo(() => {
    return <div className='blog-explorer-title'>
      <span className='blog-explorer-title-text'>People's blog</span>
      <div className='blog-explorer-btnFilter-container'>
        {isMobile && <div className='pr-2' />}
        {options.map(opt => <Button 
          role='secondary'
          text={opt.text}
          key={opt.text}
          onClick={() => setActiveContentFilter(opt.value)}
          className={`blog-explorer-btnFilter ${opt.value === activeContentFilter ? ' active' : undefined}`}
        />)}
      </div>
    </div>
  }, [activeContentFilter, isMobile]);

  return (
    <div className='blog-explorer-container'>
      <FrontPageSectionHeader
        sectionTitle={title}
      />
      <ContentSlider
        items={contentSliderItems}
        cardCountLimit={MAX_CONTENT}
        loadingAmount={loadingAmount}
        isLoading={currentDataState === 'LOADING'}
        onViewAllClick={() => console.warn('User articles are disabled for now')}
      />
      {!isLimitedMode && currentDataState === 'DONE' && <div className='cta-buttons'>
        <Button role='secondary' text='Home' onClick={() => navigate(getUrl({type: 'home'}))} />
      </div>}
    </div>
  );
}

export default React.memo(BlogExplorer);

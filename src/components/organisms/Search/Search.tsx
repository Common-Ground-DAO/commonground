// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useMultipleUserData } from 'context/UserDataProvider';
import communityApi from 'data/api/community';
import searchApi from 'data/api/search';
import React, { useEffect, useMemo } from 'react';
import { STARTING_LIMIT, useSearchReducer } from './SearchReducer';
import UserTooltip from "components/organisms/UserTooltip/UserTooltip";
import Jdenticon from 'components/atoms/Jdenticon/Jdenticon';
import { getDisplayName } from '../../../util';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import LargeCommunityCard from 'components/molecules/CommunityCard/LargeCommunityCard';
import { Spinner, X } from '@phosphor-icons/react';
import Button from 'components/atoms/Button/Button';
import ExternalIcon from 'components/atoms/ExternalIcon/ExternalIcon';
import { useSentinelLoadMore } from 'hooks/useSentinelLoadMore';
import CheckboxBase from 'components/atoms/CheckboxBase/CheckboxBase';
import pluginsApi from 'data/api/plugins';
import PluginCard from '../PluginAppstore/PluginCard';
import ArticleCard from 'components/molecules/ArticleCardV2/ArticleCardV2';
import { PredefinedTag } from 'components/molecules/inputs/TagInputField/predefinedTags';
import Tag, { TagIcon } from 'components/atoms/Tag/Tag';
import BotBadge from 'components/atoms/BotBadge/BotBadge';

type Props = {
  search: string;
  tags: PredefinedTag[];
  setTags: (tags: PredefinedTag[]) => void;
}

const userFetcher = async (search: string, tags: string[], offset: number, limit: number = 10): Promise<API.Search.searchUsers.Response> => {
  return await searchApi.searchUsers({
    query: search || null,
    limit,
    offset,
    tags
  });
}

function getBotOwnerLabel(owner: Models.User.BotOwnerSummary | null | undefined) {
  if (owner?.type === 'user') return `Owned by @${owner.username}`;
  if (owner?.type === 'community') return `Owned by ${owner.title}`;
  if (owner?.type === 'platform') return 'Platform bot';
  return undefined;
}

const communityFetcher = async (search: string, tags: string[], offset: number, limit: number = 10): Promise<API.Community.getCommunityList.Response> => {
  return await communityApi.getCommunityList({
    search: search || undefined,
    limit,
    offset,
    sort: "popular",
    tags
  });
}

const articleFetcher = async (search: string, tags: string[], offset: number, limit: number = 10): Promise<API.Search.searchArticles.Response> => {
  return await searchApi.searchArticles({
    type: 'all',
    query: search || null,
    limit,
    offset,
    tags
  });
}

const appFetcher = async (search: string, tags: string[], offset: number, limit: number = 10): Promise<API.Plugins.getAppstorePlugins.Response['plugins']> => {
  const response = await pluginsApi.getAppstorePlugins({
    query: search || undefined,
    limit,
    offset,
    tags
  });
  return response.plugins;
}

const Search: React.FC<Props> = (props) => {
  const { search, tags, setTags } = props;
  const { isMobile } = useWindowSizeContext();
  const [userEnabled, setUserEnabled] = React.useState(true);
  const [communityEnabled, setCommunityEnabled] = React.useState(true);
  const [articleEnabled, setArticleEnabled] = React.useState(true);
  const [appEnabled, setAppEnabled] = React.useState(true);

  const [userSearchState, userSearch, userLoadMore] = useSearchReducer<API.Search.searchUsers.Response[number]>(userFetcher);
  const [communitySearchState, communitySearch, communityLoadMore] = useSearchReducer<API.Community.getCommunityList.Response[number]>(communityFetcher);
  const [articleSearchState, articleSearch, articleLoadMore] = useSearchReducer<API.Search.searchArticles.Response[number]>(articleFetcher);
  const [appSearchState, appSearch, appLoadMore] = useSearchReducer<API.Plugins.getAppstorePlugins.Response['plugins'][number]>(appFetcher);

  const [userLoadingMore, setUserLoadingMore] = React.useState(false);
  const userHeaderRef = React.useRef<HTMLHeadingElement>(null);
  const userSentinelRef = React.useRef<HTMLDivElement>(null);
  const [communityLoadingMore, setCommunityLoadingMore] = React.useState(false);
  const communityHeaderRef = React.useRef<HTMLHeadingElement>(null);
  const communitySentinelRef = React.useRef<HTMLDivElement>(null);
  const [articleLoadingMore, setArticleLoadingMore] = React.useState(false);
  const articleHeaderRef = React.useRef<HTMLHeadingElement>(null);
  const articleSentinelRef = React.useRef<HTMLDivElement>(null);
  const [appLoadingMore, setAppLoadingMore] = React.useState(false);
  const appHeaderRef = React.useRef<HTMLHeadingElement>(null);
  const appSentinelRef = React.useRef<HTMLDivElement>(null);

  const tagsString = useMemo(() => {
    return tags.map(tag => tag.name);
  }, [tags]);

  useEffect(() => {
    if (search.length >= 2 || tagsString.length > 0) {
      if (userEnabled) userSearch(search, tagsString);
      setUserLoadingMore(false);
    }
  }, [search, tags, tagsString, userEnabled, userSearch]);

  useEffect(() => {
    if (search.length >= 2 || tagsString.length > 0) {
      if (communityEnabled) communitySearch(search, tagsString);
      setCommunityLoadingMore(false);
    }
  }, [search, communityEnabled, communitySearch, tagsString]);

  useEffect(() => {
    if (search.length >= 2 || tagsString.length > 0) {
      if (articleEnabled) articleSearch(search, tagsString);
      setArticleLoadingMore(false);
    }
  }, [search, articleEnabled, articleSearch, tagsString]);

  useEffect(() => {
    if (search.length >= 2 || tagsString.length > 0) {
      if (appEnabled) appSearch(search, tagsString);
      setAppLoadingMore(false);
    }
  }, [search, appEnabled, appSearch, tagsString]);

  useSentinelLoadMore(userSentinelRef, userLoadingMore, userLoadMore);
  useSentinelLoadMore(communitySentinelRef, communityLoadingMore, communityLoadMore);
  useSentinelLoadMore(articleSentinelRef, articleLoadingMore, articleLoadMore);
  useSentinelLoadMore(appSentinelRef, appLoadingMore, appLoadMore);

  const userIds = useMemo(() => {
    return userSearchState.items.map(user => user.id) || [];
  }, [userSearchState.items]);

  const userData = useMultipleUserData(userIds);

  let loadingAndEmptyContent: React.JSX.Element | null = null;

  if (userSearchState.status === 'loading' && communitySearchState.status === 'loading' && articleSearchState.status === 'loading' && appSearchState.status === 'loading') {
    loadingAndEmptyContent = <div className="flex items-center cg-text-main justify-center">
      <Spinner className='spinner' />
    </div>;
  } else if (search.length < 2 && tags.length === 0) {
    loadingAndEmptyContent = <div className={`flex items-center justify-center cg-text-secondary p-8 cg-bg-subtle cg-border-xxl ${isMobile ? 'px-4' : ''}`}>
      <h3>Type anything to start your search</h3>
    </div>;
  } else if (userSearchState.items.length === 0 && communitySearchState.items.length === 0 && articleSearchState.items.length === 0 && appSearchState.items.length === 0) {
    loadingAndEmptyContent = <div className={`flex items-center justify-center cg-text-secondary p-8 cg-bg-subtle cg-border-xxl ${isMobile ? 'px-4' : ''}`}>
      {search.length < 2 && tags.length === 0 && <h3>Type anything to start your search</h3>}
      {(search.length >= 2 || tags.length > 0) && <h3>No results found</h3>}  
    </div>;
  }

  const renderUsers = () => {
    if (!userEnabled || userSearchState.items.length === 0) {
      return null;
    }

    return <div className="flex flex-col gap-4 w-full">
      <h2 ref={userHeaderRef}>Users</h2>
      {userIds.length > 0 && <div className="grid grid-cols-3 gap-x-2 gap-y-4">
        {userSearchState.items.map(user => <UserTooltip
          key={user.id}
          userId={user.id}
          isMessageTooltip={false}
          triggerClassName="cursor-pointer"
        >
          <div className="flex flex-col gap-2 items-center justify-center cg-text-lg-500">
            <Jdenticon
              userId={user.id}
              hideStatus
              predefinedSize="80"
              floatingBorder
            />
            {userData[user.id] && <>
              <div className='flex items-center gap-1'>
                {userData[user.id].isBot ? '@' : ''}{getDisplayName(userData[user.id])}
                {userData[user.id].isBot && <BotBadge />}
              </div>
              {userData[user.id].isBot && getBotOwnerLabel(userData[user.id].botOwner) &&
                <span className='cg-text-sm-400 cg-text-secondary'>
                  {getBotOwnerLabel(userData[user.id].botOwner)}
                </span>}
            </>}
            {userData[user.id] && <div className="flex flex-col gap-1 cg-bg-subtle p-2 cg-border-l">
              {user.matchedAccountTypes && user.matchedAccountTypes.map((accountType, index) => {
                return <div key={index} className={`flex gap-1 cg-text-sm-500`}>
                  {accountType === 'cg' && <ExternalIcon type={accountType} className='w-4 h-4' />}
                  {getDisplayName(userData[user.id], false, accountType)}
                </div>;
              })}
              {!user.matchedAccountTypes && <div className="flex gap-1 cg-text-sm-500">
                <ExternalIcon type={userData[user.id].displayAccount} className='w-4 h-4' />
                {getDisplayName(userData[user.id], false)}
              </div>}
            </div>}
          </div>
        </UserTooltip>
        )}
      </div>}
      {userSearchState.status === 'loading' && <div className="flex items-center justify-center">
        <Spinner className='spinner' />
      </div>}
      <div className='flex items-center justify-center'>
        {!userLoadingMore && userSearchState.items.length >= STARTING_LIMIT && <Button
          role='secondary'
          text='Load more'
          onClick={() => setUserLoadingMore(true)}
        />}
        {!!userLoadingMore && userSearchState.status === 'done' && <div className="p-2 flex cg-text-secondary items-center justify-center">
          <p className='cg-text-md-500'>End of user results</p>
        </div>}
        {userSearchState.items.length === 0 && <div className="flex items-center justify-center cg-text-secondary p-8 cg-bg-subtle cg-border-xxl">
          {<h3>No results found</h3>}
        </div>}
        {userLoadingMore && <div ref={userSentinelRef} />}
      </div>
    </div>;
  }

  const renderCommunities = () => {
    if (!communityEnabled || communitySearchState.items.length === 0) {
      return null;
    }

    return <div className="flex flex-col gap-4 w-full">
      <h2 ref={communityHeaderRef}>Communities</h2>
      {communitySearchState.items.length > 0 && <div className={`grid ${isMobile ? 'grid-cols-1 gap-4' : 'grid-cols-2 gap-2'}`}>
        {communitySearchState.items.map(community => <LargeCommunityCard
          key={community.id}
          community={community}
        />)}
      </div>}
      {communitySearchState.status === 'loading' && <div className="flex items-center justify-center">
        <Spinner className='spinner' />
      </div>}
      <div className='flex items-center justify-center'>
        {!communityLoadingMore && communitySearchState.items.length >= STARTING_LIMIT && <Button
          role='secondary'
          text='Load more'
          onClick={() => setCommunityLoadingMore(true)}
        />}
        {!!communityLoadingMore && communitySearchState.status === 'done' && <div className="p-2 flex cg-text-secondary items-center justify-center">
          <p className='cg-text-md-500'>End of community results</p>
        </div>}
        {communitySearchState.items.length === 0 && <div className="flex items-center justify-center cg-text-secondary p-8 cg-bg-subtle cg-border-xxl">
          {<h3>No results found</h3>}
        </div>}
        {communityLoadingMore && <div ref={communitySentinelRef} />}
      </div>
    </div>;
  }

  const renderArticles = () => {
    if (!articleEnabled || articleSearchState.items.length === 0) {
      return null;
    }

    return <div className="flex flex-col gap-4 w-full">
      <h2 ref={articleHeaderRef}>Articles</h2>
      {articleSearchState.items.length > 0 && <div className={`grid ${isMobile ? 'grid-cols-1 gap-4' : 'grid-cols-1 gap-4'}`}>
        {articleSearchState.items.map(article => <ArticleCard
          key={article.article.articleId}
          article={article}
        />)}
      </div>}
      {articleSearchState.status === 'loading' && <div className="flex items-center justify-center">
        <Spinner className='spinner' />
      </div>}
      <div className='flex items-center justify-center'>
        {!articleLoadingMore && articleSearchState.items.length >= STARTING_LIMIT && <Button
          role='secondary'
          text='Load more'
          onClick={() => setArticleLoadingMore(true)}
        />}
        {!!articleLoadingMore && articleSearchState.status === 'done' && <div className="p-2 flex cg-text-secondary items-center justify-center">
          <p className='cg-text-md-500'>End of article results</p>
        </div>}
        {articleSearchState.items.length === 0 && <div className="flex items-center justify-center cg-text-secondary p-8 cg-bg-subtle cg-border-xxl">
          {<h3>No results found</h3>}
        </div>}
        {articleLoadingMore && <div ref={articleSentinelRef} />}
      </div>
    </div>;
  }

  const renderApps = () => {
    if (!appEnabled || appSearchState.items.length === 0) {
      return null;
    }

    return <div className="flex flex-col gap-4 w-full">
      <h2 ref={appHeaderRef}>Apps</h2>
      {appSearchState.items.length > 0 && <div className={`grid ${isMobile ? 'grid-cols-1 gap-4' : 'grid-cols-2 gap-2'}`}>
        {appSearchState.items.map(app => <PluginCard
          key={app.pluginId}
          {...app}
        />)}
      </div>}
      {appSearchState.status === 'loading' && <div className="flex items-center justify-center">
        <Spinner className='spinner' />
      </div>}
      <div className='flex items-center justify-center'>
        {!appLoadingMore && appSearchState.items.length >= STARTING_LIMIT && <Button
          role='secondary'
          text='Load more'
          onClick={() => setAppLoadingMore(true)}
        />}
        {!!appLoadingMore && appSearchState.status === 'done' && <div className="p-2 flex cg-text-secondary items-center justify-center">
          <p className='cg-text-md-500'>End of app results</p>
        </div>}
        {appSearchState.items.length === 0 && <div className="flex items-center justify-center cg-text-secondary p-8 cg-bg-subtle cg-border-xxl">
          {<h3>No results found</h3>}
        </div>}
        {appLoadingMore && <div ref={appSentinelRef} />}
      </div>
    </div>;
  }

  return <div className={`flex flex-col gap-4 w-full cg-text-main ${isMobile ? 'px-4' : ''}`}>
    <div className='flex items-center gap-2'>
      <Button
        role='secondary'
        text='Users'
        className='gap-2'
        iconLeft={<div onClick={ev => ev.stopPropagation()}><CheckboxBase
          type='checkbox'
          size='normal'
          checked={userEnabled}
          setChecked={setUserEnabled}
        /></div>}
        onClick={() => {
          userHeaderRef.current?.scrollIntoView({ behavior: 'smooth' });
        }}
      />
      <Button
        role='secondary'
        text='Communities'
        className='gap-2'
        iconLeft={<div onClick={ev => ev.stopPropagation()}><CheckboxBase
          type='checkbox'
          size='normal'
          checked={communityEnabled}
          setChecked={setCommunityEnabled}
        /></div>}
        onClick={() => {
          communityHeaderRef.current?.scrollIntoView({ behavior: 'smooth' });
        }}
      />
      <Button
        role='secondary'
        text='Articles'
        className='gap-2'
        iconLeft={<div onClick={ev => ev.stopPropagation()}><CheckboxBase
          type='checkbox'
          size='normal'
          checked={articleEnabled}
          setChecked={setArticleEnabled}
        /></div>}
        onClick={() => {
          articleHeaderRef.current?.scrollIntoView({ behavior: 'smooth' });
        }}
      />
      <Button
        role='secondary'
        text='Apps'
        className='gap-2'
        iconLeft={<div onClick={ev => ev.stopPropagation()}><CheckboxBase
          type='checkbox'
          size='normal'
          checked={appEnabled}
          setChecked={setAppEnabled}
        /></div>}
        onClick={() => {
          appHeaderRef.current?.scrollIntoView({ behavior: 'smooth' });
        }}
      />
    </div>
    <div className='flex flex-wrap gap-2'>
      {tags.map(tag => (<Tag
        variant='tag'
        iconRight={<X className='w-4 h-4 cg-text-secondary' />}
        iconLeft={<TagIcon tag={tag} />}
        className='cursor-pointer'
        key={tag.name}
        label={tag.name}
        onClick={() => setTags(tags.filter(t => t.name !== tag.name))} // Remove tag on click
      />))}
    </div>
    {!!loadingAndEmptyContent ? loadingAndEmptyContent : <div className='flex flex-col gap-8'>
      {renderUsers()}
      {renderCommunities()}
      {renderArticles()}
      {renderApps()}
    </div>}
  </div>;
}

export default React.memo(Search);

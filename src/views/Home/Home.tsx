// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './Home.css';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import Scrollable from "../../components/molecules/Scrollable/Scrollable";
import LiveCallExplorer from '../../components/organisms/LiveCallExplorer/LiveCallExplorer';
import { useWindowSizeContext } from '../../context/WindowSizeProvider';

import Button from '../../components/atoms/Button/Button';
import { isLocalUrl } from '../../components/atoms/SimpleLink/SimpleLink';

import LoginBanner from 'components/molecules/LoginBanner/LoginBanner';
import { useOwnUser } from 'context/OwnDataProvider';
import NotificationBanner from 'components/molecules/NotificationBanner/NotificationBanner';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RectangleStackIcon } from '@heroicons/react/24/solid';
import { ChevronDownIcon } from '@heroicons/react/20/solid';
import EventExplorer from 'components/organisms/EventExplorer/EventExplorer';
import ArticleExplorer from 'components/organisms/ArticleExplorer/ArticleExplorer';
import Tag from 'components/atoms/Tag/Tag';
import { Compass, HouseSimple, Storefront } from '@phosphor-icons/react';
import useLocalStorage from 'hooks/useLocalStorage';
import { getUrl } from 'common/util';
import { useEmailConfirmationContext } from 'context/EmailConfirmationProvider';
import userApi from 'data/api/user';
import { useUserOnboardingContext } from 'context/UserOnboarding';
import { removeInitialSlash } from 'App';
import CommunityExplorer from 'components/organisms/CommunityExplorer/CommunityExplorer';
import PluginAppstore from 'components/organisms/PluginAppstore/PluginAppstore';
import Search from 'components/organisms/Search/Search';
import TagHeader from 'components/organisms/TagHeader/TagHeader';
import { PredefinedTag } from 'components/molecules/inputs/TagInputField/predefinedTags';
import EmptyState from 'components/molecules/EmptyState/EmptyState';
import ScreenAwareDropdown from 'components/atoms/ScreenAwareDropdown/ScreenAwareDropdown';
import ListItem from 'components/atoms/ListItem/ListItem';
import SearchInputField from 'components/molecules/inputs/SearchInputField/SearchInputField';

const privacyPolicyLink = 'https://app.cg/c/commonground/article/privacy-policy-4vhHTcaUHQnDfmCDdQcNFf/';
const termsOfUseLink = 'https://app.cg/c/commonground/article/terms-of-use-tuVcsrBtEkM441vv3GdeM8/';
const helpLink = 'https://app.cg/c/commonground/article/help-13Pqw7xeDHRXnRoQWvwxhg/';

export default function Home() {
  const [search, _setSearch] = useState('');
  const [activeSearchTags, _setActiveSearchTags] = useState<PredefinedTag[]>([]);
  const { isMobile } = useWindowSizeContext();
  const navigate = useNavigate();
  const ownUser = useOwnUser();
  const emailConfirmation = useEmailConfirmationContext();
  const [emailConfirmationOpened, setEmailConfirmationOpened] = useLocalStorage('', 'emailConfirmation');
  const { isUserOnboardingVisible } = useUserOnboardingContext();
  const { pathname } = useLocation();

  useEffect(() => {
    if (emailConfirmationOpened === "opened") return;

    if (!ownUser || !!isUserOnboardingVisible) return;

    const { emailVerified, email } = ownUser;

    if (emailVerified) return;

    if (email) {
      userApi.requestEmailVerification({ email });
      emailConfirmation.openModal("pending");
    } else {
      emailConfirmation.openModal("signup");
    }

    setEmailConfirmationOpened("opened");
  }, [ownUser, emailConfirmationOpened, setEmailConfirmationOpened, emailConfirmation, isUserOnboardingVisible]);

  const openPrivacyPolicy = () => {
    const localExtract = isLocalUrl(privacyPolicyLink);
    if (localExtract) {
      navigate(localExtract);
    } else {
      if (isMobile) {
        window.open(privacyPolicyLink, 'infoTab', 'noopener');
      } else {
        window.open(privacyPolicyLink, '_blank', 'noopener');
      }
    }
  }

  const openHelp = () => {
    const localExtract = isLocalUrl(helpLink);
    if (localExtract) {
      navigate(localExtract);
    } else {
      if (isMobile) {
        window.open(helpLink, 'infoTab', 'noopener');
      } else {
        window.open(helpLink, '_blank', 'noopener');
      }
    }
  }

  const openTermsOfUse = () => {
    const localExtract = isLocalUrl(termsOfUseLink);
    if (localExtract) {
      navigate(localExtract);
    } else {
      if (isMobile) {
        window.open(termsOfUseLink, 'infoTab', 'noopener');
      } else {
        window.open(termsOfUseLink, '_blank', 'noopener');
      }
    }
  }

  const setSearch = useCallback((value: string) => {
    if (value.length >= 2 && pathname !== getUrl({ type: 'search' })) {
      navigate(getUrl({ type: 'search' }));
    }
    _setSearch(value);
  }, [navigate, pathname]);

  const setActiveSearchTags = useCallback((tags: PredefinedTag[]) => {
    if (tags.length > 0 && pathname !== getUrl({ type: 'search' })) {
      navigate(getUrl({ type: 'search' }));
    }
    _setActiveSearchTags(tags);
  }, [navigate, pathname]);

  return (
    <Scrollable
      hideOnNoScroll={true}
      hideOnNoScrollDelay={600}
      innerId='home-scrollable'
      className='home'
    >
      <div className="inner-content">
        {!ownUser && <LoginBanner stickyMode />}
        <div className='flex flex-col gap-4 home-explorer-header'>
          <div className={`flex gap-4 ${isMobile ? 'flex-col px-4' : 'flex-wrap justify-between'}`}>
            {!!isMobile && <SearchInputField
              value={search}
              onChange={setSearch}
              placeholder='Search users and communities'
              currentTags={activeSearchTags}
              onAddTag={(tag) => setActiveSearchTags([...activeSearchTags, tag])}
              backgroundColor='var(--chatInputBg) !important'
            />}
            <div className={`flex cg-text-brand items-center flex-wrap ${isMobile ? 'gap-8' : 'gap-12'}`}>
              <Button
                role='textual'
                className='home-section-btn'
                iconLeft={<Compass weight='duotone' className='w-6 h-6' />}
                text='Feed'
                active={pathname === '/'}
                onClick={() => {
                  navigate(getUrl({ type: 'home' }));
                }}
              />

              <Button
                role='textual'
                className='home-section-btn'
                iconLeft={<HouseSimple weight='duotone' className='w-6 h-6' />}
                text='Communities'
                active={pathname === getUrl({ type: 'browse-communities' })}
                onClick={() => {
                  navigate(getUrl({ type: 'browse-communities' }));
                }}
              />

              <Button
                role='textual'
                className='home-section-btn'
                iconLeft={<Storefront weight='duotone' className='w-6 h-6' />}
                text='Apps'
                active={pathname === getUrl({ type: 'appstore' })}
                onClick={() => {
                  navigate(getUrl({ type: 'appstore' }));
                }}
              />
            </div>
            {!isMobile && <div className='flex-shrink'>
              <SearchInputField
                value={search}
                onChange={setSearch}
                placeholder='Search users and communities'
                currentTags={activeSearchTags}
                onAddTag={(tag) => setActiveSearchTags([...activeSearchTags, tag])}
                backgroundColor='var(--chatInputBg) !important'
              />
            </div>}
          </div>
          <div className={`cg-separator${isMobile ? ' mx-4' : ''}`} />
        </div>

        <Routes>
          <Route path='/' element={<Feed />} />
          <Route path={removeInitialSlash(getUrl({ type: 'browse-communities' }))} element={<CommunityExplorer
            mode='unlimited'
            useLargeHeader
          />} />
          <Route path={removeInitialSlash(getUrl({ type: 'appstore' }))} element={<PluginAppstore />} />
          <Route path={`${removeInitialSlash(getUrl({ type: 'appstore' }))}:pluginId`} element={<PluginAppstore />} />
          <Route path={removeInitialSlash(getUrl({ type: 'search' }))} element={
            <Search
              search={search}
              tags={activeSearchTags}
              setTags={setActiveSearchTags}
            />}
          />
          <Route path="*" element={/* Todo */<div>Not found</div>} />
        </Routes>

        <div className='footer-buttons'>
          <Button text='Terms of Use' role='textual' onClick={openTermsOfUse} />
          <Button text='Privacy Policy' role='textual' onClick={openPrivacyPolicy} />
          <Button text='Help' role='textual' onClick={openHelp} />
        </div>
      </div>
    </Scrollable>
  );
}

const tabOptions: { text: string, value: 'all' | 'following' }[] = [
  { text: 'See all content', value: 'all' },
  { text: 'From communities and people you follow', value: 'following' },
];

const Feed: React.FC<{}> = (props) => {
  const ownUser = useOwnUser();
  const [activeTags, setActiveTags] = useState<PredefinedTag[]>([]);
  const [mode, setMode] = useState<'all' | 'following'>('all');

  const amounts = {
    articles: 5,
    communities: 3,
    blogs: 3
  };

  const selectedOption = tabOptions.find(opt => opt.value === mode);

  return <div className='flex flex-col gap-4'>
    <TagHeader
      preTagElements={
        <ScreenAwareDropdown
          placement='bottom-start'
          triggerClassname='h-fit'
          triggerContent={<Button text={selectedOption?.text || ''} role='textual' iconRight={<ChevronDownIcon className='w-5 h-5' />} />}
          items={tabOptions.map(opt => <ListItem key={opt.value} title={opt.text} selected={mode === opt.value} onClick={() => setMode(opt.value)} />)}
        />
      }
      activeTags={activeTags}
      setActiveTags={setActiveTags}
    />

    {!!ownUser && <NotificationBanner />}
    <div className="home-main-content">
      <LiveCallExplorer mode="limited" />
      {/* <MyCommunitiesExplorer /> */}
      <PostsAndEvents
        articleAmount={amounts.articles}
        mode={mode}
        tags={activeTags}
      />
      {/* <GroupList loadingAmount={amounts.communities} /> */}
      {/* <BlogList loadingAmount={amounts.blogs} /> */}
    </div>

  </div>;
}

const PostsAndEvents: React.FC<{ articleAmount: number; mode: 'all' | 'following'; tags: PredefinedTag[]; }> = (props) => {
  // const [searchParams, setSearchParams] = useSearchParams();
  // const tab = searchParams.get('tab') || 'posts';

  const tagStrings = useMemo(() => {
    return props.tags.map(tag => tag.name);
  }, [props.tags]);

  return <div className='flex flex-col gap-4'>
    <EventExplorer
      tags={tagStrings}
      followingOnly={props.mode === 'following'}
    />
    <PostAndEventsButton
      icon={<RectangleStackIcon className='w-6 h-6' />}
      text='Posts'
      active={true}
      onClick={() => { }}
    />
    <ArticleExplorer
      mode='unlimited'
      tags={tagStrings}
      followingOnly={props.mode === 'following'}
      loadingAmount={props.articleAmount}
      hideHeader
      emptyState={<EmptyState
        title={'No articles match your tags'}
      />}
    />
  </div>
}

export const PostAndEventsButton: React.FC<{
  icon: JSX.Element;
  text: string;
  active: boolean;
  onClick: () => void;
  new?: boolean;
}> = (props) => {
  const { isMobile } = useWindowSizeContext();

  const className = [
    'flex gap-2 items-center cg-text-main cg-heading-3 cursor-pointer post-events-button fit-content',
    isMobile ? 'px-4' : '',
    !props.active ? 'inactive' : ''
  ].join(' ').trim();

  const content = <div className={className} onClick={props.onClick}>
    {props.icon}
    {props.text}
  </div>;

  if (!props.new) return content;

  return <div className='flex items-center'>
    {content}
    {props.new && <Tag variant='new' label='NEW' />}
  </div>
}
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './PluginAppstore.css';
import Scrollable from 'components/molecules/Scrollable/Scrollable';
import pluginsApi from 'data/api/plugins';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PluginCard from './PluginCard';
import { SealCheck, Spinner, UsersThree } from '@phosphor-icons/react';
import { fetchInternalLinkData } from 'components/molecules/LinkPreview/LinkPreview.helper';
import { useAsyncMemo } from 'hooks/useAsyncMemo';
import { useSignedUrl } from 'hooks/useSignedUrl';
import EmptyState from 'components/molecules/EmptyState/EmptyState';
import { useSidebarDataDisplayContext } from 'context/SidebarDataDisplayProvider';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import { useSentinelLoadMore } from 'hooks/useSentinelLoadMore';
import { useParams } from 'react-router';
import { usePluginDetailsModalContext } from 'context/PluginDetailsModalProvider';

type Props = {

};

const LOAD_STEP = 10;

const headerArticleLink = 'https://app.cg/c/commonground/article/new-cg-feature-plugins-kfiTKTGVe52ygEDBv8RJ4f/'
const article1 = 'https://staging.app.cg/c/commonground/article/understanding-color-theory-the-color-wheel-and-finding-complementary-colors-fm4yUvjMZXUWvFC4oJPFSs/';
const article2 = 'https://staging.app.cg/c/commonground/article/how-to-design-a-product-that-can-grow-itself-10x-in-year-69AoY2gV4S6xskVu2CW7R2/';
const article3 = 'https://staging.app.cg/c/commonground/article/the-endless-list-of-collectives-for-internal-research-purposes-uQjjPUzqVHcMZGVvPpshCo/';

const PluginAppstore: React.FC<Props> = (props) => {
  const [plugins, setPlugins] = useState<API.Plugins.getAppstorePlugins.Response['plugins']>([]);
  const { isMobile } = useWindowSizeContext();
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(false);
  const isLoadingRef = useRef(false);
  const isDoneFetchingRef = useRef(false);
  const endOfListRef = useRef<HTMLDivElement>(null);
  const { showModal } = usePluginDetailsModalContext();
  const { pluginId: paramPluginId } = useParams<'pluginId'>();

  useEffect(() => {
    const fetchAndShow = async () => {
      if (!!paramPluginId) {
        const plugin = await pluginsApi.getAppstorePlugin({ pluginId: paramPluginId });
        showModal({plugin});
      }
    }

    fetchAndShow();
  }, [paramPluginId, showModal]);

  const fetchMore = useCallback(async () => {
    if (isLoadingRef.current || isDoneFetchingRef.current) {
      return;
    }
    isLoadingRef.current = true;
    setShowLoadingIndicator(true);
    const response = await pluginsApi.getAppstorePlugins({
      limit: LOAD_STEP,
      offset: plugins.length
    });

    if (isLoadingRef.current) {
      setPlugins(prevPlugins => [...prevPlugins, ...response.plugins]);
    }

    // If we got fewer plugins than requested, we've reached the end
    if (response.plugins.length < LOAD_STEP) {
      isDoneFetchingRef.current = true;
    }
    setShowLoadingIndicator(false);
    isLoadingRef.current = false;
  }, [isDoneFetchingRef, plugins.length]);

  useSentinelLoadMore(endOfListRef, true, fetchMore);

  const verifiedApps = useMemo(() => plugins.filter(plugin => plugin.appstoreEnabled), [plugins]);
  const communityApps = useMemo(() => plugins.filter(plugin => !plugin.appstoreEnabled), [plugins]);

  return <div className={`max-w-[848px] mx-auto h-full w-full${isMobile ? ' px-4' : ''}`}>
    <Scrollable innerClassName='flex flex-col gap-6'>
      <div className='flex flex-col w-full gap-4'>
        <HeroElementArticleCard articleUrl={headerArticleLink} large />

        {/* <div className='grid grid-flow-row grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4'>
          <HeroElementArticleCard articleUrl={article1} />
          <HeroElementArticleCard articleUrl={article2} />
          <HeroElementArticleCard articleUrl={article3} />
        </div> */}
      </div>

      {!showLoadingIndicator && plugins.length === 0 && <EmptyState
        title='Nothing to see here yet!'
        description='Check back later for new plugins or contact us to get yours displayed here!.'
      />}

      {verifiedApps.length > 0 && (
        <div className='flex flex-col gap-4'>
          <div className="cg-text-main cg-heading-2 flex items-center gap-2">
            <SealCheck className='w-7 h-7' weight='duotone' /> Verified Apps
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4">
            {verifiedApps.map(plugin => <PluginCard key={plugin.pluginId} {...plugin} />)}
          </div>
        </div>
      )}

      {communityApps.length > 0 && (
        <div className='flex flex-col gap-4'>
          <div className="cg-text-main cg-heading-2 flex items-center gap-2">
            <UsersThree className='w-7 h-7' weight='duotone' /> Community Apps
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4">
            {communityApps.map(plugin => <PluginCard key={plugin.pluginId} {...plugin} />)}
          </div>
        </div>
      )}

      {showLoadingIndicator && <div className='flex items-center justify-center'>
        <Spinner className='w-10 h-10 spinner' />
      </div>}
      {!isDoneFetchingRef.current && <div ref={endOfListRef} />}
    </Scrollable>
  </div>;
};

const HeroElementArticleCard = ({ articleUrl, large }: {
  articleUrl: string;
  large?: boolean;
}) => {
  const { showTooltip } = useSidebarDataDisplayContext();
  const article = useAsyncMemo(async () => {
    const article = await fetchInternalLinkData(articleUrl);
    if (article?.type === 'article' && 'communityArticle' in article.article) {
      return article.article;
    }
  }, [articleUrl]);

  const imageUrl = useSignedUrl(article?.article.headerImageId);

  return <div
    className={`flex flex-col justify-end bg-gray-100 rounded-lg bg-center bg-no-repeat bg-cover relative overflow-hidden cursor-pointer p-4 ${large ? 'aspect-3/1' : 'h-40'}`}
    style={{ backgroundImage: `url(${imageUrl})` }}
    onClick={() => {
      if (article) {
        showTooltip({
          type: 'article',
          articleId: article.article.articleId,
          communityId: article.communityArticle.communityId,
        });
      }
    }}
  >
    <div className="absolute inset-x-0 bottom-0 h-full bg-linear-to-t from-black/70 to-transparent rounded-lg" />
    {large ? <h2 className='cg-text-white z-10'>{article?.article.title}</h2> : <h3 className='cg-text-white z-10'>{article?.article.title}</h3>}
  </div>
}

export default PluginAppstore;
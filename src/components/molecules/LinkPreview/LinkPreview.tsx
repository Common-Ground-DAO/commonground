// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './LinkPreview.css';
import { LockClosedIcon, LockOpenIcon, XMarkIcon } from '@heroicons/react/20/solid';
import { useSignedUrl } from 'hooks/useSignedUrl';
import { isLocalUrl } from 'components/atoms/SimpleLink/SimpleLink';
import { fetchInternalLinkData } from './LinkPreview.helper';
import { useAsyncMemo } from 'hooks/useAsyncMemo';
import data from 'data';
import { useLiveQuery } from 'dexie-react-hooks';
import { calculateArticleAgeString, isArticleGated } from '../ArticleCardV2/ArticleCardV2.helper';
import dayjs from 'dayjs';
import { useNavigate } from 'react-router';
import { useExternalModalContext } from 'context/ExternalModalProvider';
import GatedDialogModal, { calculatePermissions } from 'components/organisms/GatedDialogModal/GatedDialogModal';
import { getUrl } from 'common/util';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import EventCard from '../EventCard/EventCard';
import { useCommunityListView } from 'context/CommunityListViewProvider';
import { cssBackgroundImage } from 'util/cssBackground';

type Props = Omit<Models.Message.LinkPreviewAttachment, "type"> & {
  onRemove?: () => void;
};

const domainRegex = new RegExp('^(?:https?://)?(?:[^@/]+@)?(?:www.)?([^:/?]+)');

const MINIMUM_COLLAPSED_WIDTH = 360;

const ExternalLinkPreview: React.FC<Props> = (props) => {
  const navigate = useNavigate();
  const { isMobile } = useWindowSizeContext();
  const localExtract = isLocalUrl(props.url);
  const { showModal } = useExternalModalContext();
  const linkPreviewRef = useRef<HTMLDivElement>(null);
  const [isSmallMode, setSmallMode] = useState(false);
  const [forceRefreshInternal, setForceRefreshInternal] = useState(0);
  const internalLinkData = useAsyncMemo(async () => {
    if (localExtract) return fetchInternalLinkData(localExtract);
    return undefined;
  }, [localExtract, forceRefreshInternal]);

  const communityId: string | undefined = useMemo(() => {
    if (internalLinkData?.type === 'article' && 'communityArticle' in internalLinkData?.article) {
      return internalLinkData.article.communityArticle.communityId;
    }
    if (internalLinkData?.type === 'event') {
      return internalLinkData.event.communityId;
    }
  }, [internalLinkData])

  const itemCommunity = useCommunityListView(communityId);

  const articleCommunityRoles = useLiveQuery(() => {
    if (internalLinkData?.type === 'article' && 'communityArticle' in internalLinkData?.article) {
      return data.community.getRoles(internalLinkData?.article.communityArticle.communityId);
    }
  }, [internalLinkData]);

  const [showGatedDialog, setShowGatedDialog] = useState(false);
  const gatedState = useAsyncMemo(async () => {
    if (internalLinkData?.type === 'article' && ('communityArticle' in internalLinkData.article)) {
      return calculatePermissions(internalLinkData.article);
    }
  }, [internalLinkData]);

  const onClick = useCallback(() => {
    if (gatedState) {
      setShowGatedDialog(true);
    } else if (localExtract) {
      navigate(localExtract);
    } else {
      showModal(props.url);
    }
  }, [gatedState, localExtract, navigate, props.url, showModal]);

  const calculateTargetWidth = useCallback(({ actualWidth, actualHeight, targetHeight }: { actualWidth: number, actualHeight: number, targetHeight: number }) => {
    if (actualHeight === 0) return 150; // div by zero, fall back to 150px
    return Math.round(actualWidth * targetHeight / actualHeight);
  }, []);

  const imageUrl = useSignedUrl(props.imageId);
  const imageElement = useMemo(() => {
    if (props.imageData) {
      const targetWidth = calculateTargetWidth({ actualWidth: props.imageData.size.width, actualHeight: props.imageData.size.height, targetHeight: 150 });
      return (
        <div className="external-link-image external-link-image-loadanimation">
          {imageUrl
            ? <img
              loading='lazy'
              className='external-link-image-innerimg'
              onLoad={(ev) => { ev.currentTarget.style.opacity = '1'; ev.currentTarget.style.transform = 'scale(1)'; }}
              src={imageUrl}
              alt=''
              width={`${targetWidth}px`}
              height='150px'
            />
            : <div
              style={{
                width: `${targetWidth}px`,
                height: '150px'
              }}
            />
          }
        </div>
      );
    }
    else {
      if (!imageUrl) return null;
      return <div style={{ backgroundImage: cssBackgroundImage(imageUrl) }} className='external-link-image' />;
    }
  }, [imageUrl, props.imageData?.size.width, props.imageData?.size.height]);

  const previewDomain = (() => {
    if (localExtract) {
      if (internalLinkData?.type === 'article') return itemCommunity?.title;
      if (internalLinkData?.type === 'community') return undefined;
    }

    const urlDomainResult = domainRegex.exec(props.url);
    return urlDomainResult ? urlDomainResult[1] : '';
  })();

  const isExclusive = useAsyncMemo(async () => {
    if (internalLinkData?.type === 'article' && 'communityArticle' in internalLinkData?.article) {
      return !!(await isArticleGated(internalLinkData.article.communityArticle));
    }
    return false;
  }, [internalLinkData]);

  const previewFooter = useMemo(() => {
    if (internalLinkData?.type === 'article' && 'communityArticle' in internalLinkData?.article && articleCommunityRoles) {
      const cardDate = dayjs(internalLinkData.article.communityArticle.published);
      return <div className='flex items-center gap-1 cg-text-sm-500 pt-1'>
        <span className='cg-text-secondary'>{calculateArticleAgeString(cardDate)}</span>
        {isExclusive && <div className='cg-text-main flex items-center gap-1'>
          {gatedState ? <LockClosedIcon className='w-3 h-3' /> : <LockOpenIcon className='w-3 h-3' />}
          <span>Exclusive</span>
        </div>}
      </div>
    }
    return null;
  }, [internalLinkData, gatedState !== undefined, articleCommunityRoles !== undefined, isExclusive === true]);

  // useEffect(() => {
  //   const listener: ResizeObserverCallback = async ([entry]) => {
  //     if (entry) {
  //       const width = entry.contentRect.width;
  //       const useSmallMode = width < MINIMUM_COLLAPSED_WIDTH;
  //       setSmallMode(useSmallMode);
  //     }
  //   }

  //   const observer = new ResizeObserver(listener);
  //   if (linkPreviewRef.current) {
  //     observer.observe(linkPreviewRef.current);
  //   }

  //   return () => observer.disconnect();
  // }, []);

  if (internalLinkData?.type === 'event') {
    const onEventClick = () => {
      if (itemCommunity) navigate(getUrl({type: 'event', community: itemCommunity, event: internalLinkData.event}));
    }

    return <div className='w-full cg-bg-subtle cg-border-xxl p-2 cursor-pointer' onClick={onEventClick}>
      <EventCard
        event={internalLinkData.event}
        onUpdateEvent={() => setForceRefreshInternal(old => old + 1)}
        hideDescription
      />
    </div>
  }

  return (<>
    <div onClick={onClick} className={`flex items-start gap-4 p-2 relative external-link-preview${!isMobile && isSmallMode ? ' collapsed' : ''}`} ref={linkPreviewRef}>
      <div className='flex flex-col p-2 items-start gap-0.5 external-link-text-content flex-1 max-w-full'>
        {previewDomain && <span className='cg-text-secondary whitespace-nowrap text-ellipsis overflow-hidden cg-text-md-500 w-full'>{previewDomain}</span>}
        <div className='external-link-text cg-text-secondary cg-text-md-400'>
          <span className='cg-text-main cg-text-lg-500'>{props.title}</span><br />
          <span className='cg-text-secondary cg-text-md-400'>{props.description}</span>
        </div>
        {previewFooter}
      </div>
      {props.onRemove && <div className='external-link-close' onClick={(ev) => { ev.stopPropagation(); props.onRemove?.(); }}><XMarkIcon className='w-5 h-5' /></div>}
      {imageElement}
    </div>
    {gatedState && <GatedDialogModal
      requiredPermissions={gatedState}
      isOpen={showGatedDialog}
      onClose={(redirect) => {
        setShowGatedDialog(false);
        if (redirect && itemCommunity && internalLinkData?.type === 'article') {
          navigate(getUrl({ type: 'community-article', article: internalLinkData.article.article, community: itemCommunity }));
        }
      }}
    />}
  </>);
}

export default React.memo(ExternalLinkPreview);
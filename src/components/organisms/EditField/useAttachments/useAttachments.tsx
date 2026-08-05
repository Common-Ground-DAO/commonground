// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { isLocalUrl } from "components/atoms/SimpleLink/SimpleLink";
import { fetchInternalLinkData } from "components/molecules/LinkPreview/LinkPreview.helper";
import messageApi from "data/api/messages";
import { useCallback, useRef, useState } from "react";
import { ReactEditor } from "slate-react";
import { IGif } from '@giphy/js-types';

const VERIFY_LINK_DEBOUNCE_DURATION_MS = 500;
const FETCH_LINK_DEBOUNCE_DURATION_MS = 1000;

export type InMemoryAttachment = Models.Message.Attachment & {
  event?: Models.Community.Event;
  tentativeFile?: File;
  state?: 'INITIAL' | 'LOADING' | 'LOADED';
  /**
   * Set while the NSFW pre-check is still running for this file (see
   * `AttachmentDropdown.helpers.ts`). The tile is rendered immediately so the
   * pick is visible, but `MediaAttachment` must not start uploading yet, and
   * `EditField`'s `areAttachmentsLoaded` treats it as busy so a message sent
   * during the check cannot silently drop the attachment.
   */
  precheckPending?: boolean;
  originalUrl?: string;
  giphyGif?: IGif;
};

export async function fetchLinkPreview(url: string): Promise<InMemoryAttachment | null> {
  try {
    const localExtract = isLocalUrl(url);
    if (localExtract) {
      // Add local preview attachment
      const result = await fetchInternalLinkData(localExtract);
      if (result) {
        if (result.type === 'community') {
          return {
            type: 'linkPreview',
            title: result.community.title,
            description: result.community.description,
            imageId: result.community.logoLargeId || result.community.logoSmallId || '',
            url: url,
            originalUrl: url
          };
        } else if (result.type === 'article') {
          return {
            type: 'linkPreview',
            title: result.article.article.title,
            description: result.article.article.previewText || '',
            imageId: result.article.article.headerImageId || '',
            url: url,
            originalUrl: url
          };
        } else {
          return {
            type: 'linkPreview',
            // Other fields are empty because we render an event card
            title: result.event.title,
            description: '',
            imageId: result.event.imageId || '',
            url
          }
        }
      } else {
        return null;
      }
    } else {
      // Add external preview attachment
      const preview = await messageApi.getUrlPreview({ url });
      if (preview.title) {
        return {
          type: 'linkPreview',
          title: preview.title,
          description: preview.description,
          imageId: preview.imageId,
          url: preview.url,
          originalUrl: url
        };
      } else {
        return null;
      }
    }
  } catch (e) {
    return null;
  }
}

export function useAttachments(initialAttachments?: Models.Message.Attachment[]) {
  const [attachments, setAttachments] = useState<InMemoryAttachment[]>(initialAttachments?.map(att => ({ ...att, state: 'INITIAL' })) || []);
  const [loadingLinkAttachment, setLoadLinkingAttachment] = useState(false);
  const waitingForPreviews = useRef(false);
  const excludedPreviews = useRef<string[]>([]);
  const parseLinkTimeoutRef = useRef<any>(null);
  const currentLinkPreview = attachments.find(att => att.type === 'linkPreview');

  const removePreview = useCallback((previewUrl: string) => {
    excludedPreviews.current = [...excludedPreviews.current, previewUrl];
    setAttachments(oldAttachments => oldAttachments.filter(att => att.type !== 'linkPreview'));
    setLoadLinkingAttachment(false);
  }, []);

  const tryFetchLinkPreview = useCallback(async (url: string) => {
    waitingForPreviews.current = true;
    setLoadLinkingAttachment(true);

    const newAttachment = await fetchLinkPreview(url);
    if (newAttachment) {
      if (waitingForPreviews.current) {
        setAttachments(oldAttachments => [...oldAttachments, newAttachment]);
        setLoadLinkingAttachment(false);
      }
    } else {
      removePreview(url);
    }
  }, [removePreview]);

  const parseLinks = useCallback((editor: ReactEditor) => {
    waitingForPreviews.current = false;
    setLoadLinkingAttachment(false);
    if (!!parseLinkTimeoutRef.current) {
      clearTimeout(parseLinkTimeoutRef.current);
    }

    const timeoutDuration = !!currentLinkPreview ? VERIFY_LINK_DEBOUNCE_DURATION_MS : FETCH_LINK_DEBOUNCE_DURATION_MS;

    parseLinkTimeoutRef.current = setTimeout(() => {
      let firstParsedLink: string = '';
      for (const element of editor.children) {
        if (element.type === 'paragraph') {
          for (const child of element.children) {
            if (child.type === 'link') firstParsedLink = child.text.trim();
            if (child.url) firstParsedLink = child.url.trim();
            if (firstParsedLink) break;
          }
        }
        if (firstParsedLink) break;
      };

      // Keep only relevant excluded
      excludedPreviews.current = excludedPreviews.current.filter(excluded => excluded === firstParsedLink);

      // If no link found or link doesn't match, remove attachment
      if (!firstParsedLink || (currentLinkPreview?.type === 'linkPreview' && currentLinkPreview.originalUrl !== firstParsedLink)) {
        setAttachments(oldAttachments => oldAttachments.filter(att => att.type !== 'linkPreview'));
        return;
      }

      // If no attachment and not excluded, fetch
      const linkExcluded = excludedPreviews.current.includes(firstParsedLink);
      if (!linkExcluded && !currentLinkPreview) {
        tryFetchLinkPreview(firstParsedLink);
      }
    }, timeoutDuration);
  }, [tryFetchLinkPreview, currentLinkPreview]);

  return { attachments, loadingLinkAttachment, setAttachments, removePreview, parseLinks };
}
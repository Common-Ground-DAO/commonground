// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import communityArticleManager from 'data/managers/communityArticleManager';
import communityManager from 'data/managers/communityManager';
import config from 'common/config';
import { parseIdOrUrl } from '../../../util';
import data from 'data';
import { createTranslator } from "short-uuid";
import communityApi from 'data/api/community';

export type PreviewState = {
  type: 'article';
  article: API.Community.getArticleList.Response[0] | API.User.getArticleList.Response[0];
} | {
  type: 'community';
  community: Models.Community.DetailViewFromApi;
} | {
  type: 'event';
  event: Models.Community.Event;
}

const eventRegex = new RegExp(`/${config.URL_COMMUNITY}/([a-zA-Z0-9]*)/${config.URL_EVENT}/([~a-zA-Z0-9]*)(?:/){0,1}`, 'i');
const articleRegex = new RegExp(`/${config.URL_COMMUNITY}/([a-zA-Z0-9]*)/${config.URL_ARTICLE}/.*-([a-zA-Z0-9]{22})(?:/){0,1}`, 'i');
const communityRegex = new RegExp(`/${config.URL_COMMUNITY}/([a-zA-Z0-9]*)(?:/){0,1}`, 'i');
const t = createTranslator();

export async function fetchInternalLinkData(localExtract: string): Promise<PreviewState | undefined> {
  if (localExtract) {
    const eventResult = eventRegex.exec(localExtract);
    const articleResult = articleRegex.exec(localExtract);
    const communityResult = communityRegex.exec(localExtract);

    if (eventResult) {
      const [, , eventIdOrUrl] = eventResult;
      const whatIsItEvent = parseIdOrUrl(eventIdOrUrl);

      const event = await communityApi.getEvent(whatIsItEvent.url ? { url: whatIsItEvent.url } : { id: whatIsItEvent.uuid || '' });
      return {
        type: 'event',
        event
      };
    } else if (articleResult) {
      // If article
      const [, communityIdOrUrl, articleIdShort] = articleResult;
      const whatIsItComm = parseIdOrUrl(communityIdOrUrl);
      const articleId = t.toUUID(articleIdShort);
      let communityId = '';
      if (whatIsItComm.uuid) {
        communityId = whatIsItComm.uuid;
      } else if (whatIsItComm.url) {
        let community = await data.community.getCommunityByUrl(whatIsItComm.url);
        if (!community) {
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for community to be fetched
          community = await data.community.getCommunityByUrl(whatIsItComm.url);
        }
        if (community) communityId = community?.id;
      }

      const [result] = await communityArticleManager.getArticleList({  communityId, limit: 1, ids: [articleId] });
      if (result) {
        return {
          type: 'article',
          article: result
        }
      }
    } else if (communityResult) {
      // If community
      const [, communityIdOrUrl] = communityResult;
      const whatIsIt = parseIdOrUrl(communityIdOrUrl);
      const request = whatIsIt.uuid ? { id: whatIsIt.uuid } : { url: whatIsIt.url || '' };
      const community = await communityManager.getCommunityDetailView(request)
      if (community) {
        return {
          type: 'community',
          community
        }
      }
    }
  }
}
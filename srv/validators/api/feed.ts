// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Joi from "joi";
import common from "../common";

const feedApi = {
  getPostList: Joi.object<API.Feed.getPostList.Request>({
    scope: Joi.string().valid('following', 'explore'),
    actorTypes: Joi.array()
      .items(Joi.string().valid('user', 'community'))
      .min(1)
      .unique(),
    topics: common.Tags,
    verification: Joi.string().valid('verified', 'unverified', 'both'),
    // Unified cursor: publishedAt and postId are a pair — both or neither.
    before: Joi.object({
      publishedAt: common.DateString.required(),
      postId: common.Uuid.required(),
    }).strict(true),
    limit: Joi.number().integer().min(1).max(30).required(),
  }).strict(true).required(),
};

export default feedApi;

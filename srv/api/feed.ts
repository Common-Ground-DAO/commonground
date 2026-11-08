// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from "express";
import feedHelper from "../repositories/feed";
import { registerPostRoute } from "./util";
import validators from "../validators";

const feedRouter = express.Router();

registerPostRoute<
  API.Feed.getPostList.Request,
  API.Feed.getPostList.Response
>(
  feedRouter,
  '/getPostList',
  validators.API.Feed.getPostList,
  async (request, response, data) => {
    const { user } = request.session;
    // Anonymous callers get an empty list for the 'following' scope (no follow
    // graph); authorization for each post is enforced inside the repository.
    return await feedHelper.getPostList(user?.id, data);
  }
);

export default feedRouter;

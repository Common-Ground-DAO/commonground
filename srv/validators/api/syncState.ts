// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Joi from "joi";
import common from "../common";

const syncStateApi = {
  /** `Message/getSyncState`; a call without a body arrives as `{}` */
  getSyncState: Joi.object<API.Messages.getSyncState.Request>({
    channelIds: Joi.array().items(common.Uuid).max(500).unique(),
  }).strict(true).required(),
};

export default syncStateApi;

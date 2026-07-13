// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { GiphyFetch } from "@giphy/js-fetch-api";
import config from "../common/config";

// use @giphy/js-fetch-api to fetch gifs
// apply for a new Web SDK key. Use a separate key for every platform (Android, iOS, Web)
// self-hosted instances configure their own key (or none — the picker is
// hidden then); the default key is CG's
export const giphyEnabled = !!config.GIPHY_API_KEY;
export const gf = new GiphyFetch(config.GIPHY_API_KEY || 'disabled');
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from "express";
import errors from "../common/errors";
import stakingHelper from "../repositories/staking";
import { getStakingConfig } from "../util/stakingConfig";
import { registerPostRoute } from "./util";

const stakingRouter = express.Router();

function sessionUserId(request: express.Request) {
  const user = request.session.user;
  if (!user) throw new Error(errors.server.LOGIN_REQUIRED);
  return user.id;
}

registerPostRoute<API.Staking.getConfig.Request, API.Staking.getConfig.Response>(
  stakingRouter,
  '/getConfig',
  undefined,
  (request) => {
    sessionUserId(request);
    const config = getStakingConfig();
    return Promise.resolve({
      config: config ? {
        chain: config.chain,
        tokenAddress: config.tokenAddress,
        contractAddress: config.contractAddress,
        baseRate: config.baseRate,
        minLockDays: config.minLockDays,
        maxLockDays: config.maxLockDays,
      } : null,
    });
  },
);

registerPostRoute<API.Staking.getPositions.Request, API.Staking.getPositions.Response>(
  stakingRouter,
  '/getPositions',
  undefined,
  (request) => stakingHelper.getPositionsByUser(sessionUserId(request)),
);

export default stakingRouter;

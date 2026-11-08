// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from "express";
import validators from "../validators";
import { farcasterApi, registerPostRoute } from "./util";
import errors from "../common/errors";
import walletHelper from "../repositories/wallets";
import userHelper from "../repositories/users";
import { fetchRemoteImage } from "../util/safeFetch";
import fileHelper from "../repositories/files";
import ipRateLimitHandler from "../util/rateLimit";
import { AUTH_LIMITS } from "../util/authLimits";
import { assertSiweForThisInstance } from "../repositories/wallets";
import { farcasterIdOf } from "../util/siweMessage";
import { isGatewayMode } from "../util/gateway";

const accountsRouter = express.Router();

// the check asks the Farcaster registry (srv/util/authLimits.ts "preLogin")
const farcasterSignatureLimiter = ipRateLimitHandler({
  bucket: 'accounts:farcaster:verify-login',
  ...AUTH_LIMITS.preLogin.signatureCheck,
});

registerPostRoute<
  API.Accounts.Farcaster.verifyLogin.Request,
  API.Accounts.Farcaster.verifyLogin.Response
>(
  accountsRouter,
  '/Farcaster/verifyLogin',
  validators.API.Accounts.Farcaster.verifyLogin,
  async (request, response, data) => {
    await farcasterSignatureLimiter(request, response);
    // parsed by its structure, signature checked (srv/util/siweMessage.ts)
    const siweData = walletHelper.parseAndVerifySiweData(data);
    const issuedAt = new Date(siweData.issuedAt);
    if (Math.abs(Date.now() - issuedAt.getTime()) > 60_000) {
      throw new Error("issuedAt is not current");
    }
    if (request.session.signSecret !== siweData.nonce) {
      throw new Error(errors.server.INVALID_SECRET);
    }
    // made for this instance, like a wallet sign-in message: its domain and
    // URI name this instance's web app, so a message signed for another
    // site is worthless here
    assertSiweForThisInstance(siweData.headerLine, siweData.uri);
    {
      // exactly one farcaster://fid/<fid> resource
      const farcasterId = farcasterIdOf(siweData);
      const userRegistry = await farcasterApi('onChainIdRegistryEventByAddress', { address: siweData.address });
      console.log(`Farcaster login: registry fid ${userRegistry?.fid}, claimed fid ${farcasterId}`);
      if (userRegistry?.fid !== farcasterId) {
        throw new Error("Farcaster ID mismatch");
      }
      const existingAccount = await userHelper.getUserAccount("farcaster", farcasterId.toString());
      if (!existingAccount && isGatewayMode()) {
        // a gateway (srv/util/gateway.ts) signs in existing accounts only: no
        // profile lookup, no image fetched or stored, no sign-up prepared
        throw new Error(errors.server.ACCOUNT_DOES_NOT_EXIST);
      }

      let username: string | undefined;
      let displayName: string | undefined;
      let bio: string | undefined;
      let url: string | undefined;
      let pfp: string | undefined;
      let imageId: string | null = null;

      if (!!existingAccount) {
        if (existingAccount.data?.type === 'farcaster' && existingAccount.extraData?.type === 'farcaster') {
          username = existingAccount.extraData.username;
          displayName = existingAccount.displayName;
          bio = existingAccount.extraData.bio;
          url = existingAccount.extraData.url;
          imageId = existingAccount.imageId;
        }
        else {
          console.error(`Existing farcaster account of fid ${farcasterId} lacks profile fields`);
          throw new Error(errors.server.INVALID_REQUEST);
        }
      }
      else {
        const userData = await farcasterApi('userDataByFid', { fid: farcasterId });

        
        for (const message of userData.messages) {
          const { type, fid, userDataBody } = message.data;
          if (!userDataBody) continue;
          if (type === 'MESSAGE_TYPE_USER_DATA_ADD' && fid === farcasterId) {
            if (userDataBody.type === 'USER_DATA_TYPE_USERNAME') {
              username = userDataBody.value;
            }
            else if (userDataBody.type === 'USER_DATA_TYPE_DISPLAY') {
              displayName = userDataBody.value;
            }
            else if (userDataBody.type === 'USER_DATA_TYPE_BIO') {
              bio = userDataBody.value;
            }
            else if (userDataBody.type === 'USER_DATA_TYPE_URL') {
              url = userDataBody.value;
            }
            else if (userDataBody.type === 'USER_DATA_TYPE_PFP') {
              pfp = userDataBody.value;
            }
          }
        }
        if (!displayName || !username) {
          console.error(`Farcaster profile data missing for fid ${farcasterId}`);
          throw new Error(errors.server.INVALID_REQUEST);
        }
        if (!!pfp) {
          try {
            const buffer = await fetchRemoteImage(pfp);
            const image = await fileHelper.saveImage(null, { type: 'userProfileImage' }, buffer, { width: 110, height: 110 });
            imageId = image.fileId;
          }
          catch (e) {
            console.error("Could not retrieve farcaster profile image for fid " + farcasterId, e instanceof Error ? e.message : e);
          }
        }
      }

      const fullResult = {
        fid: farcasterId,
        displayName,
        username,
        bio,
        url,
        imageId,
        readyForLogin: !!existingAccount,
        readyForCreation: !existingAccount,
      };
      request.session.farcaster = {
        address: siweData.address,
        ...fullResult,
      };
      
      delete request.session.signSecret;

      return fullResult;
    }
  }
);

export default accountsRouter;
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from "express";
import validators from "../validators";
import { farcasterApi, registerPostRoute } from "./util";
import errors from "../common/errors";
import walletHelper from "../repositories/wallets";
import userHelper from "../repositories/users";
import axios from "../util/axios";
import fileHelper from "../repositories/files";

const accountsRouter = express.Router();

registerPostRoute<
  API.Accounts.Farcaster.verifyLogin.Request,
  API.Accounts.Farcaster.verifyLogin.Response
>(
  accountsRouter,
  '/Farcaster/verifyLogin',
  validators.API.Accounts.Farcaster.verifyLogin,
  async (request, response, data) => {
    const siweData = walletHelper.parseAndVerifySiweData(data);
    const issuedAt = new Date(siweData.issuedAt);
    if (Math.abs(Date.now() - issuedAt.getTime()) > 60_000) {
      throw new Error("issuedAt is not current");
    }
    if (request.session.signSecret !== siweData.nonce) {
      throw new Error(errors.server.INVALID_SECRET);
    }
    const lines = data.message.split('\n');
    if (lines[10].startsWith('Resources:') && lines[11].startsWith('- farcaster://fid/')) {
      const farcasterIdString = lines[11].substring(18).match(/^\d+$/)?.[0];
      const farcasterId = !!farcasterIdString ? parseInt(farcasterIdString) : null;
      const userRegistry = await farcasterApi('onChainIdRegistryEventByAddress', { address: siweData.address });
      console.log("Farcaster user registry result", userRegistry, farcasterIdString);
      if (farcasterId === null || userRegistry.fid !== farcasterId) {
        throw new Error("Farcaster ID mismatch");
      }
      const existingAccount = await userHelper.getUserAccount("farcaster", farcasterId.toString());

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
          console.error("Existing account does not have the correct farcaster fields", existingAccount);
          throw new Error(errors.server.INVALID_REQUEST);
        }
      }
      else {
        const userData = await farcasterApi('userDataByFid', { fid: farcasterId });
        console.log("create farcaster user data: ", userData);
        
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
          console.error("Farcaster user data missing", userData);
          throw new Error(errors.server.INVALID_REQUEST);
        }
        if (!!pfp) {
          try {
            const response = await axios.get(pfp, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data, "utf-8");
            const image = await fileHelper.saveImage(null, { type: 'userProfileImage' }, buffer, { width: 110, height: 110 });
            imageId = image.fileId;
          }
          catch (e) {
            console.error("Could not retrieve farcaster profile image for fid " + farcasterId, e);
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
    else {
      throw new Error(errors.server.INVALID_REQUEST);
    }
  }
);

export default accountsRouter;
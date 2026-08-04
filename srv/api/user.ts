// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from "express";
import redisManager from '../redis';
import { UAParser } from "ua-parser-js";
import {
  randomString
} from "../util";
import errors from "../common/errors";
import { UserProfileTypeEnum } from "../common/enums";
import Validators from "../validators";
import userHelper, { CreateUserAccountData } from "../repositories/users";
import walletHelper from "../repositories/wallets";
import deviceHelper from "../repositories/device";
import communityHelper from "../repositories/communities";
import fileHelper from "../repositories/files";
import chatHelper from "../repositories/chats";
import { registerPostRoute } from "./util";
import validators from "../validators";
import articleHelper from "../repositories/articles";
import eventHelper from "../repositories/event";
import notificationHelper from "../repositories/notifications";
import axios from "../util/axios";
import onchainHelper from "../repositories/onchain";
import permissionHelper from "../repositories/permissions";
import ipRateLimitHandler from "../util/rateLimit";
import config from "../common/config";
import { verifyCaptchaToken } from "../util/captcha";
import emailUtils, { emailEnabled } from "./emails";
import emailHelper from "../repositories/emails";

export const SIGNABLE_SECRET_LENGTH = 20;

const userRouter = express.Router();

async function getAndStoreUniversalProfileImage(profileImageUrl: string): Promise<string | null> {
  try {
    const imageUrl =
      profileImageUrl.startsWith("ipfs://") 
      ? `https://ipfs.io/ipfs/${profileImageUrl.split('ipfs://').pop()}`
      : profileImageUrl.replace("_normal", "");
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36' } });
    const buffer = Buffer.from(response.data, "utf-8");
    const image = await fileHelper.saveImage(null, { type: 'userProfileImage' }, buffer, { width: 110, height: 110 });
    return image.fileId;
  } catch (e) {
    // For now just ignore error if this fails, but is this fine for now?
    console.error("Could not download lukso image", e);
  }
  return null;
}

registerPostRoute<
  API.User.getSignableSecret.Request,
  API.User.getSignableSecret.Response
>(
  userRouter,
  '/getSignableSecret',
  undefined,
  async (request, response, data) => {
    const newSecret = randomString(SIGNABLE_SECRET_LENGTH);
    request.session.signSecret = newSecret;
    await new Promise<void>((resolve, reject) => {
      request.session.save((e) => {
        if (e) {
          console.error("Error saving session", e);
          reject(e);
        }
        else {
          resolve();
        }
      })
    });
    return newSecret;
  }
);

const verifyCaptchaRateLimiter = ipRateLimitHandler({
  windowMs: 1000 * 60 * 60 * 24, // 24h
  limit_v4_v6_64: 3,
  limit_v6_56: 10,
  limit_v6_48: 20,
});

registerPostRoute<
  API.User.verifyCaptcha.Request,
  API.User.verifyCaptcha.Response
>(
  userRouter,
  '/verifyCaptcha',
  validators.API.User.verifyCaptcha,
  async (request, response, data) => {
    const { token } = data;
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.NOT_ALLOWED);
    }

    const verifySuccess = await verifyCaptchaToken(token);
    // Check response status and send back to the client-side
    if (verifySuccess) {
      await verifyCaptchaRateLimiter(request, response);
      await userHelper.updateUser(user.id, { trustScore: '1.0' })
      return true;
    }
    return false;
  }
);

registerPostRoute<
  API.User.clearLoginSession.Request,
  API.User.clearLoginSession.Response
>(
  userRouter,
  '/clearLoginSession',
  undefined,
  async (request, response, data) => {
    request.session.lukso = undefined;
    request.session.farcaster = undefined;
    request.session.twitter = undefined;
    request.session.passport = undefined;
  }
);

registerPostRoute<
  API.User.login.Request,
  API.User.login.Response
>(
  userRouter,
  "/login",
  Validators.API.User.login,
  async (request, response, data) => {
    const { signSecret } = request.session;
    let communities: Models.Community.DetailViewFromApi[],
      chats: Models.Chat.ChatFromApi[],
      ownData: Models.User.OwnData,
      deviceId: string,
      unreadNotificationCount: number,
      webPushSubscription: Models.Notification.PushSubscription | null = null;

    const userAgent = UAParser(request.headers["user-agent"]);
    // device type is either mobile, tablet, wearable, etc. But always undefined for desktops
    const isMobileLogin = !!userAgent.device.type;

    // wallet login
    if (data.type === "wallet") {
      const { device } = data;
      const { preparedCredential } = request.session;
      if (!preparedCredential || preparedCredential.type !== "wallet" || preparedCredential.result.readyForLogin === false || !preparedCredential.ownerId) {
        throw new Error(errors.server.INVALID_REQUEST);
      }
      const { ownerId } = preparedCredential;
      [
        ownData,
        communities,
        chats,
        { deviceId },
        unreadNotificationCount,
      ] = await Promise.all([
        userHelper.getOwnDataById(ownerId),
        communityHelper.getOwnCommunities(ownerId),
        chatHelper.getChats(ownerId),
        deviceHelper.createDevice(ownerId, device.publicKey),
        notificationHelper.getUnreadCount(ownerId),
      ]);
      delete request.session.preparedCredential;

      // device login
    } else if (data.type === "device") {
      deviceId = data.deviceId;
      const { secret, base64Signature } = data;
      if (!signSecret || secret !== signSecret) {
        throw new Error(errors.server.INVALID_SECRET);
      }
      const { userId, webPushSubscription: _wpSub } = await deviceHelper.verifyDeviceAndGetUserId(deviceId, secret, base64Signature);
      webPushSubscription = _wpSub;
      [
        ownData,
        communities,
        chats,
        unreadNotificationCount,
      ] = await Promise.all([
        userHelper.getOwnDataById(userId),
        communityHelper.getOwnCommunities(userId),
        chatHelper.getChats(userId),
        notificationHelper.getUnreadCount(userId),
        deviceHelper.deviceLoggedIn(deviceId),
      ]);
      // Email + Password login
    } else if (data.type === "password") {
      const { aliasOrEmail, password, device } = data;
      ownData = await userHelper.getOwnDataByCgProfileNameOrEmailAndPassword(aliasOrEmail, password);
      [ communities,
        chats,
        { deviceId },
        unreadNotificationCount,
      ] = await Promise.all([
        communityHelper.getOwnCommunities(ownData.id),
        chatHelper.getChats(ownData.id),
        deviceHelper.createDevice(ownData.id, device.publicKey),
        notificationHelper.getUnreadCount(ownData.id),
      ]);
      // Twitter login
    } else if (data.type === 'twitter' || data.type === 'farcaster') {
      if (data.type === 'twitter') {
        const userTwitterId = request.session.passport.user._json.id_str;
        if (!userTwitterId) {
          throw new Error(errors.server.INVALID_REQUEST);
        }
        ownData = await userHelper.getUserByAccount("twitter", userTwitterId);
      } else if (data.type === 'farcaster') {
        if (!request.session.farcaster?.fid || !request.session.farcaster?.address) {
          throw new Error(errors.server.INVALID_REQUEST);
        }
        ownData = await userHelper.getUserByAccount("farcaster", request.session.farcaster.fid.toString());
      } else {
        throw new Error("Error in user.ts: Invalid switch value");
      }
      const { device } = data;
      [ communities,
        chats,
        { deviceId },
        unreadNotificationCount,
      ] = await Promise.all([
        communityHelper.getOwnCommunities(ownData.id),
        chatHelper.getChats(ownData.id),
        deviceHelper.createDevice(ownData.id, device.publicKey),
        notificationHelper.getUnreadCount(ownData.id),
      ]);
    } else if (data.type === 'lukso') {
      const { device } = data;
      if (!request.session.lukso) {
        throw new Error(errors.server.INVALID_REQUEST);
      }
      const { lukso } = request.session;
      const secret = request.session.lukso.message.match(new RegExp(`Nonce: ([a-zA-Z0-9]{${SIGNABLE_SECRET_LENGTH}})`))?.[1];
      if (!signSecret || secret !== signSecret) {
        throw new Error(errors.server.INVALID_SECRET);
      }
      const isValidSignature = await onchainHelper.luksoIsValidSignature(lukso.address, lukso.signature, lukso.message);
      if (!isValidSignature) {
        throw new Error(errors.server.INVALID_SIGNATURE);
      }
      ownData = await userHelper.getUserByAccount("lukso", lukso.address);
      [ communities,
        chats,
        { deviceId },
        unreadNotificationCount,
      ] = await Promise.all([
        communityHelper.getOwnCommunities(ownData.id),
        chatHelper.getChats(ownData.id),
        deviceHelper.createDevice(ownData.id, device.publicKey),
        notificationHelper.getUnreadCount(ownData.id),
      ]);
    } else if (data.type === 'passkey-success') {
      const { device } = data;
      const { passkeyData } = request.session;
      if (!passkeyData || passkeyData.step !== "success") {
        throw new Error(errors.server.INVALID_REQUEST);
      }
      const { passkeyId } = passkeyData;
      const passkey = await walletHelper.getPasskeyById(passkeyId);
      if (passkey.deletedAt !== null) {
        throw new Error(errors.server.DELETED);
      }
      if (passkey.userId === null) {
        throw new Error(errors.server.PASSKEY_USER_NULL);
      }
      ownData = await userHelper.getOwnDataById(passkey.userId);
      [ communities,
        chats,
        { deviceId },
        unreadNotificationCount,
      ] = await Promise.all([
        communityHelper.getOwnCommunities(ownData.id),
        chatHelper.getChats(ownData.id),
        deviceHelper.createDevice(ownData.id, device.publicKey),
        notificationHelper.getUnreadCount(ownData.id),
      ]);
      delete request.session.passkeyData;
    } else if (data.type === "verificationCode") {
      const { device } = data;
      ownData = await userHelper.getOwnDataByEmailAndVerificationCode(data.email, data.code);
      [ communities,
        chats,
        { deviceId },
        unreadNotificationCount,
      ] = await Promise.all([
        communityHelper.getOwnCommunities(ownData.id),
        chatHelper.getChats(ownData.id),
        deviceHelper.createDevice(ownData.id, device.publicKey),
        notificationHelper.getUnreadCount(ownData.id),
      ]);
    } else {
      throw new Error(errors.server.INVALID_REQUEST);
    }

    // Update device info
    if (data.type !== 'device') {
      await deviceHelper.updateDeviceInfo(deviceId, {
        deviceBrowser: userAgent.browser.name,
        deviceOS: userAgent.os.name
      });

      await userHelper.setUserExtraDataField(isMobileLogin ? 'usesMobileDevice' : 'usesDesktopDevice', true, ownData.id);
    }

    request.session.user = {
      id: ownData.id,
      deviceId
    };
    delete request.session.signSecret;
    request.session.save();

    const result: API.User.login.Response = {
      ownData,
      communities,
      chats,
      deviceId,
      webPushSubscription,
      unreadNotificationCount,
    };
    return result;
  }
)

registerPostRoute<
  API.User.checkLoginStatus.Request,
  API.User.checkLoginStatus.Response
>(
  userRouter,
  '/checkLoginStatus',
  undefined,
  async (request, response, data) => {
    const { user } = request.session;
    return { userId: user?.id || null }
  }
);

registerPostRoute<
  API.User.logout.Request,
  API.User.logout.Response
>(
  userRouter,
  '/logout',
  undefined,
  async (request, response, data) => {
    const { user } = request.session;
    if (!!user) {
      await deviceHelper.deleteDevice(user.deviceId);
    }
    delete request.session.user;
    delete request.session.passkeyData;
    delete request.session.lukso;
    delete request.session.twitter;
    request.session.save();
  }
);

const createUserRateLimiter = ipRateLimitHandler({
  windowMs: 1000 * 60 * 60 * 24, // 24h
  limit_v4_v6_64: 2,
  limit_v6_56: 8,
  limit_v6_48: 15,
});

registerPostRoute<
  API.User.createUser.Request,
  API.User.createUser.Response
>(
  userRouter,
  '/createUser',
  Validators.API.User.createUser,
  async (request, response, data) => {
    const {
      device,
      displayAccount,
      useTwitterCredentials,
      useLuksoCredentials,
      usePreparedWallet,
      usePreparedPasskey,
      usePreparedFarcaster,
      useCgProfile,
      useEmailAndPassword,
      recaptchaToken,
    } = data;

    if (config.DEPLOYMENT !== 'dev') {
      const verifyResult = await verifyCaptchaToken(recaptchaToken);
      if (!verifyResult) {
        console.error("Error creating user, captcha verification failed", recaptchaToken, data);
        throw new Error(errors.server.CAPTCHA_FAILED);
      }
    }

    // only allowed if logged out
    const { user } = request.session;
    if (!!user) {
      throw new Error(errors.server.ALREADY_LOGGED_IN);
    }

    let loginMethodAdded = false;

    const newUserData: Parameters<typeof userHelper.createUser>[0] = {
      activateNewsletter: false,
      email: null,
      password: null,
      displayAccount,
      devicePublicKey: device.publicKey,
      accounts: [],
    };

    if (
      (displayAccount === "lukso" && !useLuksoCredentials) ||
      (displayAccount === "twitter" && !useTwitterCredentials) ||
      (displayAccount === "cg" && !useCgProfile)
    ) {
      console.error("Error creating user, display account " + displayAccount + " not provided", data);
      throw new Error(errors.server.INVALID_REQUEST);
    }
    
    if (useEmailAndPassword) {
      loginMethodAdded = true;
      newUserData.email = useEmailAndPassword.email;
      newUserData.password = useEmailAndPassword.password;
    }

    if (usePreparedWallet) {
      loginMethodAdded = true;
      const { preparedCredential } = request.session;
      if (!preparedCredential || preparedCredential.type !== "wallet") {
        console.error("Error creating user with prepared wallet, incorrect prepared credential", preparedCredential, data);
        throw new Error(errors.server.INVALID_REQUEST);
      }
      const { result, preWallet } = preparedCredential;
      if (result.readyForCreation && !!preWallet) {
        newUserData.wallet = {
          walletIdentifier: preWallet.walletIdentifier,
          type: preWallet.type,
          signatureData: preWallet.signatureData,
        };
      }
      else {
        console.error("Error creating user with prepared wallet, not ready for creation or no preWallet", data);
        throw new Error(errors.server.INVALID_REQUEST);
      }
    }

    if (usePreparedPasskey) {
      loginMethodAdded = true;
      const { passkeyData } = request.session;
      if (!passkeyData || passkeyData.step !== "success" || passkeyData.userId !== null) {
        console.error("Error creating user with passkey, invalid passkey data", passkeyData, data);
        throw new Error(errors.server.INVALID_REQUEST);
      }
      newUserData.passkeyId = passkeyData.passkeyId;
    }

    if (usePreparedFarcaster) {
      loginMethodAdded = true;
      const { farcaster } = request.session;
      if (!farcaster || !farcaster.fid || !farcaster.address || !farcaster.displayName || !farcaster.username) {
        console.error("Error creating user with prepared farcaster, invalid farcaster data", farcaster, data);
        throw new Error(errors.server.INVALID_REQUEST);
      }
      newUserData.accounts.push({
        type: "farcaster",
        data: {
          type: "farcaster",
          id: farcaster.fid.toString(),
          address: farcaster.address,
        },
        displayName: farcaster.displayName,
        extraData: {
          type: "farcaster",
          fid: farcaster.fid,
          username: farcaster.username,
          bio: farcaster.bio,
          url: farcaster.url,
        },
        imageId: farcaster.imageId,
      });
    }

    if (useCgProfile) {
      newUserData.accounts.push({
        type: "cg",
        displayName: useCgProfile.displayName,
        imageId: useCgProfile.imageId,
        data: null,
        extraData: {
          type: "cg",
          description: "",
          homepage: "",
          links: [],
        },
      });
    }

    if (useTwitterCredentials) {
      loginMethodAdded = true;

      const twitterUserData = request?.session?.passport?.user;

      if (!twitterUserData) {
        throw new Error(errors.server.INVALID_REQUEST);
      }
      let twitterImageId = null;

      // If there's an user image, download it.
      if (twitterUserData._json.profile_image_url) {
        try {
          const fullSizeUrl = twitterUserData._json.profile_image_url.replace("_normal", "");
          const response = await axios.get(fullSizeUrl, { responseType: 'arraybuffer' });
          const buffer = Buffer.from(response.data, "utf-8");
          const image = await fileHelper.saveImage(null, { type: 'userProfileImage' }, buffer, { width: 110, height: 110 });
          twitterImageId = image.fileId;
        } catch (e) {
          // For now just ignore error if this fails, but is this fine for now?
          console.error("Could not download twitter image", e);
        }
      }
      
      newUserData.accounts.push({
        type: "twitter",
        displayName: twitterUserData.username,
        imageId: twitterImageId,
        data: {
          type: 'twitter',
          id: twitterUserData._json.id_str,
          refreshToken: '',
          accessToken: '',
          followersCount: twitterUserData._json.followers_count || 0,
          followingCount: twitterUserData._json.friends_count || 0
        },
        extraData: null,
      });
    }

    if (useLuksoCredentials){
      loginMethodAdded = true;
      const luksoData = request.session.lukso;
      if (!luksoData || luksoData.existsAlready) {
        console.error("Error creating user with lukso credentials, invalid lukso data or already exists", luksoData, data);
        throw new Error(errors.server.INVALID_REQUEST);
      }
      let luksoImageId = null;
      if (luksoData.profileImageUrl) {
        luksoImageId = await getAndStoreUniversalProfileImage(luksoData.profileImageUrl);
      }

      newUserData.accounts.push({
        type: UserProfileTypeEnum.LUKSO,
        displayName: luksoData.username,
        imageId: luksoImageId,
        data: {
          type: 'lukso',
          id: luksoData.address,
        },
        extraData: {
          type: 'lukso',
          upAddress: luksoData.address,
        },
      });
      
      delete request.session.lukso;
    }

    if (!loginMethodAdded) {
      console.error("Error creating user, no login method added", data);
      throw new Error(errors.server.INVALID_REQUEST);
    }

    const insertedIds = await userHelper.createUser(newUserData, async () => {
      // make sure rate limits are respected
      if (config.DEPLOYMENT !== 'dev') {
        await createUserRateLimiter(request, response);
      }
    });

    delete request.session.passkeyData;
    delete request.session.preparedCredential;
    delete request.session.twitter;
    delete request.session.passport;
    delete request.session.lukso;
    delete request.session.farcaster;

    if (!!useCgProfile && !!useCgProfile.imageId) {
      fileHelper.scheduleUserPreviewUpdate(insertedIds.userId, useCgProfile.imageId);
    }
    request.session.user = {
      id: insertedIds.userId,
      deviceId: insertedIds.deviceId,
    };

    const result: API.User.createUser.Response = {
      ownData: {
        id: insertedIds.userId,
        isBot: false,
        onlineStatus: "online",
        communityOrder: [],
        finishedTutorials: [],
        newsletter: false,
        weeklyNewsletter: false,
        dmNotifications: true,
        email: useEmailAndPassword?.email || null,
        followingCount: 0,
        followerCount: 0,
        createdAt: insertedIds.updatedAt,
        updatedAt: insertedIds.updatedAt,
        bannerImageId: null,
        displayAccount: newUserData.displayAccount,
        accounts: newUserData.accounts.map(acc => ({
          type: acc.type,
          displayName: acc.displayName,
          imageId: acc.imageId,
          extraData: acc.extraData,
        })),
        features: {},
        pointBalance: 0,
        trustScore: '1.0',
        premiumFeatures: [],
        emailVerified: false,
        passkeys: insertedIds.passkeyData ? [insertedIds.passkeyData] : [],
        extraData: {},
        tags: null,
      },
      deviceId: insertedIds.deviceId,
      webPushSubscription: null,
      communities: [],
      unreadNotificationCount: 0,
      chats: [],
    }

    if(useEmailAndPassword?.email){
      try {
        const verificationToken = await emailHelper.generateVerificationEmailToken(insertedIds.userId);
        await emailUtils.sendVerificationEmail(useEmailAndPassword.email, verificationToken, request.hostname);
      } catch (error) {
        console.error('Error sending verification email', error);
        //notify user that email could not be sent
      }
    }
    return result;
  }
);

registerPostRoute<
  API.User.updateOwnData.Request,
  API.User.updateOwnData.Response
>(
  userRouter,
  '/updateOwnData',
  Validators.API.User.updateOwnData,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await userHelper.updateUser(user.id, data);
  }
);

registerPostRoute<
  API.User.setOwnExtraDataField.Request,
  API.User.setOwnExtraDataField.Response
>(
  userRouter,
  '/setOwnExtraDataField',
  Validators.API.User.setOwnExtraDataField,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await userHelper.setUserExtraDataField(data.key, data.value, user.id);
  }
);

registerPostRoute<
  API.User.addUserAccount.Request,
  API.User.addUserAccount.Response
>(
  userRouter,
  '/addUserAccount',
  Validators.API.User.addUserAccount as any,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }

    if (data.type === 'twitter') {
      const twitterUserData = request?.session?.passport?.user;

      if (!twitterUserData) {
        throw new Error(errors.server.INVALID_REQUEST);
      }
      
      let twitterImageId = null;

      // If there's an user image, download it.
      if (twitterUserData._json.profile_image_url) {
        try {
          const fullSizeUrl = twitterUserData._json.profile_image_url.replace("_normal", "");
          const response = await axios.get(fullSizeUrl, { responseType: 'arraybuffer' });
          const buffer = Buffer.from(response.data, "utf-8");
          const image = await fileHelper.saveImage(null, { type: 'userProfileImage' }, buffer, { width: 110, height: 110 });
          twitterImageId = image.fileId;
        } catch (e) {
          // For now just ignore error if this fails, but is this fine for now?
          console.error("Could not download twitter image", e);
        }
      }
      
      const twitterAccount: CreateUserAccountData = {
        type: UserProfileTypeEnum.TWITTER,
        displayName: twitterUserData.username,
        imageId: twitterImageId,
        data: {
          type: 'twitter',
          id: twitterUserData._json.id_str,
          refreshToken: '',
          accessToken: '',
          followersCount: twitterUserData._json.followers_count || 0,
          followingCount: twitterUserData._json.friends_count || 0
        },
        extraData: null,
      }

      await userHelper.addUserAccount(user.id, twitterAccount);
      delete request.session.twitter;

    } else if (data.type === 'lukso') {
      if (!request.session.lukso) {
        throw new Error(errors.server.INVALID_REQUEST);
      }

      const { address, profileImageUrl, username } = request.session.lukso;
      let luksoImageId: string | null = null;
      if (profileImageUrl) {
        luksoImageId = await getAndStoreUniversalProfileImage(profileImageUrl);
      }

      const luksoAccount: CreateUserAccountData = {
        type: "lukso",
        displayName: username,
        imageId: luksoImageId,
        data: {
          type: 'lukso',
          id: address,
        },
        extraData: {
          type: 'lukso',
          upAddress: address,
        },
      }

      await userHelper.addUserAccount(user.id, luksoAccount);
      delete request.session.lukso;

    } else if (data.type === 'farcaster') {
      const { farcaster } = request.session;
      if (!farcaster) {
        throw new Error(errors.server.INVALID_REQUEST);
      }

      const { fid, address, username, displayName, imageId, readyForCreation, bio, url } = farcaster;
      if (!readyForCreation) {
        throw new Error(errors.server.EXISTS_ALREADY);
      }

      const farcasterAccount: CreateUserAccountData = {
        type: "farcaster",
        displayName,
        imageId,
        data: {
          type: 'farcaster',
          id: fid.toString(),
          address,
        },
        extraData: {
          type: 'farcaster',
          fid,
          username,
          bio,
          url,
        },
      };

      await userHelper.addUserAccount(user.id, farcasterAccount);
      delete request.session.farcaster;

    } else if (data.type === "cg") {
      const cgProfile: CreateUserAccountData = {
        type: "cg",
        displayName: data.displayName,
        imageId: null,
        data: null,
        extraData: {
          type: "cg",
          description: data.description || "",
          homepage: data.homepage || "",
          links: data.links || [],
        },
      };
      await userHelper.addUserAccount(user.id, cgProfile);

    } else {
      throw new Error(errors.server.INVALID_REQUEST);
    }
  }
);

registerPostRoute<
  API.User.updateUserAccount.Request,
  API.User.updateUserAccount.Response
>(
  userRouter,
  '/updateUserAccount',
  Validators.API.User.updateUserAccount,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await userHelper.updateCgProfile(user.id, data);
  }
);

registerPostRoute<
  API.User.removeUserAccount.Request,
  API.User.removeUserAccount.Response
>(
  userRouter,
  '/removeUserAccount',
  Validators.API.User.removeUserAccount,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }

    await userHelper.removeUserAccount(user.id, data.type as UserProfileTypeEnum);
  }
);

registerPostRoute<
  API.User.prepareWalletAction.Request,
  API.User.prepareWalletAction.Response
>(
  userRouter,
  '/prepareWalletAction',
  Validators.API.User.prepareWalletAction,
  async (request, response, data) => {
    const { secret } = data.data;
    if (!secret || secret !== request.session.signSecret) {
      throw new Error(errors.server.INVALID_SECRET);
    }
    delete request.session.signSecret;
    const preparedWalletCredential = await walletHelper.prepareWalletAction(data, request.session.user?.id || null);
    request.session.preparedCredential = preparedWalletCredential;
    await new Promise(resolve => request.session.save(resolve));
    return preparedWalletCredential.result;
  }
);

registerPostRoute<
  API.User.addPreparedWallet.Request,
  API.User.addPreparedWallet.Response
>(
  userRouter,
  '/addPreparedWallet',
  Validators.API.User.addPreparedWallet,
  async (request, response, data) => {
    try {
      const { user, preparedCredential } = request.session;
      if (!user) {
        throw new Error(errors.server.LOGIN_REQUIRED);
      }
      if (!preparedCredential) {
        throw new Error(errors.server.INVALID_REQUEST);
      }

      const { result, type, preWallet } = preparedCredential;
      if (type === "wallet" && result.readyForCreation && !!preWallet) {
        if (preWallet.type === 'cg_evm') {
          throw new Error(errors.server.NOT_SUPPORTED);
        }

        preWallet.loginEnabled = data.loginEnabled;
        preWallet.visibility = data.visibility;
        const wallet = await walletHelper.createWallet(user.id, preWallet);

        const event: Events.User.Wallet = {
          type: "cliWalletEvent",
          action: "new",
          data: wallet,
        };
        eventHelper.emit(event, {
          userIds: [user.id]
        });
      }
      else {
        throw new Error(errors.server.INVALID_REQUEST);
      }
    }
    finally {
      delete request.session.preparedCredential;
    }
  }
);

registerPostRoute<
  API.User.updateWallet.Request,
  API.User.updateWallet.Response
>(
  userRouter,
  '/updateWallet',
  Validators.API.User.updateWallet,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await walletHelper.updateWallet(user.id, data);

    const event: Events.User.Wallet = {
      type: "cliWalletEvent",
      action: "update",
      data,
    };
    eventHelper.emit(event, {
      userIds: [user.id]
    });
  }
);

registerPostRoute<
  API.User.deleteWallet.Request,
  API.User.deleteWallet.Response
>(
  userRouter,
  '/deleteWallet',
  Validators.API.User.deleteWallet,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await walletHelper.deleteWallet(user.id, data);

    const event: Events.User.Wallet = {
      type: "cliWalletEvent",
      action: "delete",
      data,
    };
    eventHelper.emit(event, {
      userIds: [user.id]
    });
  }
);

registerPostRoute<
  API.User.getWallets.Request,
  API.User.getWallets.Response
>(
  userRouter,
  '/getWallets',
  Validators.API.User.getWallets,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    if (!!data.userId && user.id !== data.userId) {
      // Querying other user's wallets is disabled
      // for now. Requirements for this:
      // - remove loginEnabled and signatureData properties
      // - make sure to only return wallets which are visible,
      //   i.e. either public or follower relationship, if exists

      throw new Error(errors.server.NOT_ALLOWED);
    }
    return await walletHelper.getAllWalletsByUserId(data.userId || user.id, ["evm", "cg_evm"]);
  }
);

registerPostRoute<
  API.User.getUserData.Request,
  API.User.getUserData.Response
>(
  userRouter,
  '/getUserData',
  Validators.API.User.getUserData,
  async (request, response, data) => {
    const { user } = request.session;
    return await userHelper.getUserDataByIds(data.userIds, user?.id);
  },
  { limit: '1mb' },
);

registerPostRoute<
  API.User.getUserProfileDetails.Request,
  API.User.getUserProfileDetails.Response
>(
  userRouter,
  '/getUserProfileDetails',
  Validators.API.User.getUserProfileDetails,
  async (request, response, data) => {
    const { user } = request.session;
    return await userHelper.getUserProfileDetails(data.userId, user?.id);
  }
);

registerPostRoute<
  API.User.setOwnStatus.Request,
  API.User.setOwnStatus.Response
>(
  userRouter,
  '/setOwnStatus',
  Validators.API.User.setOwnStatus,
  async (request, response, data) => {
    // todo
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await redisManager.userData.setUserData(user.id, { status: data.status });
  }
);

registerPostRoute<
  API.User.isCgProfileNameAvailable.Request,
  API.User.isCgProfileNameAvailable.Response
>(
  userRouter,
  '/isCgProfileNameAvailable',
  Validators.API.User.isCgProfileNameAvailable,
  async (request, response, data) => {
    return await userHelper.isCgProfileNameAvailable(data.displayName);
  }
);

registerPostRoute<
  API.User.isEmailAvailable.Request,
  API.User.isEmailAvailable.Response
>(
  userRouter,
  '/isEmailAvailable',
  Validators.API.User.isEmailAvailable,
  async (request, response, data) => {
    return await userHelper.isEmailAvailable(data.email);
  }
);

registerPostRoute<
  API.User.setPassword.Request,
  API.User.setPassword.Response
>(
  userRouter,
  '/setPassword',
  Validators.API.User.setPassword,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await userHelper.setPassword(user.id, data.password);
  }
);

registerPostRoute<
  API.User.subscribeNewsletter.Request,
  API.User.subscribeNewsletter.Response
>(
  userRouter,
  '/subscribeNewsletter',
  validators.API.User.subscribeNewsletter,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await userHelper.subscribeNewsletter(user.id, data.email);
  }
);

registerPostRoute<
  API.User.unsubscribeNewsletter.Request,
  API.User.unsubscribeNewsletter.Response
>(
  userRouter,
  '/unsubscribeNewsletter',
  validators.API.User.unsubscribeNewsletter,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await userHelper.unsubscribeNewsletter(user.id, data.email);
  }
);

registerPostRoute<
  API.User.followUser.Request,
  API.User.followUser.Response
>(
  userRouter,
  '/followUser',
  validators.API.User.followUser,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasTrustOrThrow({ userId: user.id, trust: '1.0' });
    await userHelper.followUser(user.id, data.userId);
    
    const followerEvent: Events.User.Data = {
      type: "cliUserData",
      data: {
        id: data.userId,
        isFollowed: true,
      },
    };
    const followedEvent: Events.User.Data = {
      type: "cliUserData",
      data: {
        id: user.id,
        isFollower: true,
      },
    };
    eventHelper.emit(followerEvent, {
      userIds: [user.id],
    });
    eventHelper.emit(followedEvent, {
      userIds: [data.userId],
    });
  }
);

registerPostRoute<
  API.User.unfollowUser.Request,
  API.User.unfollowUser.Response
>(
  userRouter,
  '/unfollowUser',
  validators.API.User.unfollowUser,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await userHelper.unfollowUser(user.id, data.userId);
    const followerEvent: Events.User.Data = {
      type: "cliUserData",
      data: {
        id: data.userId,
        isFollowed: false,
      },
    };
    const followedEvent: Events.User.Data = {
      type: "cliUserData",
      data: {
        id: user.id,
        isFollower: false,
      },
    };
    eventHelper.emit(followerEvent, {
      userIds: [user.id],
    });
    eventHelper.emit(followedEvent, {
      userIds: [data.userId],
    });
  }
);

registerPostRoute<
  API.User.getArticleList.Request,
  API.User.getArticleList.Response
>(
  userRouter,
  '/getArticleList',
  validators.API.User.getArticleList,
  async (request, response, data) => {
    const { user } = request.session;
    if (data.drafts) {
      if (!user) {
        throw new Error(errors.server.LOGIN_REQUIRED);
      }
      if (user.id !== data.userId) {
        console.error("drafts can only be retrieved with own userId as parameter");
        throw new Error(errors.server.INVALID_REQUEST);
      }
    }
    if (data.followingOnly) {
      if (!user) {
        throw new Error(errors.server.LOGIN_REQUIRED);
      }
    }
    const result = await articleHelper.getUserArticleList(user?.id, data);
    return result;
  }
);

registerPostRoute<
  API.User.getArticleDetailView.Request,
  API.User.getArticleDetailView.Response
>(
  userRouter,
  '/getArticleDetailView',
  validators.API.User.getArticleDetailView as any, // Todo: Fix type problem
  async (request, response, data) => {
    const { user } = request.session;
    const result = await articleHelper.getUserArticleDetailView(user?.id, data);
    const { article, ...userArticle } = result;
    return {
      userArticle,
      article
    }
  }
);

registerPostRoute<
  API.User.createArticle.Request,
  API.User.createArticle.Response
>(
  userRouter,
  '/createArticle',
  validators.API.User.createArticle,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const result = await articleHelper.createUserArticle(user.id, data);
    const article: Models.BaseArticle.DetailView = {
      ...data.article,
      articleId: result.articleId,
      creatorId: user.id,
      channelId: result.channelId,
      commentCount: 0,
      latestCommentTimestamp: null,
    }
    const userArticle = {
      ...data.userArticle,
      updatedAt: result.updatedAt,
      userId: user.id,
      published: null,
      articleId: result.articleId
    }
    return {
      userArticle,
      article
    }
  }
);

registerPostRoute<
  API.User.updateArticle.Request,
  API.User.updateArticle.Response
>(
  userRouter,
  '/updateArticle',
  validators.API.User.updateArticle,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const result = await articleHelper.updateUserArticle(user.id, data);
    return {
      userArticle: {
        updatedAt: result.updatedAt
      }
    }
  }
);

registerPostRoute<
  API.User.deleteArticle.Request,
  API.User.deleteArticle.Response
>(
  userRouter,
  '/deleteArticle',
  validators.API.User.deleteArticle,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await articleHelper.deleteUserArticle(user.id, data);
  }
);

registerPostRoute<
  API.User.getFollowers.Request,
  API.User.getFollowers.Response
>(
  userRouter,
  '/getFollowers',
  validators.API.User.getFollowers,
  async (request, response, data) => {
    return await userHelper.getFollowers(data.userId, data.limit || 15, data.offset);
  }
);

registerPostRoute<
  API.User.getFollowing.Request,
  API.User.getFollowing.Response
>(
  userRouter,
  '/getFollowing',
  validators.API.User.getFollowing,
  async (request, response, data) => {
    return await userHelper.getFollowing(data.userId, data.limit || 15, data.offset);
  }
);

registerPostRoute<
  API.User.getFriends.Request,
  API.User.getFriends.Response
>(
  userRouter,
  '/getFriends',
  validators.API.User.getFriends,
  async (request, response, data) => {
    return await userHelper.getFriends(data.userId, data.limit || 15, data.offset);
  }
);

registerPostRoute<
  API.User.buyUserPremiumFeature.Request,
  API.User.buyUserPremiumFeature.Response
>(
  userRouter,
  '/buyUserPremiumFeature',
  validators.API.User.buyUserPremiumFeature,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    return await userHelper.buyUserPremiumFeature(user.id, data);
  }
);

registerPostRoute<
  API.User.setPremiumFeatureAutoRenew.Request,
  API.User.setPremiumFeatureAutoRenew.Response
>(
  userRouter,
  '/setPremiumFeatureAutoRenew',
  validators.API.User.setPremiumFeatureAutoRenew,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    return await userHelper.setPremiumFeatureAutoRenew(user.id, data);
  }
);

registerPostRoute<
  API.User.getUserCommunityIds.Request,
  API.User.getUserCommunityIds.Response
>(
  userRouter,
  '/getUserCommunityIds',
  validators.API.User.getUserCommunityIds,
  async (request, response, data) => {
    return await userHelper.getUserCommunityIds(data.userId);
  }
);

registerPostRoute<
  API.User.getTransactionData.Request,
  API.User.getTransactionData.Response
>(
  userRouter,
  '/getTransactionData',
  undefined,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    return await userHelper.getTransactionData(user.id);
  }
);

registerPostRoute<
  API.User.requestEmailVerification.Request,
  API.User.requestEmailVerification.Response
>(
  userRouter,
  '/requestEmailVerification',
  validators.API.User.requestEmailVerification,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    // avoid generating multiple tokens if the existing one is still valid
    const token = await emailHelper.generateVerificationEmailToken(user.id);
    try {
      await emailUtils.sendVerificationEmail(data.email, token, request.hostname);
    } catch (error) {
      console.error(error);
    }
  }
);

registerPostRoute<
  API.User.verifyEmail.Request,
  API.User.verifyEmail.Response
>(
  userRouter,
  '/verifyEmail',
  validators.API.User.verifyEmail,
  async (request, response, data) => {
    const userId = await emailHelper.verifyEmail(data.email, data.token);
    if (userId) {
      const event: Events.User.OwnData = {
        type: "cliUserOwnData",
        data: {
          emailVerified: true,
        },
      };
      eventHelper.emit(event, {
        userIds: [userId]
      });
    }
  }
);

registerPostRoute<
  API.User.sendOneTimePasswordForLogin.Request,
  API.User.sendOneTimePasswordForLogin.Response
>(
  userRouter,
  '/sendOneTimePasswordForLogin',
  validators.API.User.sendOneTimePasswordForLogin,
  async (request, response, data) => {
    const { user } = request.session;
    if (user) {
      throw new Error(errors.server.ALREADY_LOGGED_IN);
    }
    if (!emailEnabled()) {
      // tell the client honestly instead of pretending a code was sent
      throw new Error(errors.server.EMAIL_DISABLED);
    }
    const { email } = data;
    const userId = await userHelper.getUserIdByEmail(email);
    const otp = await emailHelper.generateVerificationEmailToken(userId);
    try {
      await emailUtils.sendOneTimePasswordEmail(email, otp);
    } catch (error) {
      console.error(error);
    }
  }
);

export default userRouter;

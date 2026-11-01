// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from "express";
import redisManager from '../redis';
import { UAParser } from "ua-parser-js";
import { getDisplayNameString, randomString } from "../util";
import errors from "../common/errors";
import { UserProfileTypeEnum } from "../common/enums";
import Validators from "../validators";
import userHelper, { CreateUserAccountData } from "../repositories/users";
import { LOGIN_ACCOUNT_TYPES } from "../repositories/loginMethods";
import suggestedUsersHelper from "../repositories/suggestedUsers";
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
import { fetchRemoteImage } from "../util/safeFetch";
import onchainHelper from "../repositories/onchain";
import permissionHelper from "../repositories/permissions";
import ipRateLimitHandler, { clientPrefixKey, failureBudget, ipFailureLimiter, reserveFailures, type FailureReservation } from "../util/rateLimit";
import { AUTH_LIMITS } from "../util/authLimits";
import config from "../common/config";
import { verifyCaptchaToken } from "../util/captcha";
import emailUtils, { emailEnabled } from "./emails";
import { registerEmailUnsubscribeRoutes } from "./emailUnsubscribe";
import { limitOneTimePasswordMail, limitSignupCodeMail, limitVerificationMail } from "../util/mailSendLimits";
import passkeyHelper from "../repositories/passkeys";
import { keyRateLimitHandler } from "../util/rateLimit";
import { getMainRp, getProcessRpIdOrNull, isLegacyCgidMode } from "../util/passkeyConfig";
import { verifyAuthentication } from "../util/passkeys";
import { ADD_SIGN_IN_METHOD_AUTH, endLoginSession, establishLoginSession, hasRecentAuth, recordReauthentication, requireRecentAuth, stepUpValidUntil, type AuthMethod } from "../util/authSession";
import {
  SIGNUP_CODE_MAX_ATTEMPTS,
  SIGNUP_CODE_TTL_MS,
  checkSignupEmailCode,
  getVerifiedSignupEmail,
  hasSignupCaptcha,
  normalizeEmail,
  startSignupEmailVerification,
  startSignupWithoutCode,
  verifiedSignupPassedCaptcha,
} from "../util/signupEmail";
import { notifyEmailChanged, notifyNewSignInMethod, notifyPasswordChanged } from "../util/signInNotice";
import { computeSecurityStatus, computeSecurityStatusVersioned, rememberSecurityStepClear, requireAuthToAdd, SECURITY_STEP_AUTH_MAX_AGE_MS, securityStepEnforced } from "../util/securityStep";
import { consumeEmailCode, EMAIL_CODE_MAX_ATTEMPTS, getPendingEmail, issueEmailCode, VERIFY_CODE_TTL_MS } from "../util/emailCodes";
import transferTokenHelper from "../repositories/transferTokens";
import {
  getTransferTargetOrigin,
  TRANSFER_LINK_TTL_MS,
  transferLinkUrl,
  transferNextPath,
} from "../util/transferLink";

export const SIGNABLE_SECRET_LENGTH = 20;

const userRouter = express.Router();

// Like the sign-up limit, the login throttles are off on a dev stack. The
// conformance suite runs against a disposable instance with DEPLOYMENT=prod:
// each of its clients claims its own address and it signs in a few times per
// account, so the limits do not get in its way. The per-code guess budget of
// email codes always applies. Numbers: srv/util/authLimits.ts.
const LOGIN_LIMITS = config.DEPLOYMENT !== 'dev';

// Password login (docs/auth-identity §5.4): attempts per client IP, and failed
// attempts per identifier — from the client's network, and from everywhere.
// Keyed by the identifier as typed, never by the account it names (see
// srv/util/authLimits.ts).
const passwordLoginIpLimiter = ipRateLimitHandler({
  bucket: 'user:login:password:ip',
  ...AUTH_LIMITS.passwordLogin.ip,
});
const passwordLoginFailures = {
  perNetwork: failureBudget({ bucket: 'user:login:password:identifier-network', ...AUTH_LIMITS.passwordLogin.identifierFailuresPerNetwork }),
  all: failureBudget({ bucket: 'user:login:password:identifier', ...AUTH_LIMITS.passwordLogin.identifierFailures }),
};

// Email login code (§5.5): attempts per client IP, failed guesses per address
// (from the client's network, and from everywhere), plus a budget per code.
const loginCodeIpLimiter = ipRateLimitHandler({
  bucket: 'user:login:code:ip',
  ...AUTH_LIMITS.codeLogin.ip,
});
const loginCodeFailures = {
  perNetwork: failureBudget({ bucket: 'user:login:code:identifier-network', ...AUTH_LIMITS.codeLogin.identifierFailuresPerNetwork }),
  all: failureBudget({ bucket: 'user:login:code:identifier', ...AUTH_LIMITS.codeLogin.identifierFailures }),
};
// guesses per issued code (login and email verification); a code is dead once
// its attempts are spent
const emailCodeAttemptLimiter = keyRateLimitHandler({
  bucket: 'user:email-code:attempts',
  windowMs: VERIFY_CODE_TTL_MS,
  limit: EMAIL_CODE_MAX_ATTEMPTS,
});

/**
 * Counts this login attempt as a failure up front, in both budgets of the
 * typed identifier (atomic, so parallel attempts cannot overrun them); the
 * caller releases the reservation unless the attempt failed for a wrong
 * password or code.
 */
async function reserveLoginFailure(
  request: express.Request,
  budgets: typeof passwordLoginFailures,
  identifier: string,
): Promise<FailureReservation> {
  if (!LOGIN_LIMITS) {
    return { release: async () => undefined };
  }
  const key = identifier.trim().toLowerCase();
  return reserveFailures([
    { budget: budgets.perNetwork, key: `${key}|${clientPrefixKey(request)}` },
    { budget: budgets.all, key },
  ]);
}

// Transfer links (§11)
const transferCreateUserLimiter = keyRateLimitHandler({
  bucket: 'user:transfer:create:user',
  ...AUTH_LIMITS.transfer.createPerUser,
});
const transferRedeemIpLimiter = ipRateLimitHandler({
  bucket: 'user:transfer:redeem:ip',
  ...AUTH_LIMITS.transfer.ip,
});
const transferFailureLimiter = ipFailureLimiter({
  bucket: 'user:transfer:redeem',
  ...AUTH_LIMITS.transfer.ipFailures,
});
// instance-wide: many failed redemptions are worth a log line (once per window)
const transferFailureAlarm = keyRateLimitHandler({
  bucket: 'user:transfer:failures:all',
  ...AUTH_LIMITS.transfer.alarm,
});
let transferAlarmLoggedAt = 0;

async function recordTransferFailure(request: express.Request) {
  await transferFailureLimiter.recordFailure(request);
  try {
    await transferFailureAlarm('all');
  }
  catch (e) {
    const { windowMs, limit } = AUTH_LIMITS.transfer.alarm;
    if (e instanceof Error && e.message === errors.server.RATE_LIMIT_EXCEEDED && Date.now() - transferAlarmLoggedAt > windowMs) {
      transferAlarmLoggedAt = Date.now();
      console.warn(`[security] more than ${limit} failed transfer-link redemptions within ${windowMs / 60000} minutes`);
    }
  }
}

const isEmailAvailableLimiter = ipRateLimitHandler({
  bucket: 'user:isEmailAvailable:ip',
  ...AUTH_LIMITS.isEmailAvailable.ip,
});

/** whether the account must finish the security step (login responses) */
async function securityStepRequiredAfterLogin(request: express.Request, userId: string): Promise<boolean> {
  if (!securityStepEnforced()) {
    return false;
  }
  const { status, version } = await computeSecurityStatusVersioned(userId, { emailRequired: emailEnabled() });
  if (!status.required) {
    rememberSecurityStepClear(request, userId, version);
  }
  return status.required;
}

async function getAndStoreUniversalProfileImage(profileImageUrl: string): Promise<string | null> {
  try {
    const imageUrl =
      profileImageUrl.startsWith("ipfs://") 
      ? `https://ipfs.io/ipfs/${profileImageUrl.split('ipfs://').pop()}`
      : profileImageUrl.replace("_normal", "");
    const buffer = await fetchRemoteImage(imageUrl, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36' });
    const image = await fileHelper.saveImage(null, { type: 'userProfileImage' }, buffer, { width: 110, height: 110 });
    return image.fileId;
  } catch (e) {
    // For now just ignore error if this fails, but is this fine for now?
    console.error("Could not download lukso image", e instanceof Error ? e.message : e);
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
      if (LOGIN_LIMITS) {
        await passwordLoginIpLimiter(request, response);
      }
      const candidateId = await userHelper.findPasswordLoginUserId(aliasOrEmail);
      const reservation = await reserveLoginFailure(request, passwordLoginFailures, aliasOrEmail);
      try {
        // rehashes an old hash; marks a password below the policy for a change
        ownData = await userHelper.checkPasswordLogin(candidateId, password);
      }
      catch (e) {
        // a wrong password stays counted; anything else was no guess
        if (!(e instanceof Error && e.message === errors.server.NOT_ALLOWED)) {
          await reservation.release();
        }
        throw e;
      }
      await reservation.release();
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
    } else if (data.type === 'passkey') {
      if (isLegacyCgidMode()) {
        throw new Error(errors.server.NOT_SUPPORTED);
      }
      const { device } = data;
      const passkey = await verifyAuthentication(getMainRp(), request.session, data.authenticationResponse, {
        purpose: 'login',
        userId: null,
      });
      if (passkey.userId === null) {
        throw new Error(errors.server.NOT_FOUND);
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
    } else if (data.type === 'passkey-success') {
      // legacy CG ID mode only: redeems the assertion the CgId router verified
      if (!isLegacyCgidMode()) {
        throw new Error(errors.server.NOT_SUPPORTED);
      }
      const { device } = data;
      const { passkeyData } = request.session;
      delete request.session.passkeyData;
      if (!passkeyData || passkeyData.step !== "success" || !(passkeyData.expiresAt > Date.now())) {
        throw new Error(errors.server.INVALID_REQUEST);
      }
      const passkey = await passkeyHelper.getByIdAnyRp(passkeyData.passkeyId);
      if (!passkey) {
        throw new Error(errors.server.NOT_FOUND);
      }
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
    } else if (data.type === "verificationCode") {
      const { device } = data;
      if (LOGIN_LIMITS) {
        await loginCodeIpLimiter(request, response);
      }
      // codes only ever go to verified addresses (sendOneTimePasswordForLogin)
      const userId = await userHelper.getVerifiedUserIdByEmail(data.email);
      const reservation = await reserveLoginFailure(request, loginCodeFailures, data.email);
      try {
        if (!userId) {
          throw new Error(errors.server.VERIFY_EMAIL_INVALID_TOKEN);
        }
        // an exhausted code answers like a wrong one (emailCodes.ts), so the
        // answer never tells whether a code was sent to the address
        await consumeEmailCode('login', userId, data.email, data.code,
          codeId => emailCodeAttemptLimiter(`login:${codeId}`));
      }
      catch (e) {
        // a wrong, used-up or expired code stays counted; anything else was no guess
        const guess = e instanceof Error && (
          e.message === errors.server.VERIFY_EMAIL_INVALID_TOKEN || e.message === errors.server.VERIFY_EMAIL_EXPIRED_TOKEN
        );
        if (!guess) {
          await reservation.release();
        }
        throw e;
      }
      await reservation.release();
      if (!userId) {
        throw new Error(errors.server.VERIFY_EMAIL_INVALID_TOKEN);
      }
      ownData = await userHelper.getOwnDataById(userId);
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

    // new session id, user set, authentication time recorded (not for a
    // device-key login), awaited save
    const method: AuthMethod | 'device' = data.type === 'passkey-success' ? 'passkey' : data.type;
    await establishLoginSession(request, { userId: ownData.id, deviceId, method });

    const result: API.User.login.Response = {
      ownData,
      communities,
      chats,
      deviceId,
      webPushSubscription,
      unreadNotificationCount,
      securityStepRequired: await securityStepRequiredAfterLogin(request, ownData.id),
      stepUpValidUntil: stepUpValidUntil(request),
    };
    return result;
  }
)

registerPostRoute<
  API.User.ensureSession.Request,
  API.User.ensureSession.Response
>(
  userRouter,
  '/ensureSession',
  Validators.API.User.ensureSession,
  async (request) => {
    // Session keepalive (the web app calls it every 29 minutes). Nothing to
    // do: every response refreshes an existing session's store TTL, and the
    // cookie of a logged-in one (srv/util/sessionSetup.ts). It stores nothing,
    // so it never creates or rewrites a session — it may run in parallel with
    // a login.
  }
);

const reauthenticateIpLimiter = ipRateLimitHandler({
  bucket: 'user:reauthenticate:ip',
  windowMs: 15 * 60 * 1000,
  limit_v4_v6_64: 30,
  limit_v6_56: 90,
  limit_v6_48: 180,
});
const reauthenticateUserLimiter = keyRateLimitHandler({
  bucket: 'user:reauthenticate:user',
  windowMs: 15 * 60 * 1000,
  limit: 10,
});
/** a wallet signature older than this does not count as re-authentication */
const REAUTH_WALLET_PROOF_MAX_AGE_MS = 5 * 60 * 1000;

registerPostRoute<
  API.User.reauthenticate.Request,
  API.User.reauthenticate.Response
>(
  userRouter,
  '/reauthenticate',
  Validators.API.User.reauthenticate,
  async (request, response, data) => {
    // Proves again that the person at the keyboard controls the account, with
    // a passkey, the password or a login-enabled wallet (the same methods the
    // account can sign in with). Refreshes the session's authentication time
    // for sensitive actions (requireRecentAuth).
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await reauthenticateIpLimiter(request, response);
    await reauthenticateUserLimiter(user.id);

    if (data.type === 'passkey') {
      if (isLegacyCgidMode()) {
        throw new Error(errors.server.NOT_SUPPORTED);
      }
      await verifyAuthentication(getMainRp(), request.session, data.authenticationResponse, {
        purpose: 'stepup',
        userId: user.id,
      });
    }
    else if (data.type === 'password') {
      if (!(await userHelper.isPasswordCorrect(user.id, data.password))) {
        throw new Error(errors.server.NOT_ALLOWED);
      }
    }
    else if (data.type === 'wallet') {
      const { preparedCredential } = request.session;
      delete request.session.preparedCredential;
      if (
        !preparedCredential ||
        preparedCredential.type !== 'wallet' ||
        !preparedCredential.result.readyForLogin ||
        preparedCredential.ownerId !== user.id ||
        typeof preparedCredential.createdAt !== 'number' ||
        Date.now() - preparedCredential.createdAt > REAUTH_WALLET_PROOF_MAX_AGE_MS
      ) {
        throw new Error(errors.server.NOT_ALLOWED);
      }
    }
    else {
      throw new Error(errors.server.INVALID_REQUEST);
    }
    const validUntil = await recordReauthentication(request, data.type);
    return { validUntil };
  }
);

registerPostRoute<
  API.User.requestSignupEmailCode.Request,
  API.User.requestSignupEmailCode.Response
>(
  userRouter,
  '/requestSignupEmailCode',
  validators.API.User.requestSignupEmailCode,
  async (request, response, data) => {
    // step 1 of sign-up: mail a code to the address the account will get
    const { user } = request.session;
    if (user) {
      throw new Error(errors.server.ALREADY_LOGGED_IN);
    }
    if (!emailEnabled()) {
      throw new Error(errors.server.EMAIL_DISABLED);
    }
    // the sign-up captcha is solved here, before any mail goes out; a resend
    // for the same address within the captcha window needs no new one
    let captchaAt: number;
    if (hasSignupCaptcha(request.session, data.email)) {
      captchaAt = request.session.signupEmail!.captchaAt!;
    }
    else {
      if (config.DEPLOYMENT !== 'dev') {
        const verified = !!data.recaptchaToken && await verifyCaptchaToken(data.recaptchaToken);
        if (!verified) {
          throw new Error(errors.server.CAPTCHA_FAILED);
        }
      }
      captchaAt = Date.now();
    }
    await limitSignupCodeMail(request, response, data.email);
    try {
      if (await userHelper.isEmailAvailable(data.email)) {
        const code = startSignupEmailVerification(request.session, data.email, Date.now(), captchaAt);
        await emailUtils.sendSignupCodeEmail(data.email, code);
      }
      else {
        // same response either way (also for a resend); the owner of the
        // address learns about the attempt instead of receiving a code
        startSignupWithoutCode(request.session, data.email, Date.now(), captchaAt);
        await emailUtils.sendSignupAddressTakenEmail(data.email);
      }
    }
    catch (error) {
      console.error("Error sending the sign-up code mail", error instanceof Error ? error.message : error);
    }
  }
);

// atomic attempt budget per issued sign-up code (Redis): parallel guesses
// against one session state cannot exceed it
const signupCodeAttemptLimiter = keyRateLimitHandler({
  bucket: 'user:signup-code:attempts',
  windowMs: SIGNUP_CODE_TTL_MS,
  limit: SIGNUP_CODE_MAX_ATTEMPTS,
});

registerPostRoute<
  API.User.verifySignupEmailCode.Request,
  API.User.verifySignupEmailCode.Response
>(
  userRouter,
  '/verifySignupEmailCode',
  validators.API.User.verifySignupEmailCode,
  async (request, response, data) => {
    const { user } = request.session;
    if (user) {
      throw new Error(errors.server.ALREADY_LOGGED_IN);
    }
    const codeId = request.session.signupEmail?.codeId;
    if (codeId) {
      await signupCodeAttemptLimiter(`${request.sessionID}:${codeId}`);
    }
    checkSignupEmailCode(request.session, data.email, data.code);
  }
);

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
    // the session is destroyed and its id revoked: nothing of it (user,
    // step-up state, ceremonies, provider data) survives, and no new one
    // takes its place
    await endLoginSession(request);
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

    // A sign-up that went through the email code solved its captcha there
    // (requestSignupEmailCode, bound to the verified address); every other
    // path (no mail, legacy CG ID mode) sends a fresh token here.
    const captchaCovered = !isLegacyCgidMode() && emailEnabled() && verifiedSignupPassedCaptcha(request.session);
    if (config.DEPLOYMENT !== 'dev' && !captchaCovered) {
      const verifyResult = !!recaptchaToken && await verifyCaptchaToken(recaptchaToken);
      if (!verifyResult) {
        // never log the request: it can carry a password
        console.error("Error creating user: captcha verification failed");
        throw new Error(errors.server.CAPTCHA_FAILED);
      }
    }

    // only allowed if logged out
    const { user } = request.session;
    if (!!user) {
      throw new Error(errors.server.ALREADY_LOGGED_IN);
    }

    const legacyMode = isLegacyCgidMode();
    if (!legacyMode && (useTwitterCredentials || useLuksoCredentials || usePreparedFarcaster)) {
      // X, LUKSO and Farcaster can be linked to an existing account (and then
      // log in), but they no longer create one
      throw new Error(errors.server.NOT_SUPPORTED);
    }

    // The account's address is verified BEFORE the account exists
    // (User/requestSignupEmailCode + verifySignupEmailCode), whenever this
    // instance can send mail at all.
    let verifiedEmail: string | null = null;
    if (!legacyMode && emailEnabled()) {
      verifiedEmail = getVerifiedSignupEmail(request.session);
      if (!verifiedEmail) {
        throw new Error(errors.server.EMAIL_VERIFICATION_REQUIRED);
      }
      if (useEmailAndPassword && normalizeEmail(useEmailAndPassword.email) !== normalizeEmail(verifiedEmail)) {
        throw new Error(errors.server.INVALID_REQUEST);
      }
    }

    let loginMethodAdded = false;

    const newUserData: Parameters<typeof userHelper.createUser>[0] = {
      activateNewsletter: false,
      email: verifiedEmail,
      emailVerified: verifiedEmail !== null,
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
      console.error("Error creating user: display account " + displayAccount + " not provided");
      throw new Error(errors.server.INVALID_REQUEST);
    }
    
    if (useEmailAndPassword) {
      loginMethodAdded = true;
      newUserData.email = verifiedEmail || useEmailAndPassword.email;
      newUserData.password = useEmailAndPassword.password;
    }

    if (usePreparedWallet) {
      loginMethodAdded = true;
      const { preparedCredential } = request.session;
      if (!preparedCredential || preparedCredential.type !== "wallet") {
        console.error("Error creating user with prepared wallet: prepared credential is not a wallet", preparedCredential?.type);
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
        console.error("Error creating user with prepared wallet: not ready for creation");
        throw new Error(errors.server.INVALID_REQUEST);
      }
    }

    if (usePreparedPasskey) {
      // the passkey registered during this sign-up (Passkey/verifyRegistration
      // while logged out) waits in the session; it is inserted together with
      // the user, so an abandoned sign-up leaves no row behind
      const { pendingPasskey } = request.session;
      if (
        legacyMode ||
        !pendingPasskey ||
        pendingPasskey.expiresAt <= Date.now() ||
        pendingPasskey.rpId !== getMainRp().rpId
      ) {
        console.error("Error creating user with passkey: no valid pending passkey in the session");
        throw new Error(errors.server.INVALID_REQUEST);
      }
      loginMethodAdded = true;
      const { expiresAt, ...passkey } = pendingPasskey;
      newUserData.passkey = passkey;
    }

    if (usePreparedFarcaster) {
      loginMethodAdded = true;
      const { farcaster } = request.session;
      if (!farcaster || !farcaster.fid || !farcaster.address || !farcaster.displayName || !farcaster.username) {
        console.error("Error creating user with prepared farcaster: invalid farcaster data", farcaster?.fid);
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
          const buffer = await fetchRemoteImage(fullSizeUrl);
          const image = await fileHelper.saveImage(null, { type: 'userProfileImage' }, buffer, { width: 110, height: 110 });
          twitterImageId = image.fileId;
        } catch (e) {
          // For now just ignore error if this fails, but is this fine for now?
          console.error("Could not download twitter image", e instanceof Error ? e.message : e);
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
        console.error("Error creating user with lukso credentials: invalid lukso data or already exists");
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
      console.error("Error creating user: no login method added");
      throw new Error(errors.server.INVALID_REQUEST);
    }

    const insertedIds = await userHelper.createUser(newUserData, async () => {
      // make sure rate limits are respected
      if (config.DEPLOYMENT !== 'dev') {
        await createUserRateLimiter(request, response);
      }
    });

    if (!!useCgProfile && !!useCgProfile.imageId) {
      fileHelper.scheduleUserPreviewUpdate(insertedIds.userId, useCgProfile.imageId);
    }
    // regenerating the session also drops all sign-up state (prepared
    // credentials, provider data, pending passkey, verified address)
    await establishLoginSession(request, {
      userId: insertedIds.userId,
      deviceId: insertedIds.deviceId,
      method: 'signup',
    });

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
        email: newUserData.email,
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
        emailVerified: newUserData.emailVerified === true,
        passkeys: insertedIds.passkeyData ? [insertedIds.passkeyData] : [],
        extraData: {},
        tags: null,
      },
      deviceId: insertedIds.deviceId,
      webPushSubscription: null,
      communities: [],
      unreadNotificationCount: 0,
      chats: [],
      securityStepRequired: await securityStepRequiredAfterLogin(request, insertedIds.userId),
    }

    if (!!newUserData.email && !newUserData.emailVerified && emailEnabled()) {
      try {
        const code = await issueEmailCode('verify', insertedIds.userId, newUserData.email);
        await emailUtils.sendVerificationEmail(newUserData.email, code);
      } catch (error) {
        console.error('Error sending verification email', error instanceof Error ? error.message : error);
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
    if (data.email !== undefined) {
      const current = (await userHelper.getOwnDataById(user.id)).email;
      if (data.email === current) {
        // clients re-send the unchanged address with other settings: not a
        // change (and must not reset the verification)
        delete data.email;
        if (Object.keys(data).length === 0) {
          return;
        }
      }
      else if (emailEnabled()) {
        // an instance that sends mail only takes an address that was
        // confirmed: User/requestEmailVerification + User/verifyEmail
        throw new Error(errors.server.EMAIL_VERIFICATION_REQUIRED);
      }
      else if (data.email === null || current === null || normalizeEmail(data.email) !== normalizeEmail(current)) {
        // changing the account's address: step-up (before any change)
        requireRecentAuth(request);
      }
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
    const isLoginAccount = LOGIN_ACCOUNT_TYPES.has(data.type);
    if (isLoginAccount) {
      // an X, LUKSO or Farcaster account can sign in: adding one is adding a
      // sign-in method — step-up, and the verified address is told afterwards
      await requireAuthToAdd(request, 'sign-in-method', { emailRequired: emailEnabled() });
    }
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
          const buffer = await fetchRemoteImage(fullSizeUrl);
          const image = await fileHelper.saveImage(null, { type: 'userProfileImage' }, buffer, { width: 110, height: 110 });
          twitterImageId = image.fileId;
        } catch (e) {
          // For now just ignore error if this fails, but is this fine for now?
          console.error("Could not download twitter image", e instanceof Error ? e.message : e);
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
    if (isLoginAccount) {
      notifyNewSignInMethod(user.id, `${data.type === 'twitter' ? 'X' : data.type === 'lukso' ? 'LUKSO' : 'Farcaster'} account`);
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
    const isLoginAccount = LOGIN_ACCOUNT_TYPES.has(data.type);
    if (isLoginAccount) {
      // X, LUKSO and Farcaster accounts can sign in: step-up
      requireRecentAuth(request);
    }
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    // never the account's last way to sign in (LAST_LOGIN_METHOD)
    await userHelper.removeUserAccount(user.id, data.type as UserProfileTypeEnum, { rpId: getProcessRpIdOrNull() });
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
    if (data.type === 'cg_evm' && !isLegacyCgidMode()) {
      // the deprecated 12-word recovery phrase login (a key derived from the
      // phrase signs in as the account's cg_evm wallet) is gone outside the
      // legacy gateway
      throw new Error(errors.server.NOT_SUPPORTED);
    }
    const { secret } = data.data;
    if (!secret || secret !== request.session.signSecret) {
      throw new Error(errors.server.INVALID_SECRET);
    }
    delete request.session.signSecret;
    const preparedWalletCredential = await walletHelper.prepareWalletAction(data, request.session.user?.id || null);
    request.session.preparedCredential = { ...preparedWalletCredential, createdAt: Date.now() };
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
    if (data.loginEnabled) {
      // a wallet that can sign in is a new sign-in method: step-up (a sign-in
      // within the hour while the account has no sign-in method here at all)
      await requireAuthToAdd(request, 'sign-in-method', { emailRequired: emailEnabled() });
    }
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
        if (data.loginEnabled) {
          notifyNewSignInMethod(user.id, 'wallet');
        }
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
    let switchedOn = false;
    if (data.loginEnabled !== undefined) {
      const current = await walletHelper.getOwnWalletLoginEnabled(user.id, data.id);
      if (current !== null && current !== data.loginEnabled) {
        // switching a wallet's sign-in on (adding a sign-in method) or off
        // (removing one): step-up, before any change
        if (data.loginEnabled) {
          await requireAuthToAdd(request, 'sign-in-method', { emailRequired: emailEnabled() });
          switchedOn = true;
        }
        else {
          requireRecentAuth(request);
        }
      }
    }
    // switching off the account's last way to sign in is refused (LAST_LOGIN_METHOD)
    await walletHelper.updateWallet(user.id, data, { rpId: getProcessRpIdOrNull() });
    if (switchedOn) {
      notifyNewSignInMethod(user.id, 'wallet');
    }

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
    if (await walletHelper.getOwnWalletLoginEnabled(user.id, data.id)) {
      // removing a sign-in method: step-up (checked before anything changes)
      requireRecentAuth(request);
    }
    // the account's last way to sign in cannot be deleted (LAST_LOGIN_METHOD)
    await walletHelper.deleteWallet(user.id, data, { rpId: getProcessRpIdOrNull() });

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
  API.User.getSuggestedUsers.Request,
  API.User.getSuggestedUsers.Response
>(
  userRouter,
  '/getSuggestedUsers',
  Validators.API.User.getSuggestedUsers,
  async (request, response, data) => {
    const { user } = request.session;
    // Viewer-aware discovery — authenticated only. Anonymous popular fallback
    // can be added additively later if a signed-out surface needs it.
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    return await suggestedUsersHelper.getSuggestedUsers(user.id, data);
  },
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
    if (emailEnabled() && !isLegacyCgidMode()) {
      // with mail, nothing needs this: sign-up and address changes answer the
      // same way for taken and free addresses (no lookup for anyone)
      throw new Error(errors.server.NOT_SUPPORTED);
    }
    await isEmailAvailableLimiter(request, response);
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
    const { hasPassword } = await computeSecurityStatus(user.id, { emailRequired: emailEnabled() });
    // replacing a password: step-up (the current password is the usual
    // proof); a first password adds a sign-in method
    const { userId } = hasPassword
      ? requireRecentAuth(request)
      : await requireAuthToAdd(request, 'sign-in-method', { emailRequired: emailEnabled() });
    await userHelper.setPassword(userId, data.password);
    notifyPasswordChanged(userId);
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
    await userHelper.subscribeNewsletter(user.id);
  }
);

// one-click unsubscribe links of notification mails (no login needed)
registerEmailUnsubscribeRoutes(userRouter);

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
    await userHelper.unsubscribeNewsletter(user.id);
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
      published: result.published,
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
    // Mails a code that confirms `email` for the session's account. The
    // address only becomes the account's address when the code comes back
    // (User/verifyEmail) — that is how it changes on an instance with mail.
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    if (!emailEnabled()) {
      throw new Error(errors.server.EMAIL_DISABLED);
    }
    const target = data.email.trim();
    const current = await userHelper.getOwnDataById(user.id);
    const sameAddress = !!current.email && normalizeEmail(current.email) === normalizeEmail(target);
    if (sameAddress && current.emailVerified) {
      // nothing to confirm
      return;
    }
    if (!sameAddress) {
      if (current.email && current.emailVerified) {
        // replacing the verified address: step-up, before anything happens
        requireRecentAuth(request);
      }
      else {
        await requireAuthToAdd(request, 'email', { emailRequired: true });
      }
    }
    await limitVerificationMail(request, response, target, user.id);
    // Taken means: another account has it VERIFIED (an unverified holder does
    // not block it, srv/repositories/users.ts setVerifiedEmail). Either way a
    // code is pending for the address afterwards (getSecurityStatus shows
    // it), and no mail is awaited — the answer looks the same.
    const ownerId = await userHelper.getVerifiedUserIdByEmail(target);
    const code = await issueEmailCode('verify', user.id, target);
    if (ownerId !== null && ownerId !== user.id) {
      // nobody receives this code; its owner hears about the attempt instead
      emailUtils.sendAddressInUseEmail(target)
        .catch(error => console.error("Error sending the address-in-use mail", error instanceof Error ? error.message : error));
      return;
    }
    emailUtils.sendVerificationEmail(target, code)
      .catch(error => console.error("Error sending the verification mail", error instanceof Error ? error.message : error));
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
    // the code is bound to the session's account and to the address it was
    // sent to; it works once
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const current = await userHelper.getOwnDataById(user.id);
    if (current.email && current.emailVerified && normalizeEmail(current.email) !== normalizeEmail(data.email)) {
      // this replaces a verified address (the code may be a day old):
      // step-up now as well, before the code is used up
      requireRecentAuth(request);
    }
    const { email } = await consumeEmailCode('verify', user.id, data.email, data.token,
      codeId => emailCodeAttemptLimiter(`verify:${codeId}`));
    const previous = await userHelper.setVerifiedEmail(user.id, email);
    if (previous.previousEmail && previous.previousVerified && normalizeEmail(previous.previousEmail) !== normalizeEmail(email)) {
      notifyEmailChanged(previous.previousEmail);
    }
    for (const clearedUserId of previous.clearedFrom) {
      // an account that held the address unverified loses it
      eventHelper.emit({ type: "cliUserOwnData", data: { email: null, emailVerified: false } }, { userIds: [clearedUserId] });
    }
    const event: Events.User.OwnData = {
      type: "cliUserOwnData",
      data: {
        email,
        emailVerified: true,
      },
    };
    eventHelper.emit(event, {
      userIds: [user.id]
    });
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
    await limitOneTimePasswordMail(request, response, email);
    // A code only for the VERIFIED address of an account; the same answer for
    // an unverified, a foreign and an unknown address. (Someone whose address
    // was never confirmed signs in another way and confirms it in the
    // settings — never logged out, where the address owner could confirm it
    // for someone else's account.)
    const userId = await userHelper.getVerifiedUserIdByEmail(email);
    if (userId) {
      const code = await issueEmailCode('login', userId, email);
      // not awaited: the response takes as long with and without an account
      emailUtils.sendOneTimePasswordEmail(email, code)
        .catch(error => console.error("Error sending the login code mail", error instanceof Error ? error.message : error));
    }
  }
);

registerPostRoute<
  API.User.getSecurityStatus.Request,
  API.User.getSecurityStatus.Response
>(
  userRouter,
  '/getSecurityStatus',
  validators.API.User.getSecurityStatus,
  async (request) => {
    // what the account-security step still needs (docs/auth-identity §11)
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const { status, version } = await computeSecurityStatusVersioned(user.id, { emailRequired: emailEnabled() });
    if (!status.required) {
      rememberSecurityStepClear(request, user.id, version);
    }
    return {
      ...status,
      pendingEmail: emailEnabled() ? await getPendingEmail(user.id) : null,
      // what is missing can be added in this session (else: sign in again
      // or open a new transfer link)
      recentSignIn: hasRecentAuth(request, { allow: ADD_SIGN_IN_METHOD_AUTH, maxAgeMs: SECURITY_STEP_AUTH_MAX_AGE_MS }),
    };
  }
);

registerPostRoute<
  API.User.createTransferLink.Request,
  API.User.createTransferLink.Response
>(
  userRouter,
  '/createTransferLink',
  validators.API.User.createTransferLink,
  async (request, response, data) => {
    // A one-time link that signs the session's own user in on the instance
    // TRANSFER_TARGET_URL names (the app.cg gateway → cg.box). There is no
    // way to mint one for anyone else.
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const target = getTransferTargetOrigin();
    if (!target) {
      throw new Error(errors.server.NOT_SUPPORTED);
    }
    await transferCreateUserLimiter(user.id);
    const nextPath = transferNextPath(data.nextPath, target);
    const { token, expiresAt } = await transferTokenHelper.create(user.id, nextPath, TRANSFER_LINK_TTL_MS);
    return {
      url: transferLinkUrl(target, token),
      expiresAt: new Date(expiresAt).getTime(),
    };
  }
);

registerPostRoute<
  API.User.previewTransferLink.Request,
  API.User.previewTransferLink.Response
>(
  userRouter,
  '/previewTransferLink',
  validators.API.User.previewTransferLink,
  async (request, response, data) => {
    // whose account a link signs in to — shown before the user confirms;
    // the link stays usable
    if (isLegacyCgidMode()) {
      throw new Error(errors.server.NOT_SUPPORTED);
    }
    await transferFailureLimiter.assertBelow(request);
    await transferRedeemIpLimiter(request, response);
    const row = await transferTokenHelper.peek(data.token);
    if (!row) {
      await recordTransferFailure(request);
      throw new Error(errors.server.TRANSFER_LINK_INVALID);
    }
    const ownData = await userHelper.getOwnDataById(row.userId);
    const displayed = ownData.accounts.find(account => account.type === ownData.displayAccount);
    return {
      userId: row.userId,
      displayName: getDisplayNameString(ownData),
      // the unique handle (cg profile name), so look-alike names can't fool anyone
      username: ownData.accounts.find(account => account.type === 'cg')?.displayName ?? null,
      imageId: displayed?.imageId ?? null,
      expiresAt: new Date(row.expiresAt).getTime(),
    };
  }
);

registerPostRoute<
  API.User.redeemTransferLink.Request,
  API.User.redeemTransferLink.Response
>(
  userRouter,
  '/redeemTransferLink',
  validators.API.User.redeemTransferLink,
  async (request, response, data) => {
    // Signs in with a transfer link: never into an existing login (the app
    // signs out first, after asking), a new session, and the session counts
    // as authenticated by 'transfer' — enough to add a sign-in method, never
    // to remove or replace one.
    if (isLegacyCgidMode()) {
      throw new Error(errors.server.NOT_SUPPORTED);
    }
    if (request.session.user) {
      throw new Error(errors.server.ALREADY_LOGGED_IN);
    }
    await transferFailureLimiter.assertBelow(request);
    await transferRedeemIpLimiter(request, response);
    const row = await transferTokenHelper.consume(data.token);
    if (!row) {
      await recordTransferFailure(request);
      throw new Error(errors.server.TRANSFER_LINK_INVALID);
    }
    const { userId } = row;
    const [ownData, communities, chats, { deviceId }, unreadNotificationCount] = await Promise.all([
      userHelper.getOwnDataById(userId),
      communityHelper.getOwnCommunities(userId),
      chatHelper.getChats(userId),
      deviceHelper.createDevice(userId, data.device.publicKey),
      notificationHelper.getUnreadCount(userId),
    ]);
    const userAgent = UAParser(request.headers["user-agent"]);
    await deviceHelper.updateDeviceInfo(deviceId, {
      deviceBrowser: userAgent.browser.name,
      deviceOS: userAgent.os.name,
    });
    await establishLoginSession(request, { userId, deviceId, method: 'transfer' });
    return {
      ownData,
      communities,
      chats,
      deviceId,
      webPushSubscription: null,
      unreadNotificationCount,
      securityStepRequired: await securityStepRequiredAfterLogin(request, userId),
      nextPath: row.nextPath,
    };
  }
);

export default userRouter;

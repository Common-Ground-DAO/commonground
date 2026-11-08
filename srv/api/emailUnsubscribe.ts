// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from 'express';
import Joi from 'joi';
import errors from '../common/errors';
import validators from '../validators';
import userHelper from '../repositories/users';
import newsletterHelper from '../repositories/newsletter';
import ipRateLimitHandler from '../util/rateLimit';
import urlConfig from '../util/urls';
import { verifyUnsubscribeToken, type UnsubscribeTarget } from '../util/unsubscribeToken';
import { unsubscribeTokenKey } from './emails';
import { asyncHandler } from './asyncHandler';

/**
 * One-click unsubscribe for notification mails (RFC 8058).
 *
 * Every digest and community-article mail carries
 *   List-Unsubscribe: <…/api/v2/User/emailUnsubscribe?token=…>
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click
 * Mail providers then POST to that URL when the user clicks their
 * "unsubscribe" button; the token (srv/util/unsubscribeToken.ts) names the
 * user and the preference to turn off, so no login is needed.
 *
 * GET (the link in the mail footer, and link scanners that open every URL)
 * only shows a confirmation page — the preference changes on POST alone.
 */

// Mail providers deliver one-click POSTs from a few shared server IPs, so the
// budget per IP is far higher than for the signup/captcha routes. The query
// string carries the token, hence the fixed bucket names.
const getRateLimiter = ipRateLimitHandler({
  windowMs: 1000 * 60, // 1 min
  limit_v4_v6_64: 60,
  limit_v6_56: 120,
  limit_v6_48: 240,
  bucket: 'emailUnsubscribe:get',
});
const postRateLimiter = ipRateLimitHandler({
  windowMs: 1000 * 60, // 1 min
  limit_v4_v6_64: 60,
  limit_v6_56: 120,
  limit_v6_48: 240,
  bucket: 'emailUnsubscribe:post',
});

const escapeHtml = (str: string) => str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[m]);

function sendPage(response: express.Response, status: number, title: string, body: string) {
  response.status(status);
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Robots-Tag', 'noindex');
  response.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} – Common Ground</title>
</head>
<body style="margin:0;padding:48px 16px;font-family:arial,sans-serif;background:#f8f8f8;color:#181818;">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;text-align:center;">
<h1 style="font-size:22px;margin-top:0;">${escapeHtml(title)}</h1>
${body}
<p style="margin-top:32px;"><a href="${escapeHtml(`${urlConfig.APP_URL}/?user-settings=notifications`)}" style="color:#717171;">Manage all email settings</a></p>
</div>
</body>
</html>
`);
}

function describe(target: UnsubscribeTarget): string {
  return target.topic.kind === 'digest'
    ? 'the weekly Common Ground digest'
    : 'new-post emails from this community';
}

async function readTarget(request: express.Request): Promise<UnsubscribeTarget | null> {
  let token: string;
  try {
    ({ token } = await validators.API.User.emailUnsubscribeQuery.validateAsync(request.query));
  } catch (e) {
    if (e instanceof Joi.ValidationError) {
      return null;
    }
    throw e;
  }
  const key = unsubscribeTokenKey();
  return key ? verifyUnsubscribeToken(key, token) : null;
}

async function unsubscribe(target: UnsubscribeTarget) {
  if (target.topic.kind === 'digest') {
    try {
      await userHelper.updateUser(target.userId, { weeklyNewsletter: false });
    } catch (e) {
      // with this fixed update, INVALID_REQUEST only means "no such user": an
      // account deleted since the mail was sent gets no mail anyway
      if (!(e instanceof Error && e.message === errors.server.INVALID_REQUEST)) {
        throw e;
      }
    }
    return;
  }
  // idempotent: a second click (or a community the user has left since) is
  // not an error
  const subscriptions = await newsletterHelper.getUserSubscriptions(target.userId);
  if (subscriptions.includes(target.topic.communityId)) {
    await newsletterHelper.unsubscribeUser(target.userId, [target.topic.communityId]);
  }
}

function invalidLinkPage(response: express.Response) {
  sendPage(response, 400, 'Invalid unsubscribe link',
    '<p>This link is incomplete or no longer valid. You can turn off emails in your notification settings.</p>');
}

function handleFailure(response: express.Response, e: unknown) {
  if (e instanceof Error && e.message === errors.server.RATE_LIMIT_EXCEEDED) {
    sendPage(response, 429, 'Too many requests', '<p>Please try again in a minute.</p>');
    return;
  }
  if (e instanceof Error && e.message === errors.server.INVALID_REQUEST) {
    // the rate limiter found no client address to count against
    sendPage(response, 400, 'Invalid request', '<p>Please open the link from your email again.</p>');
    return;
  }
  console.error('emailUnsubscribe failed', e);
  sendPage(response, 500, 'Something went wrong', '<p>Please try again later, or turn off emails in your notification settings.</p>');
}

export function registerEmailUnsubscribeRoutes(router: express.Router) {
  router.get('/emailUnsubscribe', asyncHandler(async (request, response) => {
    try {
      await getRateLimiter(request, response);
      const target = await readTarget(request);
      if (!target) {
        invalidLinkPage(response);
        return;
      }
      const token = String(request.query.token);
      sendPage(response, 200, 'Unsubscribe', `
<p>Stop receiving ${escapeHtml(describe(target))}?</p>
<form method="post" action="?token=${escapeHtml(encodeURIComponent(token))}">
<input type="hidden" name="List-Unsubscribe" value="One-Click">
<button type="submit" style="cursor:pointer;background:#181818;color:#f1f1f1;border:0;border-radius:12px;font-size:15px;padding:14px 32px;">Unsubscribe</button>
</form>`);
    } catch (e) {
      handleFailure(response, e);
    }
  }, handleFailure));

  // RFC 8058: the body is "List-Unsubscribe=One-Click", form-encoded (or
  // multipart, which is left unparsed here) — the signed token alone decides
  router.post('/emailUnsubscribe', express.urlencoded({ extended: false, limit: '1kb' }), asyncHandler(async (request, response) => {
    try {
      await postRateLimiter(request, response);
      await validators.API.User.emailUnsubscribeBody.validateAsync(request.body ?? {});
      const target = await readTarget(request);
      if (!target) {
        invalidLinkPage(response);
        return;
      }
      await unsubscribe(target);
      sendPage(response, 200, 'You are unsubscribed',
        `<p>You will no longer receive ${escapeHtml(describe(target))}.</p>`);
    } catch (e) {
      if (e instanceof Joi.ValidationError) {
        invalidLinkPage(response);
        return;
      }
      handleFailure(response, e);
    }
  }, handleFailure));
}

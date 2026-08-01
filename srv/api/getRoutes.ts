// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { readFileSync } from "fs";
import shortUUID from "short-uuid";
import express from "express";
import config from "../common/config";
import articleHelper from "../repositories/articles";
import { handleError, htmlToImage } from "./util";
import fileHelper from "../repositories/files";
import userHelper from "../repositories/users";
import communityHelper from "../repositories/communities";
import communityEventHelper from "../repositories/communityEvents";
import dayjs from "dayjs";
import advancedFormat from "dayjs/plugin/advancedFormat";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { itemUrlRegex } from "../validators/common";
import errors from "../common/errors";
import validators from "../validators";
import path from "path";
import fs from "fs";
import pool from "../util/postgres";
import passport from "passport";
import pluginHelper from "../repositories/plugins";
import { instanceConfigScriptTag } from "../util/instanceConfig";
dayjs.extend(advancedFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

const idRegex = /^~([a-z0-9]{22})$/i;

function parseIdOrUrl(param: string) {
  let m = param.match(idRegex);
  if (!!m) {
    return { uuid: translator.toUUID(m[1]) };
  }
  m = param.match(itemUrlRegex);
  if (!!m) {
    return { url: param };
  }
  throw new Error("Neither valid url nor valid short-uuid")
}

const getRoutesRouter = express.Router();

let indexhtml: string = '';
try {
  indexhtml = readFileSync("/dist/index.html").toString();
  // declare this instance's identity to the frontend (see src/common/instance.ts)
  if (!indexhtml.includes('__CG_INSTANCE__')) {
    indexhtml = indexhtml.replace('<head>', `<head>${instanceConfigScriptTag()}`);
  }
} catch (e) {
  console.error('ERROR: No index.html present! Social previews will not work.');
  console.log(e);
  if (config.DEPLOYMENT !== "dev") {
    throw new Error("index.html is missing");
  }
}
const _tpl = indexhtml
  .replace(/<meta +property="(og:title|og:description|og:type|og:image|og:url)" +content="[^"]+" *\/?>/g, '')
  .replace(/<meta +name="(twitter:title|twitter:description|twitter:image|description)" +content="[^"]+" *\/?>/g, '');
const insertPos = _tpl.indexOf('</head>');
const translator = shortUUID();

const escapeHtml = (str: string | null | undefined) => (str || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[m]);

function makeIndexHtml(title: string, description: string, type: 'article' | 'profile' | 'website', url: string, imageUrl: string): string {
  title = title || 'Common Ground';
  return [
    _tpl.substring(0, insertPos),
    `<meta name="description" content="${escapeHtml(description)}" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:type" content="${escapeHtml(type)}" />`,
    `<meta property="og:image" content="${escapeHtml(imageUrl)}" />`,
    `<meta property="og:url" content="${encodeURI(url)}" />`,
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(imageUrl)}" />`,
    _tpl.substring(insertPos)
  ].join('');
}

function getWorkingHost(hostname: string): string {
  if (config.DEPLOYMENT !== 'dev') {
    return `https://${hostname}`;
  }
  return `http://localhost:8000`;
}

// User Profile
getRoutesRouter.get(`/${config.URL_USER}/:userId/image.jpeg`, async (req, res) => {
  try {
    const userId = translator.toUUID(req.params.userId.replace('~', ''));
    const data = await userHelper.getSocialPreviewData({ userId });
    if (data) {
      const imageBuffer = await fileHelper.getFile(data.previewImageId);
      if (!!imageBuffer) {
        const outputBuffer = await fileHelper.convertToJpg(imageBuffer, 0 ,0);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=30, must-revalidate');
        res.status(200).send(outputBuffer);
        return;
      }
    }
    res.sendStatus(404);
  } catch (e) { handleError(res, e) }
});
getRoutesRouter.get(new RegExp(`/${config.URL_USER}/([^/]+)/?`), async (req, res) => {
  try {
    const userId = translator.toUUID(req.params[0].replace('~', ''));
    const baseUrl = [
      getWorkingHost(req.hostname),
      config.URL_USER,
      `~${translator.fromUUID(userId)}`,
    ].join('/');

    const data = await userHelper.getSocialPreviewData({ userId });
    if (!data) {
      res.redirect("/");
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Cache-Control', 'public, max-age=30, must-revalidate');
      
      let alias = '';
      const profile = data.accounts.find(acc => acc.type === data.displayAccount);
      if (!!profile) {
        alias = profile.displayName;
      }

      const indexHtml = makeIndexHtml(
        alias,
        `${alias} is on Common Ground, the web3 community platform`,
        "profile",
        `${baseUrl}/`,
        `${baseUrl}/image.jpeg`,
      );
      res.send(indexHtml);
    }
  } catch (e) { handleError(res, e) }
});

// Community Article
getRoutesRouter.get(new RegExp(`/${config.URL_COMMUNITY}/([^/]+)/${config.URL_ARTICLE}/([^/]+)/image.jpeg`), async (req, res) => {
  try {
    const communityUrl = req.params[0];
    const articleUri = req.params[1];
    const articleIdMatch = articleUri.match(/^.*([a-zA-Z0-9]{22})$/);
    if (!articleIdMatch) {
      throw new Error("Invalid article URI");
    }
    const articleId = translator.toUUID(articleIdMatch[1]);
    const data = await articleHelper.getCommunityArticleSocialPreviewData({ communityUrl, articleId });
    if (data) {
      const imageBuffer = await fileHelper.getFile(data.headerImageId);
      if (!!imageBuffer) {
        const outputBuffer = await fileHelper.convertToJpg(imageBuffer, 0, 0);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=30, must-revalidate');
        res.status(200).send(outputBuffer);
        return;
      }
    }
    res.sendStatus(404);
  } catch (e) { handleError(res, e) }
});
getRoutesRouter.get(new RegExp(`/${config.URL_COMMUNITY}/([^/]+)/${config.URL_ARTICLE}/([^/]+)(/?.*)?`), async (req, res) => {
  try {
    const communityUrl = req.params[0];
    const articleUri = req.params[1];
    const articleIdMatch = articleUri.match(/^.*([a-zA-Z0-9]{22})$/);
    if (!articleIdMatch) {
      throw new Error("Invalid article URI");
    }
    const articleId = translator.toUUID(articleIdMatch[1]);
    const baseUrl = [
      getWorkingHost(req.hostname),
      config.URL_COMMUNITY,
      communityUrl,
      config.URL_ARTICLE,
      encodeURIComponent(articleUri),
    ].join('/');

    const data = await articleHelper.getCommunityArticleSocialPreviewData({ communityUrl, articleId });
    if (!data) {
      res.redirect("/");
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Cache-Control', 'public, max-age=30, must-revalidate');
      const indexHtml = makeIndexHtml(
        data.title,
        data.previewText,
        "article",
        `${baseUrl}/`,
        `${baseUrl}/image.jpeg`,
      );
      res.send(indexHtml);
    }
  } catch (e) { handleError(res, e) }
});

// Community events
getRoutesRouter.get(new RegExp(`/${config.URL_COMMUNITY}/([^/]+)/${config.URL_EVENT}/([^/]+)/image.jpeg`), async (req, res) => {
  try {
    const eventUri = req.params[1];
    const eventIdOrUrl = parseIdOrUrl(eventUri);
    
    const data = await communityEventHelper.getCommunityEventSocialPreview(eventIdOrUrl);
    if (data) {
      const eventImage = await fileHelper.getFile(data.imageId);
      const communityImage = await fileHelper.getFile(data.communityLogoSmallId);

      const dateTime = dayjs(data.scheduleDate);

      const imageBuffer = await htmlToImage({
        body: `<div class="flex" style="padding:24px;gap:13px;height:100%">
          <div class="flex flex-col" style="justify-content: space-between; gap: 23px;">
            <div style="z-index:0; position: absolute; filter: blur(40px); border-radius: 12.8px; height: 120px; width: 300px; background-position: center; background-repeat: no-repeat; background-size: cover; background-image: url('data:image/jpg;base64,${eventImage?.toString('base64')}')"></div>
            <div style="z-index:1; border-radius: 12.8px; height: 120px; width: 300px; background-position: center; background-repeat: no-repeat; background-size: cover; background-image: url('data:image/jpg;base64,${eventImage?.toString('base64')}')"></div>
            <div class="flex flex-col" style="gap:4px; z-index:1; flex:1;">
              <div class="flex cg-text-lg-400 cg-text-secondary" style="gap: 4px; align-items: center;">
                <div style="border-radius: 4px; height: 20px; width: 20px; background-position: center; background-repeat: no-repeat; background-size: cover; background-image: url('data:image/jpg;base64,${communityImage?.toString('base64')}')"></div>
                <span class="cg-text-md-400">${data.communityTitle}</span>
                ${data.communityOfficial ? `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
                <g filter="url(#filter0_dd_28684_1536)">
                <path fill-rule="evenodd" clip-rule="evenodd" d="M10.0421 2.74867C9.81994 2.7801 9.59575 2.70727 9.43451 2.55131L8.50551 1.65268C8.22357 1.37996 7.77616 1.37996 7.49422 1.65268L6.56522 2.55131C6.40398 2.70727 6.17979 2.7801 5.95767 2.74867L4.67826 2.56761C4.28986 2.51264 3.92786 2.77559 3.86003 3.16194L3.63659 4.43466C3.59781 4.65552 3.45932 4.84614 3.26125 4.95128L2.11936 5.55741C1.77292 5.7413 1.63471 6.16679 1.80696 6.51918L2.37463 7.6805C2.47315 7.88206 2.47314 8.11781 2.37458 8.31936L1.80709 9.47993C1.63477 9.83232 1.77297 10.2579 2.11945 10.4418L3.26125 11.0479C3.45932 11.153 3.59781 11.3436 3.63659 11.5645L3.86007 12.8374C3.92788 13.2237 4.28975 13.4866 4.67807 13.4318L5.95779 13.2511C6.17984 13.2197 6.40394 13.2926 6.56512 13.4485L7.49422 14.3472C7.77616 14.6199 8.22357 14.6199 8.50551 14.3472L9.43461 13.4485C9.59579 13.2926 9.81989 13.2197 10.0419 13.2511L11.3217 13.4318C11.71 13.4866 12.0718 13.2237 12.1397 12.8374L12.3631 11.5645C12.4019 11.3436 12.5404 11.153 12.7385 11.0479L13.8803 10.4418C14.2268 10.2579 14.365 9.83232 14.1926 9.47993L13.6251 8.31936C13.5266 8.11781 13.5266 7.88206 13.6251 7.6805L14.1928 6.51918C14.365 6.1668 14.2268 5.7413 13.8804 5.55741L12.7385 4.95128C12.5404 4.84614 12.4019 4.65552 12.3631 4.43466L12.1397 3.16194C12.0719 2.77559 11.7099 2.51264 11.3215 2.56761L10.0421 2.74867ZM5.00169 7.83595C4.74293 8.09671 4.74374 8.51763 5.00351 8.7774L6.4894 10.2633C6.78228 10.5562 7.26028 10.5457 7.54002 10.2402L10.7113 6.77706C10.9594 6.5061 10.9421 6.08559 10.6725 5.83599C10.401 5.58464 9.97686 5.60193 9.72672 5.87453L7.49352 8.3082C7.21367 8.61317 6.73608 8.62343 6.4434 8.33075L5.94678 7.83412C5.68559 7.57294 5.26187 7.57375 5.00169 7.83595Z" fill="url(#paint0_linear_28684_1536)" style=""/>
                </g>
                <path fill-rule="evenodd" clip-rule="evenodd" d="M9.8805 3.24679C9.65832 3.27826 9.43405 3.20539 9.27278 3.04935L8.5061 2.30748C8.22414 2.03465 7.77659 2.03465 7.49463 2.30748L6.72795 3.04935C6.56669 3.20539 6.34242 3.27826 6.12023 3.24679L5.06369 3.09716C4.67522 3.04214 4.31313 3.30518 4.24537 3.69164L4.06106 4.74276C4.0223 4.96377 3.88371 5.15451 3.68549 5.25965L2.7427 5.75969C2.39613 5.94351 2.2578 6.36909 2.43008 6.72155L2.89882 7.68057C2.99731 7.88209 2.99731 8.11778 2.89882 8.3193L2.43008 9.27832C2.2578 9.63078 2.39613 10.0564 2.7427 10.2402L3.68549 10.7402C3.88371 10.8454 4.0223 11.0361 4.06106 11.2571L4.24537 12.3082C4.31313 12.6947 4.67522 12.9577 5.06369 12.9027L6.12023 12.7531C6.34242 12.7216 6.56669 12.7945 6.72795 12.9505L7.49463 13.6924C7.77659 13.9652 8.22414 13.9652 8.5061 13.6924L9.27278 12.9505C9.43405 12.7945 9.65832 12.7216 9.8805 12.7531L10.937 12.9027C11.3255 12.9577 11.6876 12.6947 11.7554 12.3082L11.9397 11.2571C11.9784 11.0361 12.117 10.8454 12.3152 10.7402L13.258 10.2402C13.6046 10.0564 13.7429 9.63078 13.5707 9.27832L13.1019 8.3193C13.0034 8.11778 13.0034 7.88209 13.1019 7.68057L13.5707 6.72155C13.7429 6.36909 13.6046 5.94351 13.258 5.75969L12.3152 5.25965C12.117 5.15451 11.9784 4.96377 11.9397 4.74276L11.7554 3.69164C11.6876 3.30518 11.3255 3.04214 10.937 3.09716L9.8805 3.24679ZM5.00204 7.83572C4.743 8.09657 4.74376 8.51781 5.00375 8.77772L6.4899 10.2634C6.7828 10.5563 7.26074 10.5457 7.54044 10.2403L10.7118 6.77706C10.9599 6.50609 10.9426 6.08558 10.673 5.83598C10.4015 5.58464 9.97736 5.60192 9.72722 5.87452L7.49402 8.3082C7.21417 8.61317 6.73658 8.62342 6.4439 8.33074L5.94724 7.83408C5.68605 7.57289 5.26233 7.57362 5.00204 7.83572Z" fill="url(#paint1_linear_28684_1536)" style=""/>
                <path fill-rule="evenodd" clip-rule="evenodd" d="M4.53407 8.30685C4.53372 8.3072 4.53372 8.30777 4.53407 8.30813L6.48987 10.2634C6.78277 10.5562 7.26071 10.5456 7.54042 10.2402L11.1363 6.31331C11.1471 6.30395 11.1639 6.31164 11.1638 6.32591L11.1609 7.15425C11.1605 7.25192 11.1238 7.34594 11.0578 7.41797L7.54049 11.259C7.26076 11.5645 6.78276 11.575 6.48987 11.2821L4.67009 9.46233C4.58257 9.37481 4.53328 9.25618 4.53302 9.1324L4.53126 8.30631C4.53125 8.30523 4.53243 8.30456 4.53336 8.30512L4.5339 8.30544C4.5344 8.30574 4.53448 8.30644 4.53407 8.30685Z" fill="#D18800" style="fill:#D18800;fill:color(display-p3 0.8196 0.5333 0.0000);fill-opacity:1;"/>
                <defs>
                <filter id="filter0_dd_28684_1536" x="-2.2666" y="-1.55176" width="20.5332" height="21.1035" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
                <feFlood flood-opacity="0" result="BackgroundImageFix"/>
                <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
                <feOffset dy="1"/>
                <feGaussianBlur stdDeviation="2"/>
                <feComposite in2="hardAlpha" operator="out"/>
                <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.06 0"/>
                <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_28684_1536"/>
                <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
                <feOffset/>
                <feGaussianBlur stdDeviation="0.5"/>
                <feComposite in2="hardAlpha" operator="out"/>
                <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.2 0"/>
                <feBlend mode="normal" in2="effect1_dropShadow_28684_1536" result="effect2_dropShadow_28684_1536"/>
                <feBlend mode="normal" in="SourceGraphic" in2="effect2_dropShadow_28684_1536" result="shape"/>
                </filter>
                <linearGradient id="paint0_linear_28684_1536" x1="3.20787" y1="1.81448" x2="13.1511" y2="15.6421" gradientUnits="userSpaceOnUse">
                <stop stop-color="#F4E72A" style="stop-color:#F4E72A;stop-color:color(display-p3 0.9569 0.9059 0.1647);stop-opacity:1;"/>
                <stop offset="0.539" stop-color="#CD8105" style="stop-color:#CD8105;stop-color:color(display-p3 0.8039 0.5059 0.0196);stop-opacity:1;"/>
                <stop offset="0.68" stop-color="#CB7B00" style="stop-color:#CB7B00;stop-color:color(display-p3 0.7961 0.4824 0.0000);stop-opacity:1;"/>
                <stop offset="1" stop-color="#F4E72A" style="stop-color:#F4E72A;stop-color:color(display-p3 0.9569 0.9059 0.1647);stop-opacity:1;"/>
                </linearGradient>
                <linearGradient id="paint1_linear_28684_1536" x1="3.89491" y1="2.46902" x2="11.8993" y2="13.9148" gradientUnits="userSpaceOnUse">
                <stop stop-color="#F9E87F" style="stop-color:#F9E87F;stop-color:color(display-p3 0.9765 0.9098 0.4980);stop-opacity:1;"/>
                <stop offset="0.406" stop-color="#E2B719" style="stop-color:#E2B719;stop-color:color(display-p3 0.8863 0.7176 0.0980);stop-opacity:1;"/>
                <stop offset="0.989" stop-color="#E2B719" style="stop-color:#E2B719;stop-color:color(display-p3 0.8863 0.7176 0.0980);stop-opacity:1;"/>
                </linearGradient>
                </defs>
                </svg>` : ''}
                <span>·</span>
                <span>Event</span>
              </div>
              <span class="cg-heading-3 cg-text-main">
                ${data.title}
              </span>
            </div>
          </div>
      
          <div class="flex flex-col" style="flex: 1; justify-content: space-between; align-items: flex-end; z-index:1;">
            <svg width="40" height="40" viewBox="0 0 41 39" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="21.7509" cy="19.4792" r="17.3954" stroke="#fcfcfc" stroke-width="2.50782"/>
              <path fill-rule="evenodd" clip-rule="evenodd" d="M21.5654 2.47534C12.1747 2.47534 4.56201 10.088 4.56201 19.4787C4.56201 28.8694 12.1747 36.4821 21.5654 36.4821H21.7512V2.47534H21.5654ZM6.98108 18.3024C8.52346 16.5927 10.4872 15.1933 12.7323 14.7287C15.0216 14.255 17.4739 14.7815 19.8687 16.6912L18.6179 18.2598C16.6438 16.6857 14.7898 16.3517 13.1388 16.6933C11.4436 17.0441 9.83311 18.1361 8.47073 19.6462L6.98108 18.3024Z" fill="#fcfcfc"/>
              <path fill-rule="evenodd" clip-rule="evenodd" d="M30.9641 14.7277C33.2092 15.1923 35.1729 16.5917 36.7153 18.3014L35.2257 19.6453C33.8633 18.1351 32.2528 17.0432 30.5576 16.6924C28.9067 16.3507 27.0526 16.6847 25.0785 18.2588L23.8277 16.6902C26.2226 14.7805 28.6748 14.254 30.9641 14.7277Z" fill="#fcfcfc"/>
              <path d="M11.4086 20.0116L21.8663 38.125H0.950828L11.4086 20.0116Z" fill="#fcfcfc"/>
            </svg>
            <div class="flex flex-col cg-text-main" style="gap: 4px; align-items: flex-end;">
              <span class="cg-text-lg-500">${dateTime.format('MMM DD, YYYY')}</span>
              <span class="cg-text-lg-500">${dateTime.format('HH:mm z')}</span>
              <span class="cg-text-lg-400 bg-full-white cg-text-full-black" style="padding: 8px 16px; border-radius: 12px;">Attend</span>
            </div>
          </div>
        </div>`,
        height: 268,
        width: 512
      });

      if (!!imageBuffer) {
        const outputBuffer = await fileHelper.convertToJpg(imageBuffer, 512, 268);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=30, must-revalidate');
        res.status(200).send(outputBuffer);
        return;
      }
    }
    res.sendStatus(404);
  } catch (e) { handleError(res, e) }
});
getRoutesRouter.get(new RegExp(`/${config.URL_COMMUNITY}/([^/]+)/${config.URL_EVENT}/([^/]+)(/?.*)?`), async (req, res) => {
  try {
    const communityUrl = req.params[0];
    const eventUri = req.params[1];
    const eventIdOrUrl = parseIdOrUrl(eventUri);
        
    const baseUrl = [
      getWorkingHost(req.hostname),
      config.URL_COMMUNITY,
      communityUrl,
      config.URL_EVENT,
      encodeURIComponent(eventUri)
    ].join('/');

    const data = await communityEventHelper.getCommunityEventSocialPreview(eventIdOrUrl);
    
    if (!data) {
      res.redirect("/");
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Cache-Control', 'public, max-age=30, must-revalidate');
      const indexHtml = makeIndexHtml(
        data.title || '',
        'Event',
        "website",
        `${baseUrl}/`,
        `${baseUrl}/image.jpeg`,
      );
      res.send(indexHtml);
    }
  } catch (e) { handleError(res, e) }
});

// Community plugin
getRoutesRouter.get(new RegExp(`/${config.URL_COMMUNITY}/([^/]+)/${config.URL_PLUGIN}/([^/]+)/image.jpeg`), async (req, res) => {
  try {
    const pluginId = req.params[1];
    const communityPlugin = await pluginHelper.getCommunityPlugin(pluginId);
    const communityData = await communityHelper.getCommunitySocialPreview({ communityId: communityPlugin.communityId });
    const plugin = await pluginHelper.getPlugin(communityPlugin.pluginId);

    if (communityData && communityPlugin && plugin) {
      const pluginImage = !!plugin.imageId ? (await fileHelper.getFile(plugin.imageId))?.toString('base64') : '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';
      const communityImage = await fileHelper.getFile(communityData.logoSmallId);

      const imageBuffer = await htmlToImage({
        body: `<div class="flex" style="padding:24px;gap:13px;height:100%">
          <div class="flex flex-col" style="justify-content: space-between; gap: 23px;">
            <div style="z-index:0; position: absolute; filter: blur(40px); border-radius: 12.8px; height: 160px; width: 160px; background-position: center; background-repeat: no-repeat; background-size: cover; background-image: url('data:image/jpg;base64,${pluginImage}')"></div>
            <div style="z-index:1; border-radius: 12.8px; height: 160px; width: 160px; background-position: center; background-repeat: no-repeat; background-size: cover; background-image: url('data:image/jpg;base64,${pluginImage}')"></div>
            <div class="flex flex-col" style="gap:4px; z-index:1; flex:1;">
              <div class="flex cg-text-lg-400 cg-text-secondary" style="gap: 4px; align-items: center;">
                <div style="border-radius: 4px; height: 20px; width: 20px; background-position: center; background-repeat: no-repeat; background-size: cover; background-image: url('data:image/jpg;base64,${communityImage?.toString('base64')}')"></div>
                <span class="cg-text-md-400">${communityData.title}</span>
                ${communityData.official ? `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
                <g filter="url(#filter0_dd_28684_1536)">
                <path fill-rule="evenodd" clip-rule="evenodd" d="M10.0421 2.74867C9.81994 2.7801 9.59575 2.70727 9.43451 2.55131L8.50551 1.65268C8.22357 1.37996 7.77616 1.37996 7.49422 1.65268L6.56522 2.55131C6.40398 2.70727 6.17979 2.7801 5.95767 2.74867L4.67826 2.56761C4.28986 2.51264 3.92786 2.77559 3.86003 3.16194L3.63659 4.43466C3.59781 4.65552 3.45932 4.84614 3.26125 4.95128L2.11936 5.55741C1.77292 5.7413 1.63471 6.16679 1.80696 6.51918L2.37463 7.6805C2.47315 7.88206 2.47314 8.11781 2.37458 8.31936L1.80709 9.47993C1.63477 9.83232 1.77297 10.2579 2.11945 10.4418L3.26125 11.0479C3.45932 11.153 3.59781 11.3436 3.63659 11.5645L3.86007 12.8374C3.92788 13.2237 4.28975 13.4866 4.67807 13.4318L5.95779 13.2511C6.17984 13.2197 6.40394 13.2926 6.56512 13.4485L7.49422 14.3472C7.77616 14.6199 8.22357 14.6199 8.50551 14.3472L9.43461 13.4485C9.59579 13.2926 9.81989 13.2197 10.0419 13.2511L11.3217 13.4318C11.71 13.4866 12.0718 13.2237 12.1397 12.8374L12.3631 11.5645C12.4019 11.3436 12.5404 11.153 12.7385 11.0479L13.8803 10.4418C14.2268 10.2579 14.365 9.83232 14.1926 9.47993L13.6251 8.31936C13.5266 8.11781 13.5266 7.88206 13.6251 7.6805L14.1928 6.51918C14.365 6.1668 14.2268 5.7413 13.8804 5.55741L12.7385 4.95128C12.5404 4.84614 12.4019 4.65552 12.3631 4.43466L12.1397 3.16194C12.0719 2.77559 11.7099 2.51264 11.3215 2.56761L10.0421 2.74867ZM5.00169 7.83595C4.74293 8.09671 4.74374 8.51763 5.00351 8.7774L6.4894 10.2633C6.78228 10.5562 7.26028 10.5457 7.54002 10.2402L10.7113 6.77706C10.9594 6.5061 10.9421 6.08559 10.6725 5.83599C10.401 5.58464 9.97686 5.60193 9.72672 5.87453L7.49352 8.3082C7.21367 8.61317 6.73608 8.62343 6.4434 8.33075L5.94678 7.83412C5.68559 7.57294 5.26187 7.57375 5.00169 7.83595Z" fill="url(#paint0_linear_28684_1536)" style=""/>
                </g>
                <path fill-rule="evenodd" clip-rule="evenodd" d="M9.8805 3.24679C9.65832 3.27826 9.43405 3.20539 9.27278 3.04935L8.5061 2.30748C8.22414 2.03465 7.77659 2.03465 7.49463 2.30748L6.72795 3.04935C6.56669 3.20539 6.34242 3.27826 6.12023 3.24679L5.06369 3.09716C4.67522 3.04214 4.31313 3.30518 4.24537 3.69164L4.06106 4.74276C4.0223 4.96377 3.88371 5.15451 3.68549 5.25965L2.7427 5.75969C2.39613 5.94351 2.2578 6.36909 2.43008 6.72155L2.89882 7.68057C2.99731 7.88209 2.99731 8.11778 2.89882 8.3193L2.43008 9.27832C2.2578 9.63078 2.39613 10.0564 2.7427 10.2402L3.68549 10.7402C3.88371 10.8454 4.0223 11.0361 4.06106 11.2571L4.24537 12.3082C4.31313 12.6947 4.67522 12.9577 5.06369 12.9027L6.12023 12.7531C6.34242 12.7216 6.56669 12.7945 6.72795 12.9505L7.49463 13.6924C7.77659 13.9652 8.22414 13.9652 8.5061 13.6924L9.27278 12.9505C9.43405 12.7945 9.65832 12.7216 9.8805 12.7531L10.937 12.9027C11.3255 12.9577 11.6876 12.6947 11.7554 12.3082L11.9397 11.2571C11.9784 11.0361 12.117 10.8454 12.3152 10.7402L13.258 10.2402C13.6046 10.0564 13.7429 9.63078 13.5707 9.27832L13.1019 8.3193C13.0034 8.11778 13.0034 7.88209 13.1019 7.68057L13.5707 6.72155C13.7429 6.36909 13.6046 5.94351 13.258 5.75969L12.3152 5.25965C12.117 5.15451 11.9784 4.96377 11.9397 4.74276L11.7554 3.69164C11.6876 3.30518 11.3255 3.04214 10.937 3.09716L9.8805 3.24679ZM5.00204 7.83572C4.743 8.09657 4.74376 8.51781 5.00375 8.77772L6.4899 10.2634C6.7828 10.5563 7.26074 10.5457 7.54044 10.2403L10.7118 6.77706C10.9599 6.50609 10.9426 6.08558 10.673 5.83598C10.4015 5.58464 9.97736 5.60192 9.72722 5.87452L7.49402 8.3082C7.21417 8.61317 6.73658 8.62342 6.4439 8.33074L5.94724 7.83408C5.68605 7.57289 5.26233 7.57362 5.00204 7.83572Z" fill="url(#paint1_linear_28684_1536)" style=""/>
                <path fill-rule="evenodd" clip-rule="evenodd" d="M4.53407 8.30685C4.53372 8.3072 4.53372 8.30777 4.53407 8.30813L6.48987 10.2634C6.78277 10.5562 7.26071 10.5456 7.54042 10.2402L11.1363 6.31331C11.1471 6.30395 11.1639 6.31164 11.1638 6.32591L11.1609 7.15425C11.1605 7.25192 11.1238 7.34594 11.0578 7.41797L7.54049 11.259C7.26076 11.5645 6.78276 11.575 6.48987 11.2821L4.67009 9.46233C4.58257 9.37481 4.53328 9.25618 4.53302 9.1324L4.53126 8.30631C4.53125 8.30523 4.53243 8.30456 4.53336 8.30512L4.5339 8.30544C4.5344 8.30574 4.53448 8.30644 4.53407 8.30685Z" fill="#D18800" style="fill:#D18800;fill:color(display-p3 0.8196 0.5333 0.0000);fill-opacity:1;"/>
                <defs>
                <filter id="filter0_dd_28684_1536" x="-2.2666" y="-1.55176" width="20.5332" height="21.1035" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
                <feFlood flood-opacity="0" result="BackgroundImageFix"/>
                <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
                <feOffset dy="1"/>
                <feGaussianBlur stdDeviation="2"/>
                <feComposite in2="hardAlpha" operator="out"/>
                <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.06 0"/>
                <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_28684_1536"/>
                <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
                <feOffset/>
                <feGaussianBlur stdDeviation="0.5"/>
                <feComposite in2="hardAlpha" operator="out"/>
                <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.2 0"/>
                <feBlend mode="normal" in2="effect1_dropShadow_28684_1536" result="effect2_dropShadow_28684_1536"/>
                <feBlend mode="normal" in="SourceGraphic" in2="effect2_dropShadow_28684_1536" result="shape"/>
                </filter>
                <linearGradient id="paint0_linear_28684_1536" x1="3.20787" y1="1.81448" x2="13.1511" y2="15.6421" gradientUnits="userSpaceOnUse">
                <stop stop-color="#F4E72A" style="stop-color:#F4E72A;stop-color:color(display-p3 0.9569 0.9059 0.1647);stop-opacity:1;"/>
                <stop offset="0.539" stop-color="#CD8105" style="stop-color:#CD8105;stop-color:color(display-p3 0.8039 0.5059 0.0196);stop-opacity:1;"/>
                <stop offset="0.68" stop-color="#CB7B00" style="stop-color:#CB7B00;stop-color:color(display-p3 0.7961 0.4824 0.0000);stop-opacity:1;"/>
                <stop offset="1" stop-color="#F4E72A" style="stop-color:#F4E72A;stop-color:color(display-p3 0.9569 0.9059 0.1647);stop-opacity:1;"/>
                </linearGradient>
                <linearGradient id="paint1_linear_28684_1536" x1="3.89491" y1="2.46902" x2="11.8993" y2="13.9148" gradientUnits="userSpaceOnUse">
                <stop stop-color="#F9E87F" style="stop-color:#F9E87F;stop-color:color(display-p3 0.9765 0.9098 0.4980);stop-opacity:1;"/>
                <stop offset="0.406" stop-color="#E2B719" style="stop-color:#E2B719;stop-color:color(display-p3 0.8863 0.7176 0.0980);stop-opacity:1;"/>
                <stop offset="0.989" stop-color="#E2B719" style="stop-color:#E2B719;stop-color:color(display-p3 0.8863 0.7176 0.0980);stop-opacity:1;"/>
                </linearGradient>
                </defs>
                </svg>` : ''}
                <span>·</span>
                <span>Plugin</span>
              </div>
              <span class="cg-heading-3 cg-text-main">
                ${communityPlugin.name}
              </span>
            </div>
          </div>
      
          <div class="flex flex-col" style="flex: 1; justify-content: space-between; align-items: flex-end; z-index:1;">
            <svg width="40" height="40" viewBox="0 0 41 39" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="21.7509" cy="19.4792" r="17.3954" stroke="#fcfcfc" stroke-width="2.50782"/>
              <path fill-rule="evenodd" clip-rule="evenodd" d="M21.5654 2.47534C12.1747 2.47534 4.56201 10.088 4.56201 19.4787C4.56201 28.8694 12.1747 36.4821 21.5654 36.4821H21.7512V2.47534H21.5654ZM6.98108 18.3024C8.52346 16.5927 10.4872 15.1933 12.7323 14.7287C15.0216 14.255 17.4739 14.7815 19.8687 16.6912L18.6179 18.2598C16.6438 16.6857 14.7898 16.3517 13.1388 16.6933C11.4436 17.0441 9.83311 18.1361 8.47073 19.6462L6.98108 18.3024Z" fill="#fcfcfc"/>
              <path fill-rule="evenodd" clip-rule="evenodd" d="M30.9641 14.7277C33.2092 15.1923 35.1729 16.5917 36.7153 18.3014L35.2257 19.6453C33.8633 18.1351 32.2528 17.0432 30.5576 16.6924C28.9067 16.3507 27.0526 16.6847 25.0785 18.2588L23.8277 16.6902C26.2226 14.7805 28.6748 14.254 30.9641 14.7277Z" fill="#fcfcfc"/>
              <path d="M11.4086 20.0116L21.8663 38.125H0.950828L11.4086 20.0116Z" fill="#fcfcfc"/>
            </svg>
            <div class="flex flex-col cg-text-main" style="gap: 4px; align-items: flex-end;">
              <span class="cg-text-lg-400 bg-full-white cg-text-full-black" style="padding: 8px 16px; border-radius: 12px;">Launch</span>
            </div>
          </div>
        </div>`,
        height: 268,
        width: 512
      });

      if (!!imageBuffer) {
        const outputBuffer = await fileHelper.convertToJpg(imageBuffer, 512, 268);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=30, must-revalidate');
        res.status(200).send(outputBuffer);
        return;
      }
    }
    res.sendStatus(404);
  } catch (e) { handleError(res, e) }
});
getRoutesRouter.get(new RegExp(`/${config.URL_COMMUNITY}/([^/]+)/${config.URL_PLUGIN}/([^/]+)(/?.*)?`), async (req, res) => {
  try {
    const communityUrl = req.params[0];
    const pluginId = req.params[1];
        
    const baseUrl = [
      getWorkingHost(req.hostname),
      config.URL_COMMUNITY,
      communityUrl,
      config.URL_PLUGIN,
      encodeURIComponent(pluginId)
    ].join('/');

    const data = await pluginHelper.getCommunityPlugin(pluginId);
    
    if (!data) {
      res.redirect("/");
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Cache-Control', 'public, max-age=30, must-revalidate');
      const indexHtml = makeIndexHtml(
        data.name || '',
        `Check out the ${data.name} Plugin on Common Ground!`,
        "website",
        `${baseUrl}/`,
        `${baseUrl}/image.jpeg`,
      );
      res.send(indexHtml);
    }
  } catch (e) { handleError(res, e) }
});

// Appstore plugin
getRoutesRouter.get(new RegExp(`/${config.URL_APPSTORE}/([^/]+)/image.jpeg`), async (req, res) => {
  try {
    const pluginId = req.params[0];
    const plugin = await pluginHelper.getAppstorePlugin(pluginId);

    if (plugin) {
      const pluginImage = !!plugin.imageId ? (await fileHelper.getFile(plugin.imageId))?.toString('base64') : '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';

      const imageBuffer = await htmlToImage({
        body: `<div class="flex" style="padding:24px;gap:13px;height:100%">
          <div class="flex flex-col" style="justify-content: space-between; gap: 23px;">
            <div style="z-index:0; position: absolute; filter: blur(40px); border-radius: 12.8px; height: 160px; width: 160px; background-position: center; background-repeat: no-repeat; background-size: cover; background-image: url('data:image/jpg;base64,${pluginImage}')"></div>
            <div style="z-index:1; border-radius: 12.8px; height: 160px; width: 160px; background-position: center; background-repeat: no-repeat; background-size: cover; background-image: url('data:image/jpg;base64,${pluginImage}')"></div>
            <div class="flex flex-col" style="gap:4px; z-index:1; flex:1;">
              <div class="flex cg-text-lg-400 cg-text-secondary" style="gap: 4px; align-items: center;">
                <span>Appstore plugin</span>
              </div>
              <span class="cg-heading-3 cg-text-main">
                ${plugin.name}
              </span>
            </div>
          </div>
      
          <div class="flex flex-col" style="flex: 1; justify-content: space-between; align-items: flex-end; z-index:1;">
            <svg width="40" height="40" viewBox="0 0 41 39" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="21.7509" cy="19.4792" r="17.3954" stroke="#fcfcfc" stroke-width="2.50782"/>
              <path fill-rule="evenodd" clip-rule="evenodd" d="M21.5654 2.47534C12.1747 2.47534 4.56201 10.088 4.56201 19.4787C4.56201 28.8694 12.1747 36.4821 21.5654 36.4821H21.7512V2.47534H21.5654ZM6.98108 18.3024C8.52346 16.5927 10.4872 15.1933 12.7323 14.7287C15.0216 14.255 17.4739 14.7815 19.8687 16.6912L18.6179 18.2598C16.6438 16.6857 14.7898 16.3517 13.1388 16.6933C11.4436 17.0441 9.83311 18.1361 8.47073 19.6462L6.98108 18.3024Z" fill="#fcfcfc"/>
              <path fill-rule="evenodd" clip-rule="evenodd" d="M30.9641 14.7277C33.2092 15.1923 35.1729 16.5917 36.7153 18.3014L35.2257 19.6453C33.8633 18.1351 32.2528 17.0432 30.5576 16.6924C28.9067 16.3507 27.0526 16.6847 25.0785 18.2588L23.8277 16.6902C26.2226 14.7805 28.6748 14.254 30.9641 14.7277Z" fill="#fcfcfc"/>
              <path d="M11.4086 20.0116L21.8663 38.125H0.950828L11.4086 20.0116Z" fill="#fcfcfc"/>
            </svg>
            <div class="flex flex-col cg-text-main" style="gap: 4px; align-items: flex-end;">
              <span class="cg-text-lg-400 bg-full-white cg-text-full-black" style="padding: 8px 16px; border-radius: 12px;">Launch</span>
            </div>
          </div>
        </div>`,
        height: 268,
        width: 512
      });

      if (!!imageBuffer) {
        const outputBuffer = await fileHelper.convertToJpg(imageBuffer, 512, 268);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=30, must-revalidate');
        res.status(200).send(outputBuffer);
        return;
      }
    }
    res.sendStatus(404);
  } catch (e) { handleError(res, e) }
});
getRoutesRouter.get(new RegExp(`/${config.URL_APPSTORE}/([^/]+)(/?.*)?`), async (req, res) => {
  try {
    const pluginId = req.params[0];
        
    const baseUrl = [
      getWorkingHost(req.hostname),
      config.URL_APPSTORE,
      encodeURIComponent(pluginId)
    ].join('/');

    const data = await pluginHelper.getAppstorePlugin(pluginId);

    if (!data) {
      res.redirect("/");
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Cache-Control', 'public, max-age=30, must-revalidate');
      const indexHtml = makeIndexHtml(
        data.name || '',
        `Check out the ${data.name} Plugin on the Common Ground Appstore!`,
        "website",
        `${baseUrl}/`,
        `${baseUrl}/image.jpeg`,
      );
      res.send(indexHtml);
    }
  } catch (e) { handleError(res, e) }
});

// Community
getRoutesRouter.get(new RegExp(`/${config.URL_COMMUNITY}/([^/]+)/image.jpeg`), async (req, res) => {
  try {
    const communityUrl = req.params[0];
    const data = await communityHelper.getCommunitySocialPreview({ communityUrl });
    if (data) {
      const loglogo = await fileHelper.getFile(data.logoLargeId || data.logoSmallId);

      const imageBuffer = await htmlToImage({
        body: `<div class="flex flex-col" style="padding:24px;gap:13px;height:100%">
          <div class="flex" style="justify-content: space-between; gap: 23px; flex: 1; align-items: flex-start;">
            <div class="flex" style="gap: 8px; align-items: center;">
              <div
                style="z-index:1; border-radius: 16px; height: 80px; width: 80px; background-position: center; background-repeat: no-repeat; background-size: cover; background-image: url('data:image/jpg;base64,${loglogo?.toString('base64')}')">
              </div>
              <span class="cg-heading-2 cg-text-main">${data.title}</span>
            </div>
            <svg width="40" height="40" viewBox="0 0 41 39" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="21.7509" cy="19.4792" r="17.3954" stroke="#fcfcfc" stroke-width="2.50782" />
              <path fill-rule="evenodd" clip-rule="evenodd"
                  d="M21.5654 2.47534C12.1747 2.47534 4.56201 10.088 4.56201 19.4787C4.56201 28.8694 12.1747 36.4821 21.5654 36.4821H21.7512V2.47534H21.5654ZM6.98108 18.3024C8.52346 16.5927 10.4872 15.1933 12.7323 14.7287C15.0216 14.255 17.4739 14.7815 19.8687 16.6912L18.6179 18.2598C16.6438 16.6857 14.7898 16.3517 13.1388 16.6933C11.4436 17.0441 9.83311 18.1361 8.47073 19.6462L6.98108 18.3024Z"
                  fill="#fcfcfc" />
              <path fill-rule="evenodd" clip-rule="evenodd"
                  d="M30.9641 14.7277C33.2092 15.1923 35.1729 16.5917 36.7153 18.3014L35.2257 19.6453C33.8633 18.1351 32.2528 17.0432 30.5576 16.6924C28.9067 16.3507 27.0526 16.6847 25.0785 18.2588L23.8277 16.6902C26.2226 14.7805 28.6748 14.254 30.9641 14.7277Z"
                  fill="#fcfcfc" />
              <path d="M11.4086 20.0116L21.8663 38.125H0.950828L11.4086 20.0116Z" fill="#fcfcfc" />
            </svg>
          </div>

          <div class="flex" style="align-self: stretch; align-items: flex-end; z-index:1; gap: 16px;">
            <div class="flex flex-col cg-text-main" style="gap: 4px; align-items: flex-start; align-self: stretch; flex: 1;">
              <div class="flex cg-text-lg-400 cg-text-secondary" style="align-items: center; gap: 4px;">
                ${data.official
                  ? `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <g filter="url(#filter0_dd_28684_1536)">
                  <path fill-rule="evenodd" clip-rule="evenodd" d="M10.0421 2.74867C9.81994 2.7801 9.59575 2.70727 9.43451 2.55131L8.50551 1.65268C8.22357 1.37996 7.77616 1.37996 7.49422 1.65268L6.56522 2.55131C6.40398 2.70727 6.17979 2.7801 5.95767 2.74867L4.67826 2.56761C4.28986 2.51264 3.92786 2.77559 3.86003 3.16194L3.63659 4.43466C3.59781 4.65552 3.45932 4.84614 3.26125 4.95128L2.11936 5.55741C1.77292 5.7413 1.63471 6.16679 1.80696 6.51918L2.37463 7.6805C2.47315 7.88206 2.47314 8.11781 2.37458 8.31936L1.80709 9.47993C1.63477 9.83232 1.77297 10.2579 2.11945 10.4418L3.26125 11.0479C3.45932 11.153 3.59781 11.3436 3.63659 11.5645L3.86007 12.8374C3.92788 13.2237 4.28975 13.4866 4.67807 13.4318L5.95779 13.2511C6.17984 13.2197 6.40394 13.2926 6.56512 13.4485L7.49422 14.3472C7.77616 14.6199 8.22357 14.6199 8.50551 14.3472L9.43461 13.4485C9.59579 13.2926 9.81989 13.2197 10.0419 13.2511L11.3217 13.4318C11.71 13.4866 12.0718 13.2237 12.1397 12.8374L12.3631 11.5645C12.4019 11.3436 12.5404 11.153 12.7385 11.0479L13.8803 10.4418C14.2268 10.2579 14.365 9.83232 14.1926 9.47993L13.6251 8.31936C13.5266 8.11781 13.5266 7.88206 13.6251 7.6805L14.1928 6.51918C14.365 6.1668 14.2268 5.7413 13.8804 5.55741L12.7385 4.95128C12.5404 4.84614 12.4019 4.65552 12.3631 4.43466L12.1397 3.16194C12.0719 2.77559 11.7099 2.51264 11.3215 2.56761L10.0421 2.74867ZM5.00169 7.83595C4.74293 8.09671 4.74374 8.51763 5.00351 8.7774L6.4894 10.2633C6.78228 10.5562 7.26028 10.5457 7.54002 10.2402L10.7113 6.77706C10.9594 6.5061 10.9421 6.08559 10.6725 5.83599C10.401 5.58464 9.97686 5.60193 9.72672 5.87453L7.49352 8.3082C7.21367 8.61317 6.73608 8.62343 6.4434 8.33075L5.94678 7.83412C5.68559 7.57294 5.26187 7.57375 5.00169 7.83595Z" fill="url(#paint0_linear_28684_1536)" style=""/>
                  </g>
                  <path fill-rule="evenodd" clip-rule="evenodd" d="M9.8805 3.24679C9.65832 3.27826 9.43405 3.20539 9.27278 3.04935L8.5061 2.30748C8.22414 2.03465 7.77659 2.03465 7.49463 2.30748L6.72795 3.04935C6.56669 3.20539 6.34242 3.27826 6.12023 3.24679L5.06369 3.09716C4.67522 3.04214 4.31313 3.30518 4.24537 3.69164L4.06106 4.74276C4.0223 4.96377 3.88371 5.15451 3.68549 5.25965L2.7427 5.75969C2.39613 5.94351 2.2578 6.36909 2.43008 6.72155L2.89882 7.68057C2.99731 7.88209 2.99731 8.11778 2.89882 8.3193L2.43008 9.27832C2.2578 9.63078 2.39613 10.0564 2.7427 10.2402L3.68549 10.7402C3.88371 10.8454 4.0223 11.0361 4.06106 11.2571L4.24537 12.3082C4.31313 12.6947 4.67522 12.9577 5.06369 12.9027L6.12023 12.7531C6.34242 12.7216 6.56669 12.7945 6.72795 12.9505L7.49463 13.6924C7.77659 13.9652 8.22414 13.9652 8.5061 13.6924L9.27278 12.9505C9.43405 12.7945 9.65832 12.7216 9.8805 12.7531L10.937 12.9027C11.3255 12.9577 11.6876 12.6947 11.7554 12.3082L11.9397 11.2571C11.9784 11.0361 12.117 10.8454 12.3152 10.7402L13.258 10.2402C13.6046 10.0564 13.7429 9.63078 13.5707 9.27832L13.1019 8.3193C13.0034 8.11778 13.0034 7.88209 13.1019 7.68057L13.5707 6.72155C13.7429 6.36909 13.6046 5.94351 13.258 5.75969L12.3152 5.25965C12.117 5.15451 11.9784 4.96377 11.9397 4.74276L11.7554 3.69164C11.6876 3.30518 11.3255 3.04214 10.937 3.09716L9.8805 3.24679ZM5.00204 7.83572C4.743 8.09657 4.74376 8.51781 5.00375 8.77772L6.4899 10.2634C6.7828 10.5563 7.26074 10.5457 7.54044 10.2403L10.7118 6.77706C10.9599 6.50609 10.9426 6.08558 10.673 5.83598C10.4015 5.58464 9.97736 5.60192 9.72722 5.87452L7.49402 8.3082C7.21417 8.61317 6.73658 8.62342 6.4439 8.33074L5.94724 7.83408C5.68605 7.57289 5.26233 7.57362 5.00204 7.83572Z" fill="url(#paint1_linear_28684_1536)" style=""/>
                  <path fill-rule="evenodd" clip-rule="evenodd" d="M4.53407 8.30685C4.53372 8.3072 4.53372 8.30777 4.53407 8.30813L6.48987 10.2634C6.78277 10.5562 7.26071 10.5456 7.54042 10.2402L11.1363 6.31331C11.1471 6.30395 11.1639 6.31164 11.1638 6.32591L11.1609 7.15425C11.1605 7.25192 11.1238 7.34594 11.0578 7.41797L7.54049 11.259C7.26076 11.5645 6.78276 11.575 6.48987 11.2821L4.67009 9.46233C4.58257 9.37481 4.53328 9.25618 4.53302 9.1324L4.53126 8.30631C4.53125 8.30523 4.53243 8.30456 4.53336 8.30512L4.5339 8.30544C4.5344 8.30574 4.53448 8.30644 4.53407 8.30685Z" fill="#D18800" style="fill:#D18800;fill:color(display-p3 0.8196 0.5333 0.0000);fill-opacity:1;"/>
                  <defs>
                  <filter id="filter0_dd_28684_1536" x="-2.2666" y="-1.55176" width="20.5332" height="21.1035" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
                  <feFlood flood-opacity="0" result="BackgroundImageFix"/>
                  <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
                  <feOffset dy="1"/>
                  <feGaussianBlur stdDeviation="2"/>
                  <feComposite in2="hardAlpha" operator="out"/>
                  <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.06 0"/>
                  <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_28684_1536"/>
                  <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
                  <feOffset/>
                  <feGaussianBlur stdDeviation="0.5"/>
                  <feComposite in2="hardAlpha" operator="out"/>
                  <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.2 0"/>
                  <feBlend mode="normal" in2="effect1_dropShadow_28684_1536" result="effect2_dropShadow_28684_1536"/>
                  <feBlend mode="normal" in="SourceGraphic" in2="effect2_dropShadow_28684_1536" result="shape"/>
                  </filter>
                  <linearGradient id="paint0_linear_28684_1536" x1="3.20787" y1="1.81448" x2="13.1511" y2="15.6421" gradientUnits="userSpaceOnUse">
                  <stop stop-color="#F4E72A" style="stop-color:#F4E72A;stop-color:color(display-p3 0.9569 0.9059 0.1647);stop-opacity:1;"/>
                  <stop offset="0.539" stop-color="#CD8105" style="stop-color:#CD8105;stop-color:color(display-p3 0.8039 0.5059 0.0196);stop-opacity:1;"/>
                  <stop offset="0.68" stop-color="#CB7B00" style="stop-color:#CB7B00;stop-color:color(display-p3 0.7961 0.4824 0.0000);stop-opacity:1;"/>
                  <stop offset="1" stop-color="#F4E72A" style="stop-color:#F4E72A;stop-color:color(display-p3 0.9569 0.9059 0.1647);stop-opacity:1;"/>
                  </linearGradient>
                  <linearGradient id="paint1_linear_28684_1536" x1="3.89491" y1="2.46902" x2="11.8993" y2="13.9148" gradientUnits="userSpaceOnUse">
                  <stop stop-color="#F9E87F" style="stop-color:#F9E87F;stop-color:color(display-p3 0.9765 0.9098 0.4980);stop-opacity:1;"/>
                  <stop offset="0.406" stop-color="#E2B719" style="stop-color:#E2B719;stop-color:color(display-p3 0.8863 0.7176 0.0980);stop-opacity:1;"/>
                  <stop offset="0.989" stop-color="#E2B719" style="stop-color:#E2B719;stop-color:color(display-p3 0.8863 0.7176 0.0980);stop-opacity:1;"/>
                  </linearGradient>
                  </defs>
                  </svg>
                  <span>Official Community</span>`
                  : '<span>Community</span>'}
                <span>·</span>
                <span>${data.memberCount} members</span>
              </div>
              <div class="cg-text-main cg-heading-3">${data.shortDescription}</div>
            </div>

            <span class="cg-text-lg-400 bg-full-white cg-text-full-black" style="padding: 8px 16px; border-radius: 12px; width: fit-content;">Join community</span>
          </div>
        </div>`,
        height: 268,
        width: 512
      });

      if (!!imageBuffer) {
        const outputBuffer = await fileHelper.convertToJpg(imageBuffer, 512, 268);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=30, must-revalidate');
        res.status(200).send(outputBuffer);
        return;
      }
    }
    res.sendStatus(404);
  } catch (e) { handleError(res, e) }
});
getRoutesRouter.get(new RegExp(`/${config.URL_COMMUNITY}/([^/]+)(/.*)?`), async (req, res) => {
  try {
    const communityUrl = req.params[0];
    const baseUrl = [
      getWorkingHost(req.hostname),
      config.URL_COMMUNITY,
      communityUrl,
    ].join('/');

    const data = await communityHelper.getCommunitySocialPreview({ communityUrl });
    if (!data) {
      res.redirect("/");
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Cache-Control', 'public, max-age=30, must-revalidate');
      const indexHtml = makeIndexHtml(
        data.title || '',
        data.shortDescription,
        "website",
        `${baseUrl}/`,
        `${baseUrl}/image.jpeg`,
      );
      res.send(indexHtml);
    }
  } catch (e) { handleError(res, e) }
});

getRoutesRouter.get('/sitemap.xml', async (req, res) => {
  try {
    const sitemap = await communityHelper.getSitemap();

    res.setHeader('X-Robots-Tag', 'noindex, follow');
    res.setHeader('Content-Type', 'application/xml');
    res.send(sitemap);
    
  } catch (e) { handleError(res, e) }
});

//////////////// TWITTER ////////////////

// twitter callback
getRoutesRouter.get('/twitter-callback', passport.authenticate("twitter", {
  successReturnToOrRedirect: '/twitter-login',
  failureRedirect: '/',
}));

// Fallback twitter callback route for when service worker
// is not installed (return indexhtml either way)
getRoutesRouter.get('/twitter-login', async (request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.send(indexhtml);
});

// verify-email callback route for when service worker
// is not installed (return indexhtml either way)
getRoutesRouter.get('/verify-email', async (request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.send(indexhtml);
});

getRoutesRouter.get('/token-sale', async (request, response) => {
  response.redirect('/token');
});

getRoutesRouter.get('/store', async (request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.send(indexhtml);
});

// token-sale callback route for when service worker
// is not installed (return indexhtml either way)
getRoutesRouter.get('/token', async (request, response) => {
  const host = getWorkingHost(request.hostname);
  response.setHeader('Content-Type', 'text/html');
  response.setHeader('Cache-Control', 'public, max-age=30, must-revalidate');
  const indexHtml = makeIndexHtml(
    'CG Token Hub',
    'Welcome to the official CG Token hub — your go-to for all the latest stats and info, plus the chance to earn tokens regularly. Swing by often and join the action! 🚀💰',
    "website",
    `${host}/token/`,
    `${host}/images/tokensale_social_preview.png`,
  );
  response.send(indexHtml);
});

getRoutesRouter.get('/push-icon', async (request, response) => {
  const userId = request.query["userId"] as string | undefined;
  const communityId = request.query["communityId"] as string | undefined;

  try {
    if (!!userId) {
      const { error } = validators.Common.Uuid.required().validate(userId);
      if (!!error) throw new Error(errors.server.VALIDATION);

      const user = await userHelper.getSocialPreviewData({ userId });
      if (user) {
        const imageId = user.accounts.find(a => a.type === user.displayAccount)?.imageId || user.accounts[0]?.imageId;
        if (!!imageId) {
          const imageBuffer = await fileHelper.getFile(imageId);
          if (imageBuffer) {
            const outputBuffer = await fileHelper.makeCircleImage(imageBuffer, 110);
            response.setHeader('Content-Type', 'image/png');
            response.setHeader('Cache-Control', 'public, max-age=60');
            response.status(200).send(outputBuffer);
            return;
          }
        }
      }
    }
    else if (!!communityId) {
      const { error } = validators.Common.Uuid.required().validate(communityId);
      if (!!error) throw new Error(errors.server.VALIDATION);

      const community = await communityHelper.getCommunitySocialPreview({ communityId });
      if (community && (community.logoSmallId || community.logoLargeId)) {
        const imageBuffer = await fileHelper.getFile(community.logoSmallId);
        if (imageBuffer) {
          const outputBuffer = await fileHelper.makeRoundedRectImage(imageBuffer, 110, 15);
          response.setHeader('Content-Type', 'image/png');
          response.setHeader('Cache-Control', 'public, max-age=60');
          response.status(200).send(outputBuffer);
          return;
        }
      }
    }
    throw new Error(errors.server.NOT_FOUND);
  }
  catch (e) {
    handleError(response, e);
  }
});

async function getGatedFileData(filename: string, userId: string) {
  const fileData = await pool.query<{ type: 'download' | 'video', isAllowed: boolean }>(`
    SELECT rgf.type, ruu."userId" IS NOT NULL as "isAllowed"
    FROM role_gated_files rgf
    LEFT JOIN roles_users_users ruu
      ON ruu."roleId" = rgf."roleId"
      AND ruu."userId" = $2
      AND ruu.claimed = TRUE
    WHERE rgf.filename = $1
  `, [filename, userId]);

  if (fileData.rows.length < 1) {
    return null;
  }
  return fileData.rows[0];
}

getRoutesRouter.get('/gated-videos/:filename', async (req, res) => {
  const { user } = req.session;
  const { filename } = req.params;

  try {
    if (!user) {
      res.sendStatus(403);
      return; 
    }

    const fileData = await getGatedFileData(filename, user.id);
    if (!fileData) {
      res.sendStatus(404);
      return;
    }
    else if (!fileData.isAllowed) {
      res.sendStatus(403);
      return;
    }
    else if (fileData.type !== 'video') {
      res.status(500).send('Incorrect file type');
      return;
    }

    let contentType: string;
    if (filename.endsWith('.mp4')) {
      contentType = 'video/mp4';
    }
    else {
      res.status(500).send('Unknown file type');
      return;
    }

    const filePath = path.join('/', 'api_data', filename);
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;
      const file = fs.createReadStream(filePath, { start, end });
      const headers = {
        'Content-Type': contentType,
        'Content-Length': chunkSize,
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
      };
      res.status(206).set(headers);
      file.pipe(res);
    } else {
      const headers = {
        'Content-Type': contentType,
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes',
      };
      res.status(200).set(headers);
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('Internal server error');
  }
});

getRoutesRouter.get('/gated-files/:filename', async (req, res) => {
  const { user } = req.session;
  const { filename } = req.params;

  try {
    if (!user) {
      res.sendStatus(403);
      return; 
    }

    const fileData = await getGatedFileData(filename, user.id);
    if (!fileData) {
      res.sendStatus(404);
      return;
    }
    else if (!fileData.isAllowed) {
      res.sendStatus(403);
      return;
    }
    else if (fileData.type !== 'download') {
      res.status(500).send('Incorrect file type');
      return;
    }

    let contentType: string;
    if (filename.endsWith('.pdf')) {
      contentType = 'application/pdf';
    }
    else {
      res.status(500).send('Unknown file type');
      return;
    }

    const filePath = path.join('/', 'api_data', filename);
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;

    const headers = {
      'Content-Type': contentType,
      'Content-Length': fileSize,
    };
    res.status(200).set(headers);
    fs.createReadStream(filePath).pipe(res);

  } catch (err) {
    console.error(err);
    res.status(500).send('Internal server error');
  }
});

export default getRoutesRouter;
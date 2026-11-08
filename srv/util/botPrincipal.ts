// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { type NextFunction, type Request, type Response } from "express";
import errors from "../common/errors";
import serverconfig from "../serverconfig";
import botTokenHelper, { type BotTokenPrincipal } from "../repositories/botTokens";

declare global {
  namespace Express {
    interface Request {
      botPrincipal?: BotTokenPrincipal;
    }
  }
}

const allowedBotRoutes = new Set<string>();

export function allowBotRoute(method: 'GET' | 'POST', path: `/${string}`) {
  allowedBotRoutes.add(`${method} ${path}`);
}

function sendAuthError(response: Response, status: 400 | 401 | 403, error: string) {
  response.status(status).send({ status: 'ERROR', error });
}

export async function botAuthenticationMiddleware(request: Request, response: Response, next: NextFunction) {
  const authorization = request.get('authorization');
  if (!authorization) {
    next();
    return;
  }
  if (request.cookies?.[serverconfig.SESSION_COOKIE_NAME] !== undefined) {
    sendAuthError(response, 400, errors.server.INVALID_REQUEST);
    return;
  }
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  if (!match) {
    sendAuthError(response, 401, errors.server.LOGIN_REQUIRED);
    return;
  }
  try {
    const principal = await botTokenHelper.authenticate(match[1]);
    if (!principal) {
      sendAuthError(response, 401, errors.server.LOGIN_REQUIRED);
      return;
    }
    request.botPrincipal = principal;
    next();
  } catch (error) {
    console.error('Bot token authentication failed');
    sendAuthError(response, 401, errors.server.LOGIN_REQUIRED);
  }
}

export function botAllowlistMiddleware(request: Request, response: Response, next: NextFunction) {
  if (!request.botPrincipal) {
    next();
    return;
  }
  if (!allowedBotRoutes.has(`${request.method.toUpperCase()} ${request.path}`)) {
    sendAuthError(response, 403, errors.server.NOT_ALLOWED);
    return;
  }
  next();
}

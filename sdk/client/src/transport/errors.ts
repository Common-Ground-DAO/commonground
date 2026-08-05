/**
 * API error codes and the SDK's error type.
 *
 * Contract: srv/common/errors.ts (`errors.server`) — every RPC failure is
 * `{status:"ERROR", error:<code>}` delivered with HTTP 200 (srv/api/util.ts
 * handleError). Non-200 statuses occur only on the bot-auth middleware and
 * non-envelope GET routes.
 */

/** Machine error codes the server can return (srv/common/errors.ts). */
export type ApiErrorCode =
  | "LOGIN_REQUIRED"
  | "NOT_ALLOWED"
  | "NOT_FOUND"
  | "NOT_SUPPORTED"
  | "EMAIL_DISABLED"
  | "UNKNOWN"
  | "INVALID_REQUEST"
  | "INVALID_SECRET"
  | "INVALID_SIGNATURE"
  | "VALIDATION"
  | "EXISTS_ALREADY"
  | "DELETED"
  | "INTERNAL"
  | "DUPLICATE_KEY"
  | "SERVICE_UNAVAILABLE"
  | "WALLET_ALREADY_IN_USE"
  | "WALLET_OWNERSHIP_CHANGE_7DAYS"
  | "ROLE_LIMIT_EXCEEDED"
  | "NO_COMMUNITY_TOKEN"
  | "CAPTCHA_FAILED"
  | "INSUFFICIENT_TRUST"
  | "INSUFFICIENT_BALANCE"
  | "RATE_LIMIT_EXCEEDED"
  | "LIMIT_EXCEEDED"
  | "FILESIZE_EXCEEDED"
  | "EMAIL_VALIDATION_FAILED"
  | "CALL_LIMIT_EXCEEDED"
  | "BROADCASTERS_LIMIT_EXCEEDED"
  | "COMMUNITY_JOIN_IN_WAIT_PERIOD"
  | "PASSKEY_USER_NULL"
  | "ALREADY_LOGGED_IN"
  | "SEND_ARTICLE_LIMIT_EXCEEDED"
  | "EVENT_SCHEDULE_IN_THE_PAST"
  | "EVENT_TOO_LONG"
  | "EVENT_ONGOING"
  | "EVENT_INVALID_TYPE_CHANGE"
  | "VERIFY_EMAIL_INVALID_TOKEN"
  | "VERIFY_EMAIL_EXPIRED_TOKEN"
  | "VERIFY_EMAIL_ALREADY_VERIFIED"
  | "VERIFY_EMAIL_TOKEN_GENERATION_FAILED"
  | "NO_USERS_TO_SEND_EMAIL"
  | "MISSING_CALL_DATA"
  | "UPDATE_EVENT_CREATE_CALL_FAILED"
  | "NOT_IMPLEMENTED"
  | "FAILED_TO_FETCH_ACCESS_TOKEN"
  | "SIGNED_REQUEST_EXPIRED"
  | "DUPLICATED_SIGNED_REQUEST"
  | "PLUGIN_LIMIT_EXCEEDED"
  | "TWITTER_LOGIN_FAILED"
  | "TWITTER_FETCH_FAILED"
  | "TWITTER_INTERNAL_ERROR"
  | "TWITTER_SESSION_EXPIRED"
  | "TWITTER_TWEET_FAILED"
  | "LUKSO_PROFILE_NOT_FOUND"
  | "LUKSO_LOGIN_FAILED"
  | "LUKSO_USERNAME_NOT_FOUND"
  | "LUKSO_FETCH_TIMEOUT"
  | "LUKSO_FETCH_FAILED"
  | "LUKSO_INVALID_FORMAT"
  | "UNKNOWN_ACCOUNT_TYPE"
  | "ACCOUNT_DOES_NOT_EXIST"
  | (string & {}); // forward-compatible: unknown codes still flow through

/** An RPC call answered `{status:"ERROR"}`. `code` is the server error code. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  /** HTTP status of the response (usually 200 — RPC errors ride 200). */
  readonly httpStatus: number;
  readonly route: string;

  constructor(code: ApiErrorCode, route: string, httpStatus: number) {
    super(`${route} failed: ${code}`);
    this.name = "ApiError";
    this.code = code;
    this.route = route;
    this.httpStatus = httpStatus;
  }
}

/** The server answered something that is not a valid envelope at all. */
export class TransportError extends Error {
  readonly httpStatus: number | undefined;
  readonly route: string;

  constructor(message: string, route: string, httpStatus?: number) {
    super(`${route}: ${message}`);
    this.name = "TransportError";
    this.route = route;
    this.httpStatus = httpStatus;
  }
}

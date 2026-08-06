/**
 * HTTP transport for the Common Ground RPC API.
 *
 * Contract (srv/api/util.ts registerPostRoute, srv/util/express.ts):
 * - Every RPC method is `POST /api/v2/<Domain>/<method>` with a JSON body.
 * - Success: HTTP 200 `{status:"OK", data?:...}`.
 * - Failure: usually HTTP 200 `{status:"ERROR", error:<code>}` — the HTTP
 *   status is NOT the error signal; the envelope is.
 * - Auth is a session cookie (Set-Cookie on login; httpOnly; 12h rolling).
 *   Requests without an Origin header bypass the CORS allowlist, so a
 *   headless client simply doesn't send one.
 * - A few GET routes (Captcha/*, Instance/config) return bare JSON without
 *   the envelope.
 */

import { CookieJar } from "./cookies.js";
import { ApiError, TransportError } from "./errors.js";

export interface HttpTransportOptions {
  /** Instance origin, e.g. "https://cg.mogged.eu". Trailing slashes are stripped. */
  baseUrl: string;
  /** Override fetch (tests, instrumentation). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Extra headers sent on every request (e.g. bot `authorization`). */
  headers?: Record<string, string>;
  /** Route base under the origin. Default "/api/v2"; bot clients use
   * "/api/bot/v1" (nginx rewrites it to the /BotV1 router). */
  apiBasePath?: string;
  /** When false, never attach the cookie jar (bot bearer auth forbids
   * co-sending a cookie). Default true. */
  useCookies?: boolean;
}

type Envelope<T> =
  | { status: "OK"; data?: T }
  | { status: "ERROR"; error: string };

export class HttpTransport {
  readonly baseUrl: string;
  readonly jar = new CookieJar();
  private readonly fetchImpl: typeof fetch;
  private readonly extraHeaders: Record<string, string>;
  private readonly apiBasePath: string;
  private readonly useCookies: boolean;

  constructor(options: HttpTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.extraHeaders = options.headers ?? {};
    this.apiBasePath = (options.apiBasePath ?? "/api/v2").replace(/\/+$/, "");
    this.useCookies = options.useCookies ?? true;
  }

  private cookieHeaderOrUndefined(): string | undefined {
    return this.useCookies ? this.jar.cookieHeader() : undefined;
  }

  /** POST /api/v2/<route> and unwrap the {status,data|error} envelope. */
  async call<TResponse, TRequest = unknown>(route: string, body?: TRequest): Promise<TResponse> {
    const url = `${this.baseUrl}${this.apiBasePath}/${route}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.extraHeaders,
    };
    const cookie = this.cookieHeaderOrUndefined();
    if (cookie) headers.cookie = cookie;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body ?? {}),
        redirect: "manual",
      });
    } catch (e) {
      throw new TransportError(`network error: ${(e as Error).message}`, route);
    }
    this.jar.storeFrom(response.headers.getSetCookie());

    let envelope: Envelope<TResponse>;
    try {
      envelope = (await response.json()) as Envelope<TResponse>;
    } catch {
      throw new TransportError("response is not JSON", route, response.status);
    }
    if (envelope.status === "OK") {
      return envelope.data as TResponse;
    }
    if (envelope.status === "ERROR") {
      throw new ApiError(envelope.error, route, response.status);
    }
    throw new TransportError("response is not an API envelope", route, response.status);
  }

  /**
   * POST multipart/form-data (the one non-JSON route: File/uploadImage).
   * Asymmetric envelope (FINDINGS F-09): errors arrive as the standard
   * {status:"ERROR"} envelope, but success is the BARE result object.
   */
  async callMultipart<TResponse>(route: string, form: FormData): Promise<TResponse> {
    const url = `${this.baseUrl}${this.apiBasePath}/${route}`;
    const headers: Record<string, string> = { ...this.extraHeaders };
    const cookie = this.cookieHeaderOrUndefined();
    if (cookie) headers.cookie = cookie;

    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: "POST", headers, body: form, redirect: "manual" });
    } catch (e) {
      throw new TransportError(`network error: ${(e as Error).message}`, route);
    }
    this.jar.storeFrom(response.headers.getSetCookie());
    let body: (Envelope<TResponse> & Partial<TResponse>) | TResponse;
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new TransportError("response is not JSON", route, response.status);
    }
    const maybeEnvelope = body as Envelope<TResponse>;
    if (maybeEnvelope.status === "ERROR") {
      throw new ApiError(maybeEnvelope.error, route, response.status);
    }
    if (maybeEnvelope.status === "OK") return (maybeEnvelope as { data?: TResponse }).data as TResponse;
    return body as TResponse;
  }

  /** GET a bare-JSON route (no envelope): Captcha/*, Instance/config. */
  async getJson<T>(route: string): Promise<T> {
    const url = `${this.baseUrl}${this.apiBasePath}/${route}`;
    const headers: Record<string, string> = { ...this.extraHeaders };
    const cookie = this.cookieHeaderOrUndefined();
    if (cookie) headers.cookie = cookie;

    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers, redirect: "manual" });
    } catch (e) {
      throw new TransportError(`network error: ${(e as Error).message}`, route);
    }
    this.jar.storeFrom(response.headers.getSetCookie());
    if (!response.ok) {
      throw new TransportError(`unexpected HTTP ${response.status}`, route, response.status);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new TransportError("response is not JSON", route, response.status);
    }
  }
}

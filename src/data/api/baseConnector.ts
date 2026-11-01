// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import urlConfig from "../util/urls";
import errors from "common/errors";
import stepUpManager, { stepUpRequestForRoute } from "../auth/stepUp";
import securityStepState from "../auth/securityStep";
import { ApiRequestError } from "./apiError";

function unwrapResult<T>(result: API.AjaxResponse<T> | undefined, fallbackError: string): T {
  if (result && result.status === "OK") {
    if ('data' in result) {
      return result.data as T;
    }
    return undefined as unknown as T;
  }
  if (result && result.status === "ERROR" && result.error) {
    throw new ApiRequestError(result.error, result.retryAfterSeconds, result.limit);
  }
  throw new Error(fallbackError);
}

export default class BaseApiConnector {
  protected baseUrl: string;
  private baseUri: string;

  constructor(baseUri: string) {
    this.baseUri = baseUri;
    this.baseUrl = `${urlConfig.API_URL}${baseUri}`;
  }

  protected async ajax<T>(method: "GET", uri: string): Promise<T>
  protected async ajax<T>(method: "PUT"|"POST"|"UPDATE", uri: string, data?: any): Promise<T>
  protected async ajax<T>(method: "GET"|"PUT"|"POST"|"UPDATE", uri: string, data?: any): Promise<T> {
    const getData = () => new Promise<API.AjaxResponse<T>>((resolve, reject) => {
      let rejected = false;
      const oReq = new XMLHttpRequest();
      oReq.responseType = "text";
      oReq.onreadystatechange = () => {
        if (oReq.readyState === 4) {
          if (oReq.status === 200) {
            resolve(JSON.parse(oReq.response));
          }
          else {
            console.warn(`Unexpected oReq status: ${oReq.status.toString()}`, oReq);
            if (!rejected) {
              reject(new Error(`Unexpected status: ${oReq.status.toString()}`));
              rejected = true;
            }
          }
        }
      };
      oReq.onerror = (err) => {
        console.warn(`Error occurred in ajax request`, oReq.statusText, err);
        if (!rejected) {
          reject(err);
          rejected = true;
        }
      }
      const sendBuffer = method === 'POST' && !!data && data instanceof ArrayBuffer;
      oReq.open(method, `${this.baseUrl}${uri}`);
      oReq.withCredentials = true;
      oReq.setRequestHeader('Accept', 'application/json');
      if (sendBuffer) {
        oReq.setRequestHeader('Content-Type', 'application/octet-stream');
        oReq.send(data);
      } else {
        oReq.setRequestHeader('Content-Type', 'application/json');
        if (method === "GET" || data === undefined) {
          oReq.send();
        } else {
          oReq.send(JSON.stringify(data));
        }
      }
    });

    let result = await getData();
    let retried = false;
    let reloggedIn = false;
    let steppedUp = false;
    for (;;) {
      if (result && result.status === "OK") {
        return unwrapResult<T>(result, "Unknown API Response Error");
      }
      if (!result || result.status !== "ERROR" || !result.error) {
        throw new Error(retried ? "Unknown API Retry Response Error" : "Unknown API Error");
      }
      if (result.error === errors.server.LOGIN_REQUIRED && !reloggedIn) {
        // silent device-key re-login, then the same request once more
        reloggedIn = true;
        const loginManager = (await import("data/appstate/login")).default;
        await loginManager.loginRequiredErrorHandler();
      }
      else if (result.error === errors.server.REAUTH_REQUIRED && !steppedUp && stepUpManager.hasHandler) {
        // a sensitive action: the server checks the session's last
        // authentication before any side effect, so after the user confirmed
        // it's them (ReauthDialog) the same request is sent once more — also
        // when it follows a re-login above (at most once each)
        steppedUp = true;
        const confirmed = await stepUpManager.request(stepUpRequestForRoute(`${this.baseUri}${uri}`));
        if (!confirmed) {
          throw new Error(errors.server.REAUTH_REQUIRED);
        }
      }
      else {
        if (result.error === errors.server.SECURITY_STEP_REQUIRED) {
          // the account has to finish the account-security step first: the
          // app shows that step instead of the page (SecurityStepView)
          securityStepState.set(true);
        }
        throw new ApiRequestError(result.error, result.retryAfterSeconds, result.limit);
      }
      retried = true;
      result = await getData();
    }
  }
}

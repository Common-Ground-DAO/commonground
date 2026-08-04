// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import cgIdApi from 'data/api/cgid';
import UAParser from 'ua-parser-js';
import {
  startAuthentication,
} from '@simplewebauthn/browser';

import errors from 'common/errors';
import { useParams } from 'react-router-dom';
import { randomString } from '../util';
import urlConfig from '../data/util/urls';
import { postEventToOpenerWindow } from './helpers';

// IMPORTANT!
// Since this is intended to become its own repository, make sure not to import
// dependencies that will start their own connection things, like the `connectionManager`

function CgIdLogin({
  hideLoadingScreen,
}: {
  hideLoadingScreen: () => void;
}) {
  const userAgent = UAParser();
  const { frontendRequestId: _frontendRequestId } = useParams<'frontendRequestId'>();
  const frontendRequestId = useMemo(() => {
    return _frontendRequestId || randomString(20);
  }, [_frontendRequestId]);

  const postedResultEventRef = useRef<boolean>(false);

  const [extraInfo, setExtraInfo] = useState<{
    type: "success" | "error";
    message: string;
  } | undefined>();

  const isSafari = (
    userAgent.browser.name === "Mobile Safari" ||
    userAgent.browser.name === "Safari"
  );

  const [buttonDisabled, setButtonDisabled] = useState(!isSafari);

  useEffect(() => {
    const listener = () => {
      if (!postedResultEventRef.current) {
        postedResultEventRef.current = true;
        postEventToOpenerWindow({
          type: "cliCgIdSignResponse",
          frontendRequestId,
          data: {
            type: 'authentication',
            success: false,
            error: "Window closed manually",
          },
        });
      }
    };
    window.addEventListener("beforeunload", listener);
    return () => {
      // only remove listener if unload didn't happen, not sure this
      // is required but seems safer this way - how (if so) does react handle unload?
      setTimeout(() => {
        window.removeEventListener("beforeunload", listener);
      }, 1);
    };
  }, []);

  const signWithPasskey = useCallback(async (autoCall = false) => {
    setExtraInfo(undefined);
    setButtonDisabled(true);

    let step = 0;
    try {
      const options = await cgIdApi.generateAuthenticationOptions({});
      console.log("options", options);
      step = 1;

      const result = await startAuthentication({ optionsJSON: options });
      console.log("result", result);
      step = 2;
    
      const verified = await cgIdApi.verifyAuthenticationResponse({ frontendRequestId, authenticationResponse: result });
      console.log("verified", verified);

      if (verified) {
        if (!postedResultEventRef.current) {
          postedResultEventRef.current = true;
          postEventToOpenerWindow({
            type: "cliCgIdSignResponse",
            frontendRequestId,
            data: {
              type: 'authentication',
              success: true,
            },
          });
        }
        setTimeout(() => {
          window.close();
        }, 0);
      }
      else {
        setExtraInfo({ type: "error", message: "Passkey verification failed" });
      }
    }
    catch (e) {
      if (autoCall && step === 1) {
        console.info("Sign in autocall failed");
      }
      else {
        console.log("Error verifying authentication response", e);
        let message = "Passkey verification failed";
        if (e instanceof Error && e.message === errors.server.NOT_FOUND) {
          message += ': Passkey not found';
        }
        else if (e instanceof Error && e.message === errors.server.DELETED) {
          message += ': This Passkey has been deleted from the account';
        }
        else if (e instanceof Error && e.message === errors.server.INVALID_REQUEST) {
          message += ': Invalid request';
        }
        else {
          message += ': An unknown error occurred';
        }
        setExtraInfo({ type: "error", message });
      }
    }
    setButtonDisabled(false);
  }, []);

  useEffect(() => {
    hideLoadingScreen();
    if (!isSafari) {
      signWithPasskey(true);
    }
  }, []);

  return (
    <>
      <div className="cgid-header">
        <div><img src={`${urlConfig.APP_URL}/icons/128.png`} /></div>
        <div className="mt-4">CG ID</div>
      </div>

      <div className='cgid-action'>
        <button
          className="p-2 border-2 rounded-lg border-palette-info-800"
          onClick={() => { signWithPasskey() }}
          disabled={buttonDisabled}
        >
          Sign in
        </button>
      </div>

      {extraInfo && <div className={`cgid-info-${extraInfo.type}`}>{extraInfo.message}</div>}
    </>
  );
}

export default CgIdLogin;
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useEffect, useMemo, useState, useCallback } from 'react';
import cgIdApi from 'data/api/cgid';

import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
} from '@simplewebauthn/browser';

import errors from 'common/errors';
import { useParams } from 'react-router-dom';
import { randomString } from '../util';
import urlConfig from '../data/util/urls';

// IMPORTANT!
// Since this is intended to become its own repository, make sure not to import
// dependencies that will start their own connection things, like the `connectionManager`

function CgIdHome({
  hideLoadingScreen,
}: {
  hideLoadingScreen: () => void;
}) {
  const { frontendRequestId: _frontendRequestId } = useParams<'frontendRequestId'>();
  const frontendRequestId = useMemo(() => {
    return _frontendRequestId || randomString(20);
  }, [_frontendRequestId]);

  const [userData, setUserData] = useState<
    Awaited<ReturnType<typeof cgIdApi.getLoggedInUserData>> | null | undefined
  >(undefined);

  const [extraInfo, setExtraInfo] = useState<{
    type: "success" | "error";
    message: string;
  } | undefined>();

  useEffect(() => {
    cgIdApi.getLoggedInUserData().then(userData => {
      setUserData(userData);
    });
  }, []);

  useEffect(() => {
    if (userData !== undefined) {
      // user data has been loaded, hide loading screen
      hideLoadingScreen();
    }
  }, [userData]);

  const createNewPasskey = useCallback(async () => {
    if (!!navigator.credentials) {
      setExtraInfo(undefined);

      const options = await cgIdApi.generateRegistrationOptions({
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      console.log("options", options);
  
      const result = await startRegistration({ optionsJSON: options })
      console.log("result", result);
  
      let verified = false;
      try {
        verified = await cgIdApi.verifyRegistrationResponse({ frontendRequestId, registrationResponse: result });
        console.log("verified", verified);

        if (verified) {
          setExtraInfo({ type: "success", message: "Passkey creation successful" });

          cgIdApi.getLoggedInUserData().then(userData => {
            setUserData(userData);
          });
        }
        else {
          setExtraInfo({ type: "error", message: "Passkey creation failed" });
        }
      }
      catch (e) {
        console.log("Error verifying registration response", e);
        let message = "Passkey creation failed";
        setExtraInfo({ type: "error", message });
      }
    }
  }, []);

  const signWithPasskey = useCallback(async () => {
    if (!!navigator.credentials) {
      setExtraInfo(undefined);

      const options = await cgIdApi.generateAuthenticationOptions({});
      console.log("options", options);
  
      const result = await startAuthentication({ optionsJSON: options });
      console.log("result", result);
  
      let verified = false;
      try {
        verified = await cgIdApi.verifyAuthenticationResponse({ frontendRequestId, authenticationResponse: result });
        console.log("verified", verified);

        if (verified) {
          setExtraInfo({ type: "success", message: "Passkey verification successful" });
        }
        else {
          setExtraInfo({ type: "error", message: "Passkey verification failed" });
        }
      }
      catch (e) {
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
    return null;
  }, []);

  if (!browserSupportsWebAuthn()) {
    return (
      <>
        <div className="cgid-header">
          <div><img src={`${urlConfig.APP_URL}/icons/128.png`} /></div>
          <div>CG ID</div>
        </div>

        <div className='cgid-info'>
          <div>Error: Your browser does not support passkeys.</div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="cgid-header">
        <div><img src={`${urlConfig.APP_URL}/icons/128.png`} /></div>
        <div>CG ID</div>
      </div>
      
      <div className='cgid-action'>
        <button onClick={createNewPasskey}>
          Create new Passkey
        </button>
        <button
          onClick={() => {signWithPasskey()}}>
          Sign with Passkey
        </button>
      </div>

      <div className='cgid-info'>
        <div>User ID: {userData?.userId || "Not logged in"}</div>

        {!!userData?.passkeys && <div>Passkeys:</div>}
        {userData?.passkeys.map((passkey) => (
          <div
            key={passkey.credentialID}
            className='cgid-info-passkey'
          >
            ID: {passkey.credentialID}<br/>
            Device type: {passkey.credentialDeviceType}<br/>
            Backed up: {passkey.credentialBackedUp ? "Yes" : "No"}<br/>
            Transports: {passkey.transports?.join(", ") || "None"}
          </div>
        ))}

        <button onClick={async () => {
          await cgIdApi.getLoggedInUserData().then(setUserData);
        }}>
          Refresh
        </button>

        {extraInfo && <div className={`cgid-info-${extraInfo.type}`}>{extraInfo.message}</div>}
      </div>
    </>
  );
}

export default CgIdHome;

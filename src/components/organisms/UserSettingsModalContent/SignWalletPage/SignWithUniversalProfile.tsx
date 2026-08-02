// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useMemo, useRef, useState } from 'react'
import Button from 'components/atoms/Button/Button';
import { useOwnUser } from 'context/OwnDataProvider';
import { useSnackbarContext } from 'context/SnackbarContext';
import userApi from 'data/api/user';
import { PageType } from '../UserSettingsModalContent';
import { useUniversalProfile } from 'context/UniversalProfileProvider';
import LuksoIcon from '../../../atoms/icons/24/Lukso.svg?react';
import luksoApi from 'data/api/lukso';
import errors from 'common/errors';

type Props = {
  setPage: (pageType: PageType) => void;
};

export type SignedState = 'unsigned' | 'signing' | 'signed' | 'cancelled';

const SignWithUniversalProfile: React.FC<Props> = (props) => {
  const { setPage } = props;
  const { showSnackbar } = useSnackbarContext();
  const ownData = useOwnUser();
  const enableWalletRedirect = useRef(false);
  const [walletSignError, setWalletSignError] = useState<string>();
  const [isFetchingData, setIsFetchingData] = useState(false);
  const { confirmOwnership, universalProfileAddress, isConnected } = useUniversalProfile();

  const isConnectedToLukso = useMemo(() => {
    return !!ownData?.accounts?.find(account => account.type === 'lukso');
  }, [ownData?.accounts]);

  const addLuksoAccount = useCallback(async () => {
    if (!!universalProfileAddress) {
      try {
        setIsFetchingData(true);
        const signResult = await confirmOwnership();
        
        if (signResult) {
          await luksoApi.prepareLuksoAction(signResult);
          await userApi.addUserAccount({type:'lukso'});
          setIsFetchingData(false);
          setPage('profile');
          showSnackbar({ type: 'info', text: 'Successfuly linked Universal Profile account' });
        }
      } catch (e) {
        console.error("Error fetching universal profile: ", e);
        setIsFetchingData(false);
        let message = (e as unknown as any).toString();
        if (message) {
          // remove useless prefix
          message = message.replace('Error: ', '');
        }
        if(message === errors.server.EXISTS_ALREADY) {
          setWalletSignError("This universal profile is already linked to another account");
        } else if(message === errors.server.LUKSO_FETCH_TIMEOUT) {
          setWalletSignError("Fetching universal profile data timed out, please try again");
        } else if(message === errors.server.LUKSO_PROFILE_NOT_FOUND) {
          setWalletSignError("Universal profile not found");
        } else if(message === errors.server.INVALID_SIGNATURE) {
          setWalletSignError("Invalid signature");
        } else if(message === errors.server.LUKSO_USERNAME_NOT_FOUND) {
          setWalletSignError("Universal Profile username not found");
        } else {
          setWalletSignError(message);
        }
      }
    }
  }, [universalProfileAddress, confirmOwnership, setPage, showSnackbar]);

  // Redirect to wallet page when wallet is connected
  if (enableWalletRedirect.current && isConnectedToLukso) {
      enableWalletRedirect.current = false;
      setPage('accounts');
    }

  return (
    <div className="flex flex-col gap-4 px-4">
      <div className="flex flex-col gap-4 items-center justify-center">
        <LuksoIcon />
        {isConnected && !isConnectedToLukso && (
          <>
            <div className="flex flex-col items-center justify-center gap-2">
              <span className="cg-heading-3 cg-text-main text-center">
                Universal Profile connected
              </span>
              <span className="cg-text-lg-400 cg-text-main text-center">
                Please confirm ownership of this Universal Profile account
              </span>
            </div>
            <Button
              text="Confirm Ownership"
              className="w-full"
              role="primary"
              onClick={addLuksoAccount}
              loading={isFetchingData}
            />
            {walletSignError && (
              <span className="error cg-text-md-400">{walletSignError}</span>
            )}
          </>
        )}
        {isConnected && isConnectedToLukso && (
          <>
            <div className="flex flex-col items-center justify-center gap-2">
              <span className="cg-heading-3 cg-text-main text-center">
                Universal Profile already connected
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default React.memo(SignWithUniversalProfile);
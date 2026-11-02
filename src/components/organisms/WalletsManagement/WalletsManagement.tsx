// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useEffect, useState } from 'react';

import { useWindowSizeContext } from '../../../context/WindowSizeProvider';
import signatureHelper, { MetamaskData } from '../../../util/signatureHelper';

import IdentitiesEditor from '../IdentitiesEditor/IdentitiesEditor';
import Scrollable from '../../molecules/Scrollable/Scrollable';
import WalletsEditor from '../WalletsEditor/WalletsEditor';

import './WalletsManagement.css';
import ManagementHeader from 'components/molecules/ManagementHeader/ManagementHeader';
import { useNavigate } from 'react-router';
import EmailEditor from '../EmailEditor/EmailEditor';
import { getUrl } from 'common/util';
import { useOwnUser } from 'context/OwnDataProvider';

export default function WalletsManagement() {
  const { isMobile } = useWindowSizeContext();
  const navigate = useNavigate();
  const ownUser = useOwnUser();
  const [metamaskData, setMetamaskData] = useState<MetamaskData>(signatureHelper.getMetamaskData());

const goToProfile = () => {
    if (ownUser) {
      navigate(getUrl({ type: 'user', user: ownUser }));
    } else {
      // if no user is available, redirect to home
      navigate(getUrl({ type: 'home' }));
    }
  }

  useEffect(() => {
    const listener = (data: MetamaskData) => {
      setMetamaskData(data);
    }
    signatureHelper.addMetamaskAccountChangeListener(listener);
    return () => {
      signatureHelper.removeMetamaskAccountChangeListener(listener);
    }
  }, []);

  return (<>
    {isMobile && <ManagementHeader title='Account & Wallets' goBack={goToProfile}/>}
    <Scrollable>
      <div className="wallets-management">
        {!isMobile && <ManagementHeader title='Account & Wallets' goBack={goToProfile}/>}
        <div className='cg-text-lg-400 py-2 cg-text-main'>
          <span>On Common Ground, you can add an email account, wallets and identities. Wallets and identities can be used to claim roles and unlock gated areas inside communities.</span>
        </div>
        <div className="wallets-management-added-wallets-and-identities">
          <EmailEditor />
          <WalletsEditor />
          <IdentitiesEditor metamaskData={metamaskData} />
        </div>
      </div>
    </Scrollable>
  </>
  );
}
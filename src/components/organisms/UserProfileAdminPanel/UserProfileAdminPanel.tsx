// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useCallback, useMemo, useState } from 'react';
import { createSearchParams, useLocation, useNavigate } from "react-router-dom";
import Button from "../../../components/atoms/Button/Button";
import { Tooltip } from "../../../components/atoms/Tooltip/Tooltip";
import { useWindowSizeContext } from "../../../context/WindowSizeProvider";
import UserSettingsList from '../UserSettingsList/UserSettingsList';

import CogIcon from '../../../components/atoms/icons/24/Cog.svg?react';
import NewIcon from '../../../components/atoms/icons/24/New.svg?react';

import "./UserProfileAdminPanel.css";
import { useOwnUser } from 'context/OwnDataProvider';
import BottomSliderModal from 'components/atoms/BottomSliderModal/BottomSliderModal';

export default function UserProfileAdminPanel() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile } = useWindowSizeContext();
  const [isMobileSettingsOpen, setMobileSettingsOpen] = useState(false);

  const ownUser = useOwnUser();

  const openSettings = useCallback(() => {
    if (isMobile) {
      setMobileSettingsOpen(true);
    } else {
      navigate({
        pathname: location.pathname,
        search: createSearchParams({
          userSettings: 'manage-profile'
        }).toString()
      });
    }
  }, [isMobile, location.pathname, navigate]);

  return (
    <div className='user-profile-admin-panel-container'>
      <div className="user-profile-admin-panel">
        {isMobile && <BottomSliderModal
          isOpen={isMobileSettingsOpen}
          onClose={() => setMobileSettingsOpen(false)}
        >
          <UserSettingsList />
        </BottomSliderModal>}
        {!isMobile && <Button role="primary" iconLeft={<CogIcon />} onClick={openSettings} />}
      </div>
    </div>
  );
}
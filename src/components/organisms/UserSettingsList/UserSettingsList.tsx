// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useCallback, useState } from "react";
import { useNavigate } from "react-router";

import DropdownItem from "../../atoms/ListItem/ListItem";
import LogOffModal from "../LogOffModal/LogOffModal";
import { getUrl } from 'common/util';

export type UserProfileSettingsListItem = 'profile' | 'wallets' | 'audio-devices';

type Props = {
  onOptionClick?: () => void;
}

export default function UserSettingsList(props: Props) {
  const { onOptionClick } = props;
  const navigate = useNavigate();
  const [isLogoutModalOpen, setIsLogoutModalOpen] = useState(false);

  const navigateToManagementPage = useCallback((activeSettingItem: UserProfileSettingsListItem) => {
    switch (activeSettingItem) {
      case 'profile': {
        navigate(getUrl({ type: 'profile-settings'}));
        break;
      }
      case 'wallets': {
        navigate(getUrl({ type: 'profile-settings-account-and-wallets'}));
        break;
      }
      case 'audio-devices': {
        navigate(getUrl({ type: 'profile-settings-calls'}));
        break;
      }
    }
    onOptionClick?.()
  }, [navigate, onOptionClick]);

  return (<>
    {/** TODO ask Dominic for proper menu item descriptions */}
    <DropdownItem title="Manage profile" onClick={() => navigateToManagementPage('profile')} />
    <DropdownItem title="Account &amp; Wallets" onClick={() => navigateToManagementPage('wallets')} />
    <DropdownItem title="Media devices" onClick={() => navigateToManagementPage('audio-devices')} />
    <DropdownItem title="Log out" className="cg-text-error" onClick={() => {
      setIsLogoutModalOpen(true)
    }}/>
    <LogOffModal open={isLogoutModalOpen} onClose={() => {
      onOptionClick?.();
      setIsLogoutModalOpen(false);
    }} />
  </>);
}

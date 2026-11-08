// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useNavigate } from "react-router";
import { useWindowSizeContext } from "../../context/WindowSizeProvider";

import WalletsManagement from "../../components/organisms/WalletsManagement/WalletsManagement";

import "./WalletManagementView.css";
import { getUrl } from 'common/util';
import { useOwnUser } from "context/OwnDataProvider";

export default function WalletManagementView() {
  const ownUser = useOwnUser();
  const { isMobile } = useWindowSizeContext();
  const navigate = useNavigate();

  if (!isMobile) {
    // desktop version is available under appropriate modal dialog of profile view
    if (ownUser) {
      navigate(getUrl({ type: 'user', user: ownUser }));
    } else {
      // if no user is available, redirect to home
      navigate(getUrl({ type: 'home' }));
    }
  }
  
  return (
    <div className='wallet-management-view'>
      <WalletsManagement />
    </div>
  );
}
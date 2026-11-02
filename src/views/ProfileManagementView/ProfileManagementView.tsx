// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useNavigate } from "react-router";
import { useWindowSizeContext } from "../../context/WindowSizeProvider";

import UserProfileManagement from "../../components/organisms/UserProfileManagement/UserProfileManagement";
import Scrollable from "../../components/molecules/Scrollable/Scrollable";
import ManagementHeader from "components/molecules/ManagementHeader/ManagementHeader";

import './ProfileManagementView.css';
import { getUrl } from 'common/util';
import { useOwnUser } from "context/OwnDataProvider";

export default function ProfileManagementView() {
  const { isMobile } = useWindowSizeContext();
  const ownUser = useOwnUser();
  const navigate = useNavigate();

  const goToProfile = () => {
    if (ownUser) {
      navigate(getUrl({ type: 'user', user: ownUser }));
    } else {
      // if no user is available, redirect to home
      navigate(getUrl({ type: 'home' }));
    }
  }

  if (!isMobile) {
    // desktop version is available under appropriate modal dialog of profile view
    goToProfile();
  }

  return (
    <div className='profile-management-view'>
      <ManagementHeader title="Manage your profile" goBack={goToProfile} />
      <Scrollable>
        <UserProfileManagement />
      </Scrollable>
    </div>
  );
}
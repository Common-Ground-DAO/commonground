// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './AudioDevicesManagementView.css';
import { useNavigate } from "react-router";
import { useWindowSizeContext } from "../../context/WindowSizeProvider";
import AudioDevicesManagement from "../../components/organisms/AudioDevicesManagement/AudioDevicesManagement";
import Scrollable from "../../components/molecules/Scrollable/Scrollable";
import ManagementHeader from "components/molecules/ManagementHeader/ManagementHeader";
import { getUrl } from 'common/util';
import { useOwnUser } from 'context/OwnDataProvider';

export default function AudioDevicesManagementView() {
  const { isMobile } = useWindowSizeContext();
  const navigate = useNavigate();
  const ownUser = useOwnUser();

  const goToProfile = () => {
    if (ownUser) {
      navigate(getUrl({ type: 'user', user: ownUser }));
    } else {
      // if no user is available, redirect to home
      navigate(getUrl({ type: 'home' }));
    }
  }

  if (!isMobile) {
    goToProfile(); 
  }

  return (
    <div className="audio-devices-management-view">
      <ManagementHeader title="Media devices" goBack={goToProfile} />
      <Scrollable>
        <AudioDevicesManagement />
      </Scrollable>
    </div>
  );
}
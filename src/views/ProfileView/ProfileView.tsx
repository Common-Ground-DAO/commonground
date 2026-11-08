// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import UserProfile from "../../components/organisms/UserProfile/UserProfile";
import Scrollable from "../../components/molecules/Scrollable/Scrollable";

import { useSafeProfileContext } from "context/ProfileProvider";
import SpinnerIcon from '../../components/atoms/icons/16/Spinner.svg?react';

import './ProfileView.css';

export default function ProfileView() {
  const profileContext = useSafeProfileContext();

  if (profileContext.state === 'loading') {
    return (
      <div className="content-full global-caption group-caption">
        <div className='flex justify-center w-full pt-12'>
          <div className='spinner'>
            <SpinnerIcon />
          </div>
        </div>
      </div>
    );
  } else if (profileContext.state === 'loaded') {
    return (
      <div className='profile-view'>
        <Scrollable
          hideOnNoScroll={true}
          hideOnNoScrollDelay={600}
        >
          <UserProfile />
        </Scrollable>
      </div>
    );
  } else {
    console.error("Unknown state", profileContext);
    throw new Error("Unknown state");
  }
}
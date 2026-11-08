// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useMemo } from 'react'
import { AudioWidgetProps } from './AudioWidget';
import MenuNftButton from '../MenuNftButton/MenuNftButton';
import Jdenticon from 'components/atoms/Jdenticon/Jdenticon';
import MicOffIcon from '../../../components/atoms/icons/16/MicOff.svg?react';
import { useOwnUser } from 'context/OwnDataProvider';
import { useCallContext } from 'context/CallProvider';
import { useUserSettingsContext } from 'context/UserSettingsProvider';
import BottomSliderModal from 'components/atoms/BottomSliderModal/BottomSliderModal';
import UserSettingsModalContent from 'components/organisms/UserSettingsModalContent/UserSettingsModalContent';

type Props = AudioWidgetProps & {
  handleProfileClick: () => void;
};

const AudioWidgetMobile: React.FC<Props> = (props) => {
  const { handleProfileClick } = props;
  const { isConnected, isMuted } = useCallContext();
  const { isOpen, setIsOpen: setDrawerOpen, setCurrentPage } = useUserSettingsContext();
  const ownUser = useOwnUser();

  const onButtonClick = useCallback(() => {
    if (!!ownUser?.id) {
      setCurrentPage('home');
      setDrawerOpen(true);
    } else {
      handleProfileClick();
    }
  }, [handleProfileClick, !!ownUser?.id, setCurrentPage]);

  const button = useMemo(() => {
    if (!isConnected) {
      return (
        <MenuNftButton
          icon={<div className='ios-svg-container'>
            <Jdenticon userId={ownUser?.id || ''} onlineStatus={ownUser?.onlineStatus} />
          </div>}
          className="btnProfile"
          isActive={props.isActive}
          onClick={onButtonClick}
          isMobile={true}
          isNFT={false}
        />
      );
    } else {
      return <div className={"audio-widget"} >
        <MenuNftButton
          icon={
            <div className='ios-svg-container'>
              <Jdenticon userId={ownUser?.id || ''} onlineStatus={ownUser?.onlineStatus} />
              {isMuted && <span className="muted-mic-icon active"><MicOffIcon /></span>}
            </div>
          }
          className={`btnProfile ${isMuted ? 'muted' : ''}`}
          isActive={props.isActive}
          onClick={onButtonClick}
          isMobile={true}
          isNFT={false}
        />
      </div>
    }
  }, [isConnected, isMuted, onButtonClick, ownUser?.id, ownUser?.onlineStatus, props.isActive]);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, []);

  const setIsClosed = useCallback((isClosed: boolean) => {
    setDrawerOpen(!isClosed);
  }, []);

  return useMemo(() => {
    return <>
      {button}
      <BottomSliderModal
        isOpen={isOpen}
        onClose={closeDrawer}
        noDefaultScrollable
        floatingMode
        customClassname='audio-widget-mobile'
      >
        <UserSettingsModalContent setIsClosed={setIsClosed} />
      </BottomSliderModal>
    </>;
  }, [button, isOpen]);
}

export default React.memo(AudioWidgetMobile);
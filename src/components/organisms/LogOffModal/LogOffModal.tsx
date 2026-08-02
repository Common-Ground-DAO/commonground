// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Button from "../../../components/atoms/Button/Button";

import CloseIcon from '../../../components/atoms/icons/16/Close-1.svg?react';
import { useNavigate } from "react-router-dom";
import loginManager from "data/appstate/login";
import ScreenAwareModal from "components/atoms/ScreenAwareModal/ScreenAwareModal";
import { getUrl } from "common/util";
import { useState } from "react";
import { usePluginIframeContext } from "context/PluginIframeProvider";

type Props = {
  open: boolean;
  onClose: () => void;
}

export default function LogOffModal(props: Props) {
  const navigate = useNavigate();
  const { unloadIframe } = usePluginIframeContext();
  const { open, onClose } = props;
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const logout = async (ev: React.MouseEvent) => {
    ev.preventDefault();
    setIsLoggingOut(true);
    navigate(getUrl({type: 'home'}));
    unloadIframe();
    await new Promise(resolve => setTimeout(resolve, 500));
    try {
      await loginManager.logout();
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoggingOut(false);
    }
    onClose();
  }

  return (
    <ScreenAwareModal title="Log out" onClose={onClose} isOpen={open}>
      <div className="p-4">
        <p className="cg-text-main">Are you sure you want to log out?</p>
        <div className="btnList justify-end gap-4 mt-4">
          <Button
            text="Cancel"
            onClick={onClose}
            role="secondary"
          />
          <Button
            text="Log out"
            iconLeft={<CloseIcon />}
            onClick={logout}
            role="primary"
            loading={isLoggingOut}
          />
        </div>
      </div>
    </ScreenAwareModal>
  );

}
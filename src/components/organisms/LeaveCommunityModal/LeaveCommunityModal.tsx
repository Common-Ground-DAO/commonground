// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Button from "../../../components/atoms/Button/Button";
import Modal from "../../atoms/Modal/Modal";

import CheckmarkFilledIcon from '../../../components/atoms/icons/20/CheckmarkFilled.svg?react';
import CloseIcon from '../../../components/atoms/icons/16/Close-1.svg?react';
import Dialog, { DialogRefHandle } from "../../molecules/Dialog/Dialog";
import { useRef } from "react";
import { useLoadedCommunityContext } from "context/CommunityProvider";
import data from "data";
import { useSnackbarContext } from "context/SnackbarContext";

type Props = {
    open: boolean;
    onClose: () => void;
}

export default function LeaveCommunityModal(props: Props) {
    const { community } = useLoadedCommunityContext();
    const { showSnackbar } = useSnackbarContext();
    const { open, onClose } = props;

    const leaveGroup = async (ev: React.MouseEvent) => {
      ev.preventDefault();
      onClose();
      await data.community.leaveCommunity(community.id);
      showSnackbar({type: 'info', text: `You left ${community.title}`});
    }

    const content: JSX.Element | null = open ? (
      <Modal headerText={`Leave ${community.title}`} close={onClose}>
        <div className="modal-inner">
          <p>Are you sure you want to leave {community.title}? You will lose roles and any member status you have earned, but may rejoin at any time.</p>
          <div className="btnList justify-end gap-4 mt-4">
            <Button
              text="Cancel"
              onClick={onClose}
              role="secondary"
            />
            <Button
              text="Leave community"
              iconLeft={<CloseIcon />}
              onClick={leaveGroup}
              role="primary"
            />
          </div>
        </div>
      </Modal>
    ) : null;

    return content;
}
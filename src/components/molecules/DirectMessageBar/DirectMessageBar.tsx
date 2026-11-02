// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useNavigate } from "react-router";
import { useWindowSizeContext } from "../../../context/WindowSizeProvider";
import { getDisplayName } from "../../../util";
import { getUrl } from "common/util";
import Button from "../../../components/atoms/Button/Button";
import Jdenticon from "../../../components/atoms/Jdenticon/Jdenticon";
import { ArrowLeftIcon, EllipsisVerticalIcon } from '@heroicons/react/20/solid';
import "./DirectMessageBar.css";
import { useUserData } from "context/UserDataProvider";
import ScreenAwarePopover from "components/atoms/ScreenAwarePopover/ScreenAwarePopover";
import { X } from "@phosphor-icons/react";
import chatDatabaseManager from "data/databases/chats";
import ScreenAwareModal from "components/atoms/ScreenAwareModal/ScreenAwareModal";
import { useRef, useState } from "react";
import { PopoverHandle } from "components/atoms/Tooltip/Tooltip";

type Props = {
  contactPersonId?: string;
  chat: Models.Chat.Chat;
};

export default function DirectMessageBar(props: Props) {
  const { contactPersonId } = props;
  const navigate = useNavigate();
  const { isTablet, isMobile } = useWindowSizeContext();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const contactPerson = useUserData(contactPersonId);
  const dropdownRef = useRef<PopoverHandle>(null);

  return (
    <div className="direct-message-bar">
      <div className="direct-message-bar-inner">
        {(isTablet || isMobile) && <Button role="borderless" iconLeft={<ArrowLeftIcon className="w-5 h-5" />} onClick={() => navigate(getUrl({ type: 'chats' }))} />}
        <div className="shrink-0 grow-0">
          <span className="contact-person">
            {!!contactPersonId &&
              <>
                <Jdenticon userId={contactPersonId} onlineStatus={contactPerson?.onlineStatus} predefinedSize="32" />
                <span>{contactPerson ? getDisplayName(contactPerson) : contactPersonId}</span>
              </>}
          </span>
        </div>
        <div className="flex flex-row justify-end shrink-0 grow">
          <ScreenAwarePopover
            ref={dropdownRef}
            triggerContent={<Button role="borderless" iconLeft={<EllipsisVerticalIcon className="w-5 h-5" />} />}
            tooltipContent={<div className="flex flex-col gap-2">
              <Button role="borderless" iconLeft={<X className="w-5 h-5" />} text="Close this chat" onClick={() => {
                dropdownRef.current?.close();
                setIsModalOpen(true);
              }} />
            </div>}
            placement="bottom-end"
            triggerType="click"
            closeOn="toggle"
          />
          <ScreenAwareModal
            isOpen={isModalOpen}
            onClose={() => setIsModalOpen(false)}
            hideHeader={true}
          >
            <div className={`flex flex-col gap-2 ${isMobile ? 'px-4' : ''}`}>
              <h3>Close this chat</h3>
              <p>Are you sure you want to close this chat? The chat can be resumed any time, as long as both users are friends.</p>
              <div className="flex flex-row gap-2 justify-end">
                <Button role="borderless" text="Cancel" onClick={() => setIsModalOpen(false)} />
                <Button role="primary" text="Close" onClick={async () => {
                  await chatDatabaseManager.closeChat(props.chat.id);
                  navigate(getUrl({ type: 'chats' }));
                }} />
              </div>
            </div>
          </ScreenAwareModal>
        </div>
      </div>
    </div>
  );
}
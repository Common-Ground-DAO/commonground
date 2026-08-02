// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from "react";
import { getDisplayName } from "../../../util";
import DisabledMicrophone from '../../../components/atoms/icons/20/MicrofonDisabled.svg?react';

import Jdenticon from "../Jdenticon/Jdenticon";
import UserTooltip from "../../organisms/UserTooltip/UserTooltip";

import './UserTag.css';
import BotBadge from "../BotBadge/BotBadge";

type Props = {
  userData: Pick<Models.User.Data, "id" | "onlineStatus" | 'accounts' | 'displayAccount' | 'isBot'>;
  isMuted?: boolean;
  noOfflineDimming?: boolean;
  listId?: string;
  channelId?: string;
  hideName?: boolean;
  hideStatus?: boolean;

  jdenticonSize?: '40' | '32' | '24' | '20';
  largeNameFont?: boolean;
  nameClassname?: string;
  noBg?: boolean;
}

function UserTag(props: Props) {
  const { userData, listId, channelId, hideStatus, jdenticonSize, largeNameFont, nameClassname, noBg } = props;
  const { id: userId } = userData;
  const onlineStatus = userData.onlineStatus || 'offline';
  const displayName = getDisplayName(userData);

  const offlineClass = !props.noOfflineDimming && (onlineStatus === 'offline' || !onlineStatus) ? "offline" : "";
  const memberItem = (
    <div
      className={`user-tag user-tag-clickable ${offlineClass}${noBg ? ' no-bg' : ''}`}
    >
      <Jdenticon userId={userId} onlineStatus={onlineStatus} hideStatus={hideStatus} predefinedSize={jdenticonSize || '40'} />
      <span className={`flex items-center gap-1 overflow-hidden ${!!nameClassname ? nameClassname : largeNameFont ? 'cg-text-main cg-text-lg-500' : 'cg-text-main cg-text-sm-500'}`}>
        {props.hideName ? '' : displayName}
        {!props.hideName && userData.isBot && <BotBadge />}
        {props.isMuted && <DisabledMicrophone className="w-4 h-4" />}
      </span>
    </div>
  );

  return (
    <UserTooltip
      userId={userId}
      isMessageTooltip={false}
      listId={listId}
      channelId={channelId}
      triggerClassName="flex"
    >
      {memberItem}
    </UserTooltip>
  );
}

export default React.memo(UserTag);

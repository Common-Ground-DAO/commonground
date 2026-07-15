// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from "react";
import Avatar from "boring-avatars";
import config from '../../../common/config';
import { useSignedUrl } from "../../../hooks/useSignedUrl";

import './Jdenticon.css';
import { useUserData } from "context/UserDataProvider";
import { getOnlineStatusName } from "../../../util";

type Props = {
  userId: string;
  iconStyle?: React.CSSProperties;
  onlineStatus?: Models.User.OnlineStatus;
  statusStyle?: React.CSSProperties;
  defaultImageId?: string | null;
  preparedImageUrl?: string;
  predefinedSize?: '40' | '32' | '24' | '20' | '60' | '80';
  floatingBorder?: boolean;
  hideStatus?: boolean;
  accountType?: Models.User.ProfileItemType;
  onClick?: (ev: React.MouseEvent) => void;
}

export default function Jdenticon(props: Props) {
  const { userId, iconStyle, onlineStatus, statusStyle, defaultImageId, preparedImageUrl, predefinedSize, floatingBorder, hideStatus, accountType, onClick } = props;
  const user = useUserData(userId);
  const displayAccount = accountType || user?.displayAccount;
  const profile = user?.accounts.find(acc => acc.type === displayAccount);

  const imageId = !!profile ? profile.imageId : defaultImageId || null;
  const imageUrl = useSignedUrl(imageId);

  let statusIndicator: JSX.Element | undefined = undefined;
  const status = onlineStatus || user?.onlineStatus;
  if (!hideStatus && status !== undefined && status !== 'offline') {
    const statusLabel = user?.isBot
      ? 'Bot runtime connected to Common Ground'
      : getOnlineStatusName(status);
    statusIndicator = (
      <div
        style={statusStyle}
        className="status-container"
        title={statusLabel}
        aria-label={statusLabel}
      >
        <svg width="100%" viewBox="0 0 42 42">
          <circle fill={config.STATUS_COLORS[status]} r={18} cx={21} cy={21} strokeWidth='1px' className='jdenticon-status-circle' vectorEffect='non-scaling-stroke' />
        </svg>
      </div>
    );
  }

  if (!imageId && !preparedImageUrl) {
    return <div className="relative flex justify-center items-center">
      <div
        className={`jdenticon default-avatar${predefinedSize ? ` jdenticon-${predefinedSize}` : ''}${!!onClick ? ` cursor-pointer` : ''}${floatingBorder ? ' floating-border' : ''}`}
        style={{
          ...iconStyle
        }}
        onClick={onClick}
      >
        <Avatar
          size={300} // large size so resizing down is always fine
          name={userId}
          variant="marble"
          colors={["#F2DCC2", "#4449B3", "#4D4D4D", "#757AD2", "#D4B289"]}
        />
        {statusIndicator}
      </div>
    </div>;
  }

  return (
    <div
      className={`jdenticon${predefinedSize ? ` jdenticon-${predefinedSize}` : ''}${!!onClick ? ` cursor-pointer` : ''}${floatingBorder ? ' floating-border' : ''}`}
      style={{
        backgroundImage: `url(${preparedImageUrl || imageUrl})`,
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        backgroundSize: 'cover',
        borderRadius: '50%',
        ...iconStyle
      }}
      onClick={onClick}
    >
      {statusIndicator}
    </div>
  );
}

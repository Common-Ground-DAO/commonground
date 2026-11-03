// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import "./ChannelList.css";
import { useNavigate } from "react-router";
import { getChannelDisplayName, parseIdOrUrl } from "../../../util";
import { getUrl } from "common/util";
import NotificationDot from "components/atoms/NotificationDot/NotificationDot";
import { useLoadedCommunityContext } from "context/CommunityProvider";
import config from "common/config";
import { useMemo, useState } from "react";
import { LockClosedIcon } from "@heroicons/react/20/solid";
import { PredefinedRole } from "common/enums";
import GatedDialogModal, { CalculatedPermission } from "../GatedDialogModal/GatedDialogModal";
import { isPredefinedRolePermission } from "util/predefinedRoles";

type Props = {
  channels: Models.Community.Channel[];
  onChannelClick?: () => void;
}

export function calculateChannelPermissions(community: Models.Community.DetailView, channel: Models.Community.Channel): CalculatedPermission {
  const { rolePermissions } = channel;
  const publicPermission = rolePermissions.find(permission => isPredefinedRolePermission(permission, PredefinedRole.Public));
  const publicCanRead = publicPermission?.permissions.find(permission => permission === 'CHANNEL_READ');
  if (publicCanRead) return null;

  // If any of my roles has access, don't need to check further
  if (community?.myRoleIds.some(roleId => rolePermissions.some(rolePermission => rolePermission.roleId === roleId && rolePermission.permissions.includes('CHANNEL_READ')))) {
    return null;
  }

  const memberPermission = rolePermissions.find(permission => isPredefinedRolePermission(permission, PredefinedRole.Member));
  const memberCanRead = memberPermission?.permissions.find(permission => permission === 'CHANNEL_READ');
  // Also ask for community join if not part of the community
  if (!community || memberCanRead) return {
    type: 'community',
    communityId: community.id
  };

  return {
    type: 'roles',
    communityId: community.id,
    rolePermissions: rolePermissions.filter(role => role.permissions.includes('CHANNEL_READ')),
  };
}

export default function ChannelList(props: Props) {
  const {
    channels,
    onChannelClick
  } = props;
  const { community } = useLoadedCommunityContext();

  const [readableChannels, previewChannels] = useMemo(() => {
    const readableChannels: Models.Community.Channel[] = [];
    const previewChannels: Models.Community.Channel[] = [];

    channels.forEach(c => {
      if (calculateChannelPermissions(community, c) === null) {
        readableChannels.push(c);
      } else {
        previewChannels.push(c);
      }
    });

    return [readableChannels, previewChannels];
  }, [channels, community]);

  return (
    <div className="channel-list">
      {readableChannels.map(channel =>
        <TextChannelItem
          channel={channel}
          key={channel.channelId}
          onChannelClick={onChannelClick}
        />)}
      {previewChannels.map(channel =>
        <TextChannelItem
          channel={channel}
          key={channel.channelId}
          onChannelClick={onChannelClick}
          previewOnly={true}
        />)}
    </div>
  );
}

const channelListRegex = new RegExp(`^/${config.URL_COMMUNITY}/[^/]+/channel/([a-z0-9-~]*)/?`, 'i');

function TextChannelItem(props: {
  channel: Models.Community.Channel,
  onChannelClick?: () => void,
  previewOnly?: boolean,
}) {
  const { pathname } = window.location;
  const { community } = useLoadedCommunityContext();
  const {
    channel,
    onChannelClick,
    previewOnly
  } = props;
  const navigate = useNavigate();
  const [gatedDialogOpen, setGatedDialogOpen] = useState(false);
  const gatedState = calculateChannelPermissions(community, channel);

  const hasUnread = (channel.unread || 0) > 0;

  const handleChannelClick = () => {
    if (previewOnly) {
      setGatedDialogOpen(true);
    } else {
      if (onChannelClick) {
        onChannelClick();
      }
      navigate(getUrl({ type: 'community-channel', community, channel }));
    }
  }

  let active = useMemo(() => {
    const regexRes = channelListRegex.exec(pathname);
    const channelIdOrUrl = regexRes?.[1];
    if (channelIdOrUrl) {
      const whatIsIt = parseIdOrUrl(channelIdOrUrl);
      if (whatIsIt.url) return (channel.url === whatIsIt.url);
      if (whatIsIt.uuid) return (channel.channelId === whatIsIt.uuid);
    }
    return false;
  }, [channel.channelId, channel.url, pathname]);

  return (<>
    <div
      className="text-channel-list-item"
      onClick={handleChannelClick}
      key={channel.channelId}
    >
      <div className={`text-channel-item-info${active ? ' item-active' : ''}${hasUnread ? ' item-unread' : ''}${previewOnly ? ' preview' : ''}`} title={channel.title}>
        {!previewOnly && <span className={`channel-item-icon${hasUnread ? ' icon-unread' : ''}`}>{channel.emoji || '💬'}</span>}
        {previewOnly && <LockClosedIcon className={`channel-item-icon`} />}
        <span className="channel-title-text">{getChannelDisplayName(channel.title)}</span>
        <div className="menu-item-extra">
          {!previewOnly && hasUnread && <NotificationDot />}
          {/* {hasUnread ? <UnreadIndicator no={channel.unread || 0} /> : undefined} */}
          {/* <BiLinkAlt className="channel-item-link-icon menu-item-extra-icon cursor-pointer" onClick={linkClick} /> */}
        </div>
      </div>
    </div>
    <GatedDialogModal
      isOpen={gatedDialogOpen}
      requiredPermissions={gatedState}
      onClose={(redirect) => {
        setGatedDialogOpen(false);
        if (redirect) {
          if (onChannelClick) {
            onChannelClick();
          }
          navigate(getUrl({ type: 'community-channel', community, channel }));
        }
      }}
    />
  </>);
}

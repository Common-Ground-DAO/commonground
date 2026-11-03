// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './PluginCardDetails.css';
import { CaretRight, ShareNetwork, Spinner } from '@phosphor-icons/react';
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import CommunityCard from 'components/molecules/CommunityCard/CommunityCard';
import Scrollable, { PositionData } from 'components/molecules/Scrollable/Scrollable';
import { useMultipleCommunityListViews } from 'context/CommunityListViewProvider';
import pluginsApi from 'data/api/plugins';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { PluginCardInner } from './PluginCard';
import { PluginPermission, PredefinedRole } from 'common/enums';
import { permissionToIcon } from 'views/PluginView/PluginView';
import Button from 'components/atoms/Button/Button';
import { XMarkIcon } from '@heroicons/react/20/solid';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import PluginInstallField from 'components/molecules/PluginInstallField/PluginInstallField';
import { useOwnCommunities } from 'context/OwnDataProvider';
import { useAsyncMemo } from 'hooks/useAsyncMemo';
import communityDatabase from 'data/databases/community';
import { useSnackbarContext } from 'context/SnackbarContext';
import { useNavigate } from 'react-router';
import { getUrl } from 'common/util';
import { useLiveQuery } from 'dexie-react-hooks';
import { isPredefinedRole } from "util/predefinedRoles";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  plugin: Models.Plugin.PluginListView;
};

const LOAD_STEP = 30;
const PIXELS_BEFORE_LOAD_MORE = 100;

const PluginCardDetails: React.FC<Props> = (props) => {
  const { isOpen, onClose: _onClose, plugin } = props;
  const { isMobile } = useWindowSizeContext();
  const [communityIds, setCommunityIds] = useState<string[]>([]);
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(false);
  const isLoadingRef = useRef(false);
  const [isDoneFetching, setIsDoneFetching] = useState(false);
  const communities = useMultipleCommunityListViews(communityIds);
  const { showSnackbar } = useSnackbarContext();
  const navigate = useNavigate();

  const ownerCommunity = useLiveQuery(() => {
    if (!plugin.ownerCommunityId) {
      return null;
    }
    return communityDatabase.getCommunityDetailView(plugin.ownerCommunityId);
  }, []);

  const communityPlugin = useMemo(() => {
    return ownerCommunity?.plugins.find(p => p.pluginId === plugin.pluginId);
  }, [ownerCommunity?.plugins, plugin.pluginId]);

  const myCommunities = useOwnCommunities();
  const myAdminCommunities = useAsyncMemo(async () => {
    const adminCommunities: Models.Community.DetailView[] = [];
    for (const community of myCommunities) {
      const roles = await communityDatabase.getRoles(community.id);
      if (roles.some(role => community.myRoleIds.includes(role.id) && isPredefinedRole(role, PredefinedRole.Admin) && role.type === 'PREDEFINED')) {
        adminCommunities.push(community);
      };
    }
    return adminCommunities;
  }, [myCommunities]);
  const hasAdminCommunities = (myAdminCommunities || []).length > 0;

  const positionCallback = useCallback(async (position: PositionData) => {
    // Check if we should load more
    const shouldLoadMore = position.scrollTop + position.visibleHeight > position.contentHeight - PIXELS_BEFORE_LOAD_MORE;

    if (shouldLoadMore && !isLoadingRef.current && !isDoneFetching) {
      isLoadingRef.current = true;
      setShowLoadingIndicator(true);
      try {
        const response = await pluginsApi.getPluginCommunities({
          pluginId: plugin.pluginId,
          limit: LOAD_STEP,
          offset: communityIds.length
        });

        setCommunityIds([...communityIds, ...response.communityIds]);
        // If we got fewer communities than requested, we've reached the end
        if (response.communityIds.length < LOAD_STEP) {
          setIsDoneFetching(true);
        }
      } catch (error) {
        console.error('Failed to fetch more communities:', error);
      }
      isLoadingRef.current = false;
      setShowLoadingIndicator(false);
    }
  }, [communityIds, isDoneFetching, plugin.pluginId]);

  const onClose = useCallback(() => {
    // if current location is not just store, navigate to store
    if (window.location.pathname !== getUrl({ type: 'appstore' })) {
      navigate(getUrl({ type: 'appstore' }));
    } else {
      _onClose();
    }
  }, [_onClose, navigate]);

  return (<ScreenAwareModal
    isOpen={isOpen}
    onClose={onClose}
    noDefaultScrollable
    hideHeader
    customClassname='plugin-card-details-modal'
  >
    {!isMobile && <div className='absolute top-4 right-4 z-10'>
      <Button
        className="cg-circular"
        role="secondary"
        iconLeft={<XMarkIcon className='w-6 h-6' />}
        onClick={onClose}
      />
    </div>}
    <Scrollable
      positionCallback={positionCallback}
      innerClassName='flex flex-col gap-6 p-6 cg-text-main'
      className='w-full h-full'
    >
      <PluginCardInner
        {...plugin}
      />

      <div className='grid grid-flow-row grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-6'>
        <div className='flex flex-col gap-2 cg-text-secondary cg-text-md-500'>
          <p className='cg-text-secondary cg-text-md-500 wrap-break-word'>Hosted at: {plugin.url}</p>
          {plugin.permissions.mandatory.length > 0 && <div className='flex flex-col gap-1'>
            <span>Mandatory permissions:</span>
            <div className='flex flex-wrap gap-1'>{plugin.permissions.mandatory.map(permission => <PermissionLabel key={permission} permission={permission} />)}</div>
          </div>}
          {plugin.permissions.optional.length > 0 && <div className='flex flex-col gap-1'>
            <span>Optional permissions:</span>
            <div className='flex flex-wrap gap-1'>{plugin.permissions.optional.map(permission => <PermissionLabel key={permission} permission={permission} />)}</div>
          </div>}
        </div>
        <div className='flex flex-col gap-4'>
          <div className='flex flex-col gap-2'>
          <Button
            role='primary'
            text='Launch'
            iconLeft={<CaretRight weight='duotone' className='w-5 h-5' />}
            onClick={() => {
              if (!!ownerCommunity && communityPlugin) {
                navigate(getUrl({ type: 'community-plugin', community: ownerCommunity, plugin: communityPlugin }));
              }
            }}
          />
          <Button
            role='secondary'
            text='Share'
            iconLeft={<ShareNetwork weight='duotone' className='w-5 h-5' />}
            onClick={() => {
              navigator.clipboard.writeText(`${window.location.origin}/store/${plugin.pluginId}`);
              showSnackbar({
                text: 'Plugin URL copied to clipboard',
                type: 'success',
              });
            }}
          />
          </div>
          {hasAdminCommunities && <>
            <h3 className='cg-text-secondary self-center'>or</h3>
            <PluginInstallField plugin={plugin} />
          </>}
        </div>
      </div>
      <div className='flex flex-col gap-4'>
        <h3>Communities using this plugin:</h3>
        <div className='grid grid-flow-row grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2'>
          {communityIds.map((communityId) => {
            const community = communities[communityId];
            if (!community) {
              return null;
            }

            return (<CommunityCard
              key={community.id}
              community={community}
            />);
          })}
        </div>
        {showLoadingIndicator && <div className='flex items-center justify-center'>
          <Spinner className='w-10 h-10 spinner' />
        </div>}
      </div>
    </Scrollable>
  </ScreenAwareModal>);
}

const PermissionLabel: React.FC<{ permission: Models.Plugin.PluginPermission }> = ({ permission }) => {
  const permissionToText = (permission: Models.Plugin.PluginPermission) => {
    switch (permission) {
      case PluginPermission.READ_TWITTER:
        return 'Read Twitter';
      case PluginPermission.READ_EMAIL:
        return 'Read Email';
      case PluginPermission.READ_FARCASTER:
        return 'Read Farcaster';
      case PluginPermission.READ_LUKSO:
        return 'Read Lukso';
      case PluginPermission.READ_FRIENDS:
        return 'Friend list';
      case PluginPermission.ALLOW_CAMERA:
        return 'Use Camera';
      case PluginPermission.ALLOW_MICROPHONE:
        return 'Use Microphone';
      default:
        return permission;
    }
  }

  return <div className='cg-bg-subtle cg-border-m px-2 py-1 flex items-center gap-2 cg-text-sm-500'>
    {permissionToIcon(permission, 'w-4 h-4')}
    {permissionToText(permission)}
  </div>;
};

export default React.memo(PluginCardDetails);
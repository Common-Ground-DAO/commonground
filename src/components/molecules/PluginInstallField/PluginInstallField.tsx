// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './PluginInstallField.css';
import React, { useMemo, useState } from 'react';
import ScreenAwareDropdown from 'components/atoms/ScreenAwareDropdown/ScreenAwareDropdown';
import { ChevronDownIcon } from '@heroicons/react/20/solid';
import Button from 'components/atoms/Button/Button';
import CommunityPhoto from 'components/atoms/CommunityPhoto/CommunityPhoto';
import ListItem from 'components/atoms/ListItem/ListItem';
import pluginsApi from 'data/api/plugins';
import { PredefinedRole } from 'common/enums';
import { useOwnCommunities } from 'context/OwnDataProvider';
import communityDatabase from 'data/databases/community';
import { useAsyncMemo } from 'hooks/useAsyncMemo';
import { useSnackbarContext } from 'context/SnackbarContext';
import { isPredefinedRole } from "util/predefinedRoles";

type Props = {
  plugin: Pick<Models.Plugin.Plugin, 'pluginId' | 'ownerCommunityId'>;
}

const PluginInstallField: React.FC<Props> = (props) => {
  const { plugin } = props;

  const myCommunities = useOwnCommunities();
  const [installLoading, setInstallLoading] = useState(false);
  const [justInstalledId, setJustInstalledId] = useState<string | null>(null);
  const { showSnackbar } = useSnackbarContext();
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
  const [selectedAdminCommunityId, setSelectedAdminCommunityId] = useState<string | null>(null);
  const selectedAdminCommunity = useMemo(() => {
    if (!selectedAdminCommunityId) {
      return null;
    }
    return (myAdminCommunities || []).find(community => community.id === selectedAdminCommunityId);
  }, [selectedAdminCommunityId, myAdminCommunities]);
  const isInstalledOnCommunity = useMemo(() => {
    if (!selectedAdminCommunity) {
      return false;
    }

    return selectedAdminCommunity.plugins.some(plugin => plugin.pluginId === props.plugin.pluginId);
  }, [selectedAdminCommunity, props.plugin.pluginId]);

  if (!hasAdminCommunities) {
    return null;
  }

  return (<div className='flex flex-col gap-4 cg-bg-subtle p-4 cg-border-xl relative'>
    <h3>Install this plugin to:</h3>
    <ScreenAwareDropdown
      overrideZIndex={1100}
      domChildOfTrigger={false}
      triggerContent={<Button
        className='w-full'
        role='secondary'
        text={selectedAdminCommunity ? selectedAdminCommunity.title : 'Select a community'}
        iconLeft={selectedAdminCommunity ? <CommunityPhoto community={selectedAdminCommunity} size='tiny-20' noHover /> : undefined}
        iconRight={<ChevronDownIcon className='w-5 h-5' />}
      />}
      items={(myAdminCommunities || []).map(community => (<ListItem
        propagateEventsOnClick
        key={community.id}
        title={community.title}
        icon={<CommunityPhoto community={community} size='tiny-20' noHover />}
        onClick={() => {
          setSelectedAdminCommunityId(community.id);
        }}
        selected={selectedAdminCommunityId === community.id}
      />
      ))}
    />
    <Button
      role='primary'
      text={isInstalledOnCommunity ? (justInstalledId === plugin.pluginId ? 'Plugin Installed Successfully' : 'Already Installed') : 'Install'}
      disabled={isInstalledOnCommunity}
      loading={installLoading}
      onClick={async () => {
        if (isInstalledOnCommunity || !selectedAdminCommunityId) {
          return;
        }

        setInstallLoading(true);
        try {
          await pluginsApi.clonePlugin({
            pluginId: plugin.pluginId,
            copiedFromCommunityId: plugin.ownerCommunityId,
            targetCommunityId: selectedAdminCommunityId,
          });
          setJustInstalledId(plugin.pluginId);
          showSnackbar({
            type: 'success',
            text: 'Plugin installed successfully',
          });
        } catch (e) {
          showSnackbar({
            type: 'warning',
            text: 'Failed to install plugin, please try again later',
          });
        }
        setInstallLoading(false);
      }}
    />
  </div>)
}

export default React.memo(PluginInstallField);
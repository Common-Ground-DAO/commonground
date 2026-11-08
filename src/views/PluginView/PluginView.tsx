// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useCommunityPluginContext } from 'context/CommunityPluginProvider';
import { useLoadedCommunityContext } from 'context/CommunityProvider';
import { usePluginIframeContext } from 'context/PluginIframeProvider';
import Button from 'components/atoms/Button/Button';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Camera, Microphone, UserCircleCheck, UsersFour, WarningCircle, Wrench } from '@phosphor-icons/react';
import { PluginPermission } from 'common/enums';

import pluginsApi from 'data/api/plugins';
import { PluginPermissionUserSettings } from './PluginViewSettings';
import { useOwnUser } from 'context/OwnDataProvider';
import { useUserSettingsContext } from 'context/UserSettingsProvider';
import { useIsolationMode } from 'context/IsolationModeProvider';
import UserOnboarding from 'components/organisms/UserOnboarding/UserOnboarding';
import { useUserOnboardingContext } from 'context/UserOnboarding';

export const permissionToIcon = (permission: Models.Plugin.PluginPermission, className: string = 'w-8 h-8') => {
  switch (permission) {
    case 'READ_TWITTER':
    case 'READ_LUKSO':
    case 'READ_FARCASTER':
    case 'READ_EMAIL':
      return <UserCircleCheck weight='duotone' className={className} />;
    case 'READ_FRIENDS':
      return <UsersFour weight='duotone' className={className} />;
    case 'ALLOW_MICROPHONE':
      return <Microphone weight='duotone' className={className} />;
    case 'ALLOW_CAMERA':
      return <Camera weight='duotone' className={className} />;
    default:
      return <WarningCircle weight='duotone' className={className} />;
  }
};

export const PluginView = () => {
  const { community } = useLoadedCommunityContext();
  const { plugin } = useCommunityPluginContext();
  const { setIsOpen, setCurrentPage } = useUserSettingsContext();
  const { setUserOnboardingVisibility } = useUserOnboardingContext();
  const ownUser = useOwnUser();
  const { loadIframe, unloadIframe, dockRef, setIsDocked } = usePluginIframeContext();
  const [checkedOptionals, setCheckedOptionals] = useState<Models.Plugin.PluginPermission[]>([]);
  const [loadingAccept, setLoadingAccept] = useState(false);
  const acceptedUrl = useMemo(() => plugin?.acceptedPermissions?.includes(PluginPermission.USER_ACCEPTED), [plugin?.acceptedPermissions]);
  const permissionsMatch = useMemo(() => {
    if (!plugin?.permissions || !plugin?.permissions.mandatory.length) {
      return true;
    }

    return plugin?.permissions?.mandatory?.every(permission => plugin?.acceptedPermissions?.includes(permission));
  }, [plugin?.permissions, plugin?.acceptedPermissions]);
  const accepted = useMemo(() => acceptedUrl && permissionsMatch, [acceptedUrl, permissionsMatch]);
  const { isolationEnabled, toggleIsolationMode } = useIsolationMode();
  const isolationMatches = useMemo(() => Boolean(plugin?.requiresIsolationMode) === isolationEnabled, [plugin?.requiresIsolationMode, isolationEnabled]);

  const handleToggleOptional = useCallback((permission: Models.Plugin.PluginPermission) => {
    setCheckedOptionals(prev => prev.includes(permission) ? prev.filter(p => p !== permission) : [...prev, permission]);
  }, []);

  const missingProfiles = useMemo(() => {
    const missingProfiles: PluginPermission[] = [];

    if (plugin?.permissions?.mandatory?.includes(PluginPermission.READ_TWITTER) && !ownUser?.accounts.some(acc => acc.type === 'twitter')) {
      missingProfiles.push(PluginPermission.READ_TWITTER);
    }
    if (plugin?.permissions?.mandatory?.includes(PluginPermission.READ_LUKSO) && !ownUser?.accounts.some(acc => acc.type === 'lukso')) {
      missingProfiles.push(PluginPermission.READ_LUKSO);
    }
    if (plugin?.permissions?.mandatory?.includes(PluginPermission.READ_FARCASTER) && !ownUser?.accounts.some(acc => acc.type === 'farcaster')) {
      missingProfiles.push(PluginPermission.READ_FARCASTER);
    }
    if (plugin?.permissions?.mandatory?.includes(PluginPermission.READ_EMAIL) && !ownUser?.email) {
      missingProfiles.push(PluginPermission.READ_EMAIL);
    }

    return missingProfiles;
  }, [ownUser?.accounts, ownUser?.email, plugin?.permissions?.mandatory]);

  const isAllowedToOpen = useMemo(() => {
    return acceptedUrl && isolationMatches && !missingProfiles.length && permissionsMatch;
  }, [acceptedUrl, isolationMatches, missingProfiles.length, permissionsMatch]);

  useEffect(() => {
    if (isAllowedToOpen && !!plugin) {
      loadIframe(community?.id || '', plugin);
    }
    else {
      unloadIframe();
    }

    if (!acceptedUrl) {
      setCheckedOptionals(plugin?.permissions?.optional || []);
    } else {
      setCheckedOptionals(plugin?.acceptedPermissions || []);
    }
    setLoadingAccept(false);
  }, [acceptedUrl, community?.id, isAllowedToOpen, loadIframe, plugin?.acceptedPermissions, plugin?.id, plugin?.name, plugin?.permissions?.optional, plugin?.url, unloadIframe]);

  useEffect(() => {
    if (isAllowedToOpen) {
      setIsDocked(true);
      return () => setIsDocked(false);
    }
  }, [setIsDocked, isAllowedToOpen]);

  if (!accepted) {
    return <div className='flex items-center justify-center h-full w-full cg-text-main'>
      <div className='cg-content-stack cg-border-xl p-6 flex flex-col gap-4 items-center'>
        <div className='flex flex-col gap-1 w-full'>
          <h2 className='mx-auto'>{plugin?.name}</h2>
          {plugin?.description && <p className='cg-text-secondary'>{plugin.description}</p>}
        </div>

        <div className='flex flex-col gap-1 w-full'>
          <h3>{acceptedUrl ? 'The required permissions for this plugin have changed:' : 'This plugin is trying to open this url:'}</h3>
          <h3 className='cg-text-brand'>{plugin?.url}</h3>
        </div>

        <PluginPermissionUserSettings
          plugin={plugin}
          checkedOptionals={checkedOptionals}
          handleToggleOptional={handleToggleOptional}
        />

        <Button
          loading={loadingAccept}
          text='I trust, and want to continue'
          role='primary'
          onClick={() => {
            if (!!ownUser) {
              setLoadingAccept(true);
              pluginsApi.acceptPluginPermissions({
                pluginId: plugin?.id || '',
                permissions: [...(plugin?.permissions?.mandatory || []), ...checkedOptionals],
              });
            } else {
              setUserOnboardingVisibility(true);
            }
          }} />
      </div>
    </div>;
  }

  if (missingProfiles.length > 0) {
    return <div className='flex items-center justify-center h-full w-full cg-text-main'>
      <div className='cg-content-stack cg-border-xl p-6 flex flex-col gap-4 items-center'>
        <div className='flex flex-col gap-4 w-full items-center'>
          <h2 className='mx-auto'>This plugin requires the following account types to work properly:</h2>
          <div className='flex flex-col gap-2 w-full'>
            {missingProfiles.includes(PluginPermission.READ_TWITTER) && <div className='flex gap-2 items-center'>
              {permissionToIcon(PluginPermission.READ_TWITTER)}
              <span>Twitter account</span>
            </div>}
            {missingProfiles.includes(PluginPermission.READ_LUKSO) && <div className='flex gap-2 items-center'>
              {permissionToIcon(PluginPermission.READ_LUKSO)}
              <span>Lukso account</span>
            </div>}
            {missingProfiles.includes(PluginPermission.READ_FARCASTER) && <div className='flex gap-2 items-center'>
              {permissionToIcon(PluginPermission.READ_FARCASTER)}
              <span>Farcaster account</span>
            </div>}
            {missingProfiles.includes(PluginPermission.READ_EMAIL) && <div className='flex gap-2 items-center'>
              {permissionToIcon(PluginPermission.READ_EMAIL)}
              <span>Email account</span>
            </div>}
          </div>
        </div>

        <Button
          text='Add missing accounts'
          role='primary'
          onClick={() => {
            setCurrentPage('available-providers');
            setIsOpen(true);
          }} />
      </div>
    </div>;
  }

  if (!isolationMatches) {
    return <div className='flex items-center justify-center h-full w-full cg-text-main'>
      <div className='cg-content-stack cg-border-xl p-6 flex flex-col gap-4 items-center max-w-md'>
        <div className="cg-heading-2 text-center flex items-center mb-2 gap-2">
          <Wrench weight="duotone" className="w-8 h-8" /> Embedding mode
        </div>
        <div className="cg-heading-4 text-center mb-4">
          To use this plugin, {window.location.host} needs to switch embedding mode. Click below to switch mode and reload.
        </div>
        <Button
          role="primary"
          text="Switch and reload"
          onClick={() => toggleIsolationMode()}
        />
      </div>
    </div>;
  }

  return <div className='flex flex-col h-full'>
    <div className='w-full h-full p-4'>
      <div ref={dockRef} className='w-full h-full' />
    </div>
  </div>;
};

export default PluginView;
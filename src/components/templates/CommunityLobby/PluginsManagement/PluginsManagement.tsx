// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './PluginsManagement.css';
import React, { useCallback, useMemo, useState } from 'react'
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import { useLoadedCommunityContext } from 'context/CommunityProvider';
import SpinnerIcon from '../../../atoms/icons/16/Spinner.svg?react';
import { useNavigate } from 'react-router-dom';
import Scrollable from 'components/molecules/Scrollable/Scrollable';
import { useNavigationContext } from 'components/SuspenseRouter/SuspenseRouter';
import { useSnackbarContext } from 'context/SnackbarContext';
import { getUrl } from 'common/util';
import FloatingSaveOptions from '../FloatingSaveOptions/FloatingSaveOptions';
import ManagementHeader2 from 'components/molecules/ManagementHeader2/ManagementHeader2';
import SimpleLink from 'components/atoms/SimpleLink/SimpleLink';
import PluginEditor from './PluginEditor';
import PluginManagementList from './PluginManagementList';
import pluginsApi from 'data/api/plugins';
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import { Clipboard } from '@phosphor-icons/react';
import Button from 'components/atoms/Button/Button';
import { linkRegexGenerator } from 'common/validators';

const libUrl = 'https://github.com/Common-Ground-DAO/CGPluginLib';
const sampleUrl = 'https://github.com/Common-Ground-DAO/CGSamplePlugin';

type Props = {};

type SubProps = Props & {
  selectedPluginId: string;
  setSelectedPluginId: (value: string) => void;
  isCreating: boolean;
  setIsCreating: (value: boolean) => void;
  currentPlugin: Models.Plugin.Plugin | undefined;
  setCurrentPlugin: React.Dispatch<React.SetStateAction<Models.Plugin.Plugin | undefined>>;

  onCreatePlugin: () => void;
  onSave: () => void;
  onDeletePlugin: () => void;
};

const PluginsManagement: React.FC<Props> = (props) => {
  const { isMobile } = useWindowSizeContext();
  const { community } = useLoadedCommunityContext();
  const { showSnackbar } = useSnackbarContext();
  const [selectedPluginId, setSelectedPluginId] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [currentPlugin, setCurrentPlugin] = useState<Models.Plugin.Plugin | undefined>();
  const { isDirty, setDirty } = useNavigationContext();
  const [savedModalData, setSavedModalData] = useState<{
    name: string;
    publicKey: string;
    privateKey: string;
  } | undefined>();
  const plugins = useMemo(() => community.plugins, [community.plugins]);

  if (selectedPluginId && selectedPluginId !== currentPlugin?.id) {
    const originalPlugin = plugins.find(plugin => plugin.id === selectedPluginId);
    if (originalPlugin) {
      setCurrentPlugin(originalPlugin);
      setIsCreating(false);
    }
  } else if (!selectedPluginId && currentPlugin && !isCreating) {
    setCurrentPlugin(undefined);
  }

  const onCreatePlugin = useCallback(async () => {
    setIsCreating(true);
    setSelectedPluginId('');
    setCurrentPlugin({
      id: '',
      pluginId: '',
      ownerCommunityId: community.id,
      communityId: community.id,
      name: 'New plugin',
      url: '',
      tags: null,
      config: {
        canGiveRole: false,
        giveableRoleIds: [],
      },
      permissions: {
        mandatory: [],
        optional: [],
      },
      description: '',
      imageId: null,
      clonable: false,
      appstoreEnabled: false,
      warnAbusive: false,
      requiresIsolationMode: false,
      reportFlagged: false,
    });
  }, [community.id]);

  const onSave = useCallback(async () => {
    if (!currentPlugin) return;

    if (!currentPlugin.name) {
      showSnackbar({ type: 'warning', text: 'Please fill in a name' });
      return;
    }

    if (!currentPlugin.url) {
      showSnackbar({ type: 'warning', text: 'Please fill in a URL' });
      return;
    }

    const onlyLinkRegex = linkRegexGenerator();
    if (!currentPlugin.url.match(onlyLinkRegex)) {
      showSnackbar({ type: 'warning', text: 'The given URL is not valid, please fill in a valid URL' });
      return;
    }

    try {
      if (isCreating) {
        const result = await pluginsApi.createPlugin({
          name: currentPlugin.name,
          url: currentPlugin.url,
          communityId: community.id,
          config: currentPlugin.config || {},
          permissions: currentPlugin.permissions || {
            mandatory: [],
            optional: [],
          },
          clonable: currentPlugin.clonable,
          description: currentPlugin.description ?? '',
          imageId: currentPlugin.imageId,
          requiresIsolationMode: currentPlugin.requiresIsolationMode || false,
          tags: currentPlugin.tags || [],
        });
        setSavedModalData({
          name: currentPlugin.name,
          publicKey: result.publicKey,
          privateKey: result.privateKey,
        });
        setSelectedPluginId(result.id);
      } else {
        let pluginData: API.Plugins.updatePlugin.Request['pluginData'] = null;
        if (currentPlugin.ownerCommunityId === community.id) {
          pluginData = {
            pluginId: currentPlugin.pluginId,
            url: currentPlugin.url,
            permissions: currentPlugin.permissions || {
              mandatory: [],
              optional: [],
            },
            clonable: currentPlugin.clonable,
            description: currentPlugin.description ?? '',
            imageId: currentPlugin.imageId,
            requiresIsolationMode: currentPlugin.requiresIsolationMode || false,
            tags: currentPlugin.tags || [],
          };
        }

        await pluginsApi.updatePlugin({
          id: currentPlugin.id,
          communityId: community.id,
          name: currentPlugin.name,
          config: currentPlugin.config || {},
          pluginData
        });
      }

      setDirty(false);
      showSnackbar({ type: 'info', text: isCreating ? 'Plugin created' : 'Plugin updated' });
    } catch (e) {
      showSnackbar({ type: 'warning', text: 'Failed to save plugin, please try again later' });
    }
  }, [community.id, currentPlugin, isCreating, setDirty, showSnackbar]);

  const onDeletePlugin = useCallback(async () => {
    if (isCreating) {
      setIsCreating(false);
      return;
    }

    if (!currentPlugin) return;
    setDirty(false);
    await pluginsApi.deletePlugin({ id: currentPlugin.id });
    setSelectedPluginId('');
    showSnackbar({ type: 'info', text: 'Plugin deleted' });
  }, [currentPlugin, isCreating, setDirty, setSelectedPluginId, showSnackbar]);

  const setCurrentPluginSetDirty: React.Dispatch<React.SetStateAction<Models.Plugin.Plugin | undefined>> = useCallback((action) => {
    setCurrentPlugin(action);
    setDirty(true);
  }, [setDirty]);

  const setSelectedPluginIdCheckDirty = useCallback((pluginId: string) => {
    if (isDirty) {
      const res = window.confirm('You have unsaved changes, do you want to leave anyway?');
      if (res) {
        setSelectedPluginId(pluginId);
        setDirty(false);
      }
    } else {
      setSelectedPluginId(pluginId);
    }
  }, [isDirty, setDirty]);

  const subProps: SubProps = useMemo(() => ({
    currentPlugin,
    setCurrentPlugin: setCurrentPluginSetDirty,
    isCreating,
    setIsCreating,
    selectedPluginId,
    setSelectedPluginId: setSelectedPluginIdCheckDirty,
    onCreatePlugin,
    onSave,
    onDeletePlugin,
  }), [currentPlugin, isCreating, onCreatePlugin, onDeletePlugin, onSave, selectedPluginId, setCurrentPluginSetDirty, setSelectedPluginIdCheckDirty]);

  if (isMobile) {
    return <>
      <PluginsManagementMobile
        {...props}
        {...subProps}
      />
      <SavedModal
        onClose={() => setSavedModalData(undefined)}
        data={savedModalData}
      />
    </>
  } else {
    return <>
      <RolesManagementDesktop
        {...props}
        {...subProps}
      />
      <SavedModal
        onClose={() => setSavedModalData(undefined)}
        data={savedModalData}
      />
    </>
  }
}

const RolesManagementDesktop: React.FC<SubProps> = (props) => {
  const {
    currentPlugin,
    setCurrentPlugin,
    isCreating,
    selectedPluginId,
    setSelectedPluginId,
    onCreatePlugin,
    onDeletePlugin,
    onSave,
  } = props;
  const { isDirty } = useNavigationContext();

  return <div className='roles-management-desktop'>
    <ManagementHeader2
      title='Plugins'
      help={<span>Plugins are a way for you to add new functionalities to your community. Just give it a name and link it to a compatible service and you're good to go. To see more, check <SimpleLink href={libUrl} className='underline cursor-pointer'>our helper library</SimpleLink>.<br/><br/>Tip: If you lose your keys, you can always recreate your plugin for new ones.</span>}
    />
    <div className='flex flex-col gap-1 cg-bg-brand-subtle cg-border-brand cg-text-main cg-border-xl p-4 max-w-[400px]'>
      <h3 className='cg-text-brand cg-text-lg-500'>Building your plugin for the first time?</h3>
      <p>Check out our <SimpleLink href={libUrl} className='underline cursor-pointer'>helper library</SimpleLink> to build your own plugin that can interact with Common Ground. Or check out our <SimpleLink href={sampleUrl} className='underline cursor-pointer'>sample plugin</SimpleLink> to see how it works.</p>
    </div>
    <div className='roles-management-desktop-content'>
      <PluginManagementList
        selectedId={selectedPluginId}
        isCreating={isCreating}
        onCreatePlugin={onCreatePlugin}
        onSelectPlugin={setSelectedPluginId}
      />
      {!!currentPlugin && <PluginEditor
        key={currentPlugin?.id || 'new'}
        currentPlugin={currentPlugin}
        setCurrentPlugin={setCurrentPlugin}
        onDeletePlugin={onDeletePlugin}
        isCreating={isCreating}
      />}
      {selectedPluginId && !currentPlugin && <div className='flex items-center justify-center'>
        <SpinnerIcon className='spinner' />
      </div>}
    </div>
    {(isCreating || selectedPluginId) && currentPlugin && isDirty && <FloatingSaveOptions
      onDiscard={() => {
        setSelectedPluginId('');
      }}
      onSave={onSave}
    />}
  </div>
}

const PluginsManagementMobile: React.FC<SubProps> = (props) => {
  const navigate = useNavigate();
  const { community } = useLoadedCommunityContext();
  const {
    currentPlugin,
    setCurrentPlugin,
    isCreating,
    selectedPluginId,
    setSelectedPluginId,
    onCreatePlugin,
    onSave,
    onDeletePlugin,
  } = props;
  const { isDirty } = useNavigationContext();

  const goBack = useCallback(() => {
    if (selectedPluginId) {
      setSelectedPluginId('');
    } else {
      navigate(getUrl({ type: 'community-settings', community }));
    }
  }, [community, navigate, selectedPluginId, setSelectedPluginId]);

  let title = 'Roles & Permissions';
  if (selectedPluginId) {
    title = 'Manage Plugin';
  }

  const showFloatingOptions = (isCreating || selectedPluginId) && currentPlugin && isDirty;

  return <div className='roles-management-mobile'>
    <ManagementHeader2
      goBack={goBack}
      title={title}
      help={<span>Plugins are a way for you to add new functionalities to your community. Just give it a name and link it to a compatible service and you're good to go. To see more, check <SimpleLink href={libUrl} className='underline cursor-pointer'>our helper library</SimpleLink>.<br/><br/>Tip: If you lose your keys, you can always recreate your plugin for new ones.</span>}
    />
    <Scrollable>
      {!selectedPluginId && <div className='flex flex-col gap-1 cg-bg-brand-subtle cg-border-brand cg-text-main cg-border-xl p-4 mx-4'>
        <h3 className='cg-text-brand cg-text-lg-500'>Building your plugin for the first time?</h3>
        <p>Check out our <SimpleLink href={libUrl} className='underline cursor-pointer'>helper library</SimpleLink> to build your own plugin that can interact with Common Ground. Or check out our <SimpleLink href={sampleUrl} className='underline cursor-pointer'>sample plugin</SimpleLink> to see how it works.</p>
      </div>}
      <div className={`p-4${showFloatingOptions ? ' pb-24' : ''}`}>
        {!selectedPluginId && <>
          <PluginManagementList
            selectedId={selectedPluginId}
            isCreating={isCreating}
            onCreatePlugin={onCreatePlugin}
            onSelectPlugin={setSelectedPluginId}
          />
        </>}

        {!!currentPlugin && <PluginEditor
          key={currentPlugin?.id || 'new'}
          currentPlugin={currentPlugin}
          setCurrentPlugin={setCurrentPlugin}
          onDeletePlugin={onDeletePlugin}
          isCreating={isCreating}
        />}

        {selectedPluginId && !currentPlugin && <div className='flex items-center justify-center max-h-screen'>
          <SpinnerIcon className='spinner' />
        </div>}
      </div>
    </Scrollable>
    {showFloatingOptions && <FloatingSaveOptions
      onDiscard={() => {
        setSelectedPluginId('');
      }}
      onSave={onSave}
    />}
  </div>;
}

const SavedModal: React.FC<{
  onClose: () => void;
  data: {
    name: string;
    publicKey: string;
    privateKey: string;
  } | undefined;
}> = ({ onClose, data }) => {
  const { showSnackbar } = useSnackbarContext();
  const visible = !!data;

  return <ScreenAwareModal
    isOpen={visible}
    onClose={onClose}
  >
    <div className='flex flex-col items-center gap-4'>
      <h3 className='text-center'>These are the keys for your "<span className='font-bold'>{data?.name}</span>" plugin.</h3>
      <h4 className='text-center'>Copy and paste them in your .env file to connect your plugin to Common Ground.</h4>
      <h4 className='cg-text-warning text-center'>They will only be shown once, so keep them safe!</h4>
      <div className='flex flex-col gap-2 cg-content-stack p-4 cg-border-xl max-w-full'>
        <div className='flex gap-2 items-center'>
          <Button
            role='chip'
            className='p-4'
            iconLeft={<Clipboard weight='duotone' className='w-6 h-6' />}
            text={`Copy keys`}
            onClick={() => {
              navigator.clipboard.writeText(
                "VITE_PLUGIN_PUBLIC_KEY=\"" +
                data?.publicKey.replaceAll("\n", "\\n") + "\"" +
                "\nPLUGIN_PRIVATE_KEY=\"" +
                data?.privateKey.replaceAll("\n", "\\n") + "\""
              );
              showSnackbar({ type: 'info', text: 'Keys for .env file copied to clipboard' });
            }}
          />
        </div>
      </div>
    </div>
  </ScreenAwareModal>
}

export default React.memo(PluginsManagement);

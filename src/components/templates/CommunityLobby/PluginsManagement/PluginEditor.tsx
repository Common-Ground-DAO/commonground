// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { RoleType } from 'common/enums';
import Button from 'components/atoms/Button/Button';
import CheckboxBase from 'components/atoms/CheckboxBase/CheckboxBase';
import Modal from 'components/atoms/Modal/Modal';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import { useLoadedCommunityContext } from 'context/CommunityProvider';
import React, { useMemo, useState } from 'react';
import PluginEditorPermissionsSetter from './PluginEditorPermissionsSetter';
import SimpleLink from 'components/atoms/SimpleLink/SimpleLink';
import TextAreaField from 'components/molecules/inputs/TextAreaField/TextAreaField';
import ImageUploadField from 'components/molecules/inputs/ImageUploadField/ImageUploadField';
import { useSignedUrl } from 'hooks/useSignedUrl';
import fileApi from 'data/api/file';
import CommunityCard from 'components/molecules/CommunityCard/CommunityCard';
import { useCommunityListView } from 'context/CommunityListViewProvider';
import { useSnackbarContext } from 'context/SnackbarContext';
import { imageUploadErrorText, notifyIfImageRejected } from 'moderation/imageUploadError';
import TagInputField from 'components/molecules/inputs/TagInputField/TagInputField';

type Props = {
  isCreating: boolean;
  currentPlugin: Models.Plugin.Plugin;
  setCurrentPlugin: React.Dispatch<React.SetStateAction<Models.Plugin.Plugin | undefined>>;
  onDeletePlugin: () => void;
}

const PluginEditor: React.FC<Props> = (props) => {
  const { showSnackbar } = useSnackbarContext();
  const { isCreating, currentPlugin, setCurrentPlugin, onDeletePlugin } = props;
  const { community, roles } = useLoadedCommunityContext();
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const appstoreImageUrl = useSignedUrl(currentPlugin.imageId);

  const giveableRoles = roles.filter(role => role.type !== RoleType.PREDEFINED && (role.assignmentRules === null || role.assignmentRules?.type === 'free'));
  const pluginConfig = currentPlugin.config;

  const isCommunityOwner = useMemo(() => {
    if (!community) return false;
    return community.id === currentPlugin.ownerCommunityId;
  }, [community, currentPlugin]);

  const ownerCommunity = useCommunityListView(currentPlugin.ownerCommunityId);

  const setAppstoreImage = async (data?: File) => {
    if (!data) return;
    try {
      const response = await fileApi.uploadImage({
        type: 'pluginAppstoreImage',
      }, data);

      setCurrentPlugin(oldPlugin => oldPlugin ? ({ ...oldPlugin, imageId: response.imageId }) : undefined);
    } catch (e) {
      // `ImageUploadField` calls this without awaiting, so an uncaught
      // rejection here would be invisible to the user.
      if (!notifyIfImageRejected(e)) {
        showSnackbar({ type: 'warning', text: imageUploadErrorText(e, 'Could not upload the image') });
      }
    }
  }

  return <div className='flex flex-col gap-8'>
    <div className='flex flex-col gap-4'>
      <span className='cg-caption-md-600 cg-text-secondary'>General</span>
      <div className='flex flex-col gap-4 cg-content-stack p-4 cg-border-xxl'>
        <TextInputField
          value={currentPlugin.name}
          onChange={(value) => setCurrentPlugin(oldPlugin => oldPlugin ? ({ ...oldPlugin, name: value }) : undefined)}
          label='Plugin name'
        />
        <TextInputField
          value={currentPlugin.url}
          onChange={(value) => setCurrentPlugin(oldPlugin => oldPlugin ? ({ ...oldPlugin, url: value }) : undefined)}
          label='Plugin URL'
          disabled={!isCommunityOwner}
          inputClassName={!isCommunityOwner ? 'external-plugin-field' : undefined}
        />
        <TextAreaField
          value={currentPlugin.description ?? ''}
          maxLetters={400}
          autoGrow
          rows={3}
          onChange={(value) => setCurrentPlugin(oldPlugin => oldPlugin ? ({ ...oldPlugin, description: value }) : undefined)}
          label='Plugin description'
          inputClassName={`min-h-[70px] ${!isCommunityOwner ? 'external-plugin-field' : ''}`}
          disabled={!isCommunityOwner}
        />
        <TagInputField
          tags={currentPlugin.tags ?? []}
          onTagsChange={(tags) => setCurrentPlugin(oldPlugin => oldPlugin ? ({ ...oldPlugin, tags }) : undefined)}
          disabled={!isCommunityOwner}
          label='Tags'
          placeholder='Add tags to your plugin'
        />
        {!isCommunityOwner && ownerCommunity && <div className='flex flex-col gap-2 cg-text-main'>
          <span className='cg-text-lg-500'>Cloned from</span>
          <CommunityCard community={ownerCommunity} />
        </div>}
      </div>
    </div>

    {isCommunityOwner && (<>
      <div className='flex flex-col gap-4'>
        <span className='cg-caption-md-600 cg-text-secondary'>Plugin Clonability</span>
        <div className='flex flex-col gap-2 cg-content-stack p-4 cg-border-xxl cg-text-main'>
          <div className='flex flex-col gap-2 cg-bg-brand-subtle cg-border-brand p-4 cg-border-xl'>
            <span className='cg-text-brand cg-text-lg-500'>Share your plugin with other communities</span>
            <span className='cg-text-main cg-text-md-400'>Show your plugin on the appstore and other communities will be able to use your plugin with the same URL and permission settings you've configured.</span>
          </div>

          <div className='flex items-center gap-2 cursor-pointer w-fit' onClick={() => setCurrentPlugin(oldPlugin => oldPlugin ? ({ ...oldPlugin, clonable: !oldPlugin.clonable } as Models.Plugin.Plugin) : undefined)}>
            <CheckboxBase
              type='checkbox'
              size='normal'
              checked={currentPlugin.clonable}
            />
            <span>Show this plugin on the plugin appstore</span>
          </div>
          <div className='flex flex-col gap-1'>
            <div className='flex flex-row items-center gap-2'>
              <CheckboxBase
                type='checkbox'
                size='normal'
                checked={currentPlugin.appstoreEnabled}
                disabled={!currentPlugin.appstoreEnabled}
              />
              <span className={currentPlugin.appstoreEnabled ? 'cg-text-main' : 'cg-text-secondary'}>Feature on the appstore</span>
            </div>
            {!currentPlugin.appstoreEnabled && <span className='cg-caption-sm-400 cg-text-brand'>Want to know how to feature your plugins? <SimpleLink className='underline' href='https://app.cg/c/commonground/article/new-cg-feature-plugins-kfiTKTGVe52ygEDBv8RJ4f/'>Read more</SimpleLink></span>}
          </div>
          <ImageUploadField 
            label="Plugin logo"
            subLabels={["8mb limit, minimum 200 x 200 px recommended"]}
            imageURL={appstoreImageUrl}
            onChange={setAppstoreImage}
            imagePreviewStyle={{width: '112px', height: '112px'}}
          />
        </div>
      </div>

      <PluginEditorPermissionsSetter
        plugin={currentPlugin}
        setPlugin={setCurrentPlugin}
      />
    </>)}

    <div className='flex flex-col gap-4'>
      <span className='cg-caption-md-600 cg-text-secondary'>Plugin Settings</span>
      <div className='flex flex-col gap-4 cg-content-stack p-4 cg-border-xxl cg-text-main'>
        <span className='cg-caption-md-600 cg-text-secondary'>Giveable Roles Settings</span>
        <div className='flex flex-col gap-4'>
          <div
            className='flex items-center gap-2 cursor-pointer w-fit'
            onClick={() => setCurrentPlugin(oldPlugin => oldPlugin ? ({ ...oldPlugin, config: { ...oldPlugin.config, canGiveRole: !oldPlugin.config?.canGiveRole } } as Models.Plugin.Plugin) : undefined)}
          >
            <CheckboxBase
              type='checkbox'
              size='normal'
              checked={pluginConfig?.canGiveRole ?? false}
            />
            <span>Enable Giving roles</span>
          </div>

          <div className='flex flex-col gap-4 p-4 cg-bg-subtle cg-border-xxl'>
            <span className='cg-caption-md-600 cg-text-secondary'>Giveable Roles</span>
            {giveableRoles.map(role => (
              <div
                key={role.id}
                className='flex items-center gap-2 cursor-pointer w-fit'
                onClick={() => setCurrentPlugin(oldPlugin => oldPlugin ? ({ ...oldPlugin, config: { ...oldPlugin.config, giveableRoleIds: pluginConfig?.giveableRoleIds?.includes(role.id) ? (pluginConfig?.giveableRoleIds ?? []).filter(id => id !== role.id) : [...(pluginConfig?.giveableRoleIds ?? []), role.id] } } as Models.Plugin.Plugin) : undefined)}
              >
                <CheckboxBase
                  type='checkbox'
                  size='normal'
                  checked={pluginConfig?.giveableRoleIds?.includes(role.id) ?? false}
                />
                <span>{role.title}</span>
              </div>
            ))}
          </div>
        </div>
        <span className='cg-caption-md-600 cg-text-secondary mt-2'>Isolation Mode Settings</span>
        <div className='flex flex-col gap-2 cg-bg-brand-subtle cg-border-brand p-4 cg-border-xl'>
          <span className='cg-text-brand cg-text-lg-500'>Advanced: Browsing context group isolation</span>
          <span className='cg-text-main cg-text-md-400'>
            Most plugins do not require isolation mode. If you're building a normal web app, leave this setting disabled!<br/>
            If your plugin needs to use advanced browser features like Web Assembly with Threading, SharedArrayBuffer or High Precision Timers, then you need to enable this setting.
            It comes with additional setup steps, as described in our <a href="https://github.com/Common-Ground-DAO/CGPluginLib" rel="noopener noreferrer" target="_blank" style={{textDecoration: 'underline'}}>plugin library documentation</a>.
          </span>
        </div>
        <div className='flex items-center gap-2 cursor-pointer w-fit cg-text-main' onClick={() => setCurrentPlugin(oldPlugin => oldPlugin ? ({ ...oldPlugin, requiresIsolationMode: !oldPlugin.requiresIsolationMode } as Models.Plugin.Plugin) : undefined)}>
          <CheckboxBase
            type='checkbox'
            size='normal'
            checked={currentPlugin.requiresIsolationMode}
            disabled={!isCommunityOwner}
          />
          <span>Requires Isolation Mode</span>
        </div>
      </div>
    </div>

    <div className='flex items-center justify-center py-4'>
      <Button
        className='w-full'
        role='destructive'
        text={isCreating ? "Cancel plugin creation" : "Delete plugin"}
        onClick={() => {
          if (isCreating) {
            onDeletePlugin();
          } else {
            setShowDeleteModal(true);
          }
        }}
      />
      <DeletePluginModal
        visible={showDeleteModal}
        onCancel={() => setShowDeleteModal(false)}
        onDeleteModal={() => {
          setShowDeleteModal(false);
          onDeletePlugin();
        }}
      />
    </div>
  </div>;
};


type ModalProps = {
  visible: boolean;
  onDeleteModal: () => void;
  onCancel: () => void;
}

const DeletePluginModal: React.FC<ModalProps> = (props) => {
  const { visible, onDeleteModal, onCancel } = props;

  if (!visible) return null;

  return (
    <Modal close={onCancel} headerText='Delete plugin' >
      <div className='flex flex-col gap-4'>
        <span>
          Are you sure you want to delete this plugin?
        </span>
        <Button
          role='destructive'
          text='Delete plugin'
          className='w-full self-center'
          iconLeft={<ExclamationTriangleIcon className='w-5 h-5' />}
          onClick={onDeleteModal}
        />
        <Button
          role='secondary'
          text='Cancel'
          className='w-full self-center'
          onClick={onCancel}
        />
      </div>
    </Modal>
  )
}


export default PluginEditor;
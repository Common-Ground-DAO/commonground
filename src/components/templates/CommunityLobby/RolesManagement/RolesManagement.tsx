// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './RolesManagement.css';
import React, { useCallback, useMemo, useState } from 'react'
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import RolesManagementList from './RolesManagementList';
import RoleEditor from './RoleEditor';
import { useLoadedCommunityContext } from 'context/CommunityProvider';
import data from 'data';
import SpinnerIcon from '../../../atoms/icons/16/Spinner.svg?react';
import { PredefinedRole } from 'common/enums';
import _ from 'lodash';
import SaveRoleWarningModal from './SaveRoleWarningModal';
import { useNavigate } from 'react-router-dom';
import Scrollable from 'components/molecules/Scrollable/Scrollable';
import { useNavigationContext } from 'components/SuspenseRouter/SuspenseRouter';
import { useSnackbarContext } from 'context/SnackbarContext';
import { getUrl } from 'common/util';
import FloatingSaveOptions from '../FloatingSaveOptions/FloatingSaveOptions';
import ManagementHeader2 from 'components/molecules/ManagementHeader2/ManagementHeader2';
import SimpleLink from 'components/atoms/SimpleLink/SimpleLink';

const learnMoreLink = 'https://app.cg/c/commonground/article/token-gate-anything-on-common-ground-with-roles-uYEXWA5RV3QdjpaQPcKQ7N/';

type Props = {};

type SubProps = Props & {
  selectedRoleId: string;
  setSelectedRoleId: (value: string) => void;
  isCreating: boolean;
  setIsCreating: (value: boolean) => void;
  currentRole: Models.Community.Role | undefined;
  setCurrentRole: React.Dispatch<React.SetStateAction<Models.Community.Role | undefined>>;
  showSaveWarningModal: boolean;
  setShowSaveWarningModal: (value: boolean) => void;

  lockEditing: 'fullLock' | 'allowMember' | undefined;
  onCreateRole: () => void;
  onSave: () => void;
  onSaveClick: () => void;
  onDeleteRole: () => void;
};

const RolesManagement: React.FC<Props> = (props) => {
  const { isMobile } = useWindowSizeContext();
  const { roles, community } = useLoadedCommunityContext();
  const { showSnackbar } = useSnackbarContext();
  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [currentRole, setCurrentRole] = useState<Models.Community.Role | undefined>();
  const [showSaveWarningModal, setShowSaveWarningModal] = useState(false);
  const { isDirty, setDirty } = useNavigationContext();

  if (selectedRoleId && selectedRoleId !== currentRole?.id) {
    const originalRole = roles.find(role => role.id === selectedRoleId);
    if (originalRole) {
      setCurrentRole(originalRole);
    }
  } else if (!selectedRoleId && currentRole) {
    setCurrentRole(undefined);
  }

  const lockEditing = useMemo(() => {
    if (currentRole?.title === PredefinedRole.Admin) return 'fullLock';
    else if (defaultRoles.includes(currentRole?.title as PredefinedRole)) return 'allowMember';
    else return undefined;
  }, [currentRole?.title]);

  const onCreateRole = useCallback(async () => {
    setIsCreating(true);
    setSelectedRoleId('');
    const result = await data.community.createRole({
      title: 'New role',
      type: 'CUSTOM_MANUAL_ASSIGN',
      imageId: null,
      assignmentRules: null,
      communityId: community.id,
      description: null,
      permissions: []
    });
    setSelectedRoleId(result.id);
    setIsCreating(false);
    showSnackbar({ type: 'info', text: 'Role created' });
  }, [community.id, showSnackbar]);

  const onSave = useCallback(async () => {
    if (!currentRole) return;

    setShowSaveWarningModal(false);
    let type = currentRole.type;
    if (type !== 'PREDEFINED') {
      type = !!currentRole.assignmentRules ? 'CUSTOM_AUTO_ASSIGN' : 'CUSTOM_MANUAL_ASSIGN';
    }

    let request: API.Community.updateRole.Request = {
      id: currentRole.id,
      communityId: currentRole.communityId,
      imageId: currentRole.imageId,
      description: currentRole.description
    };

    // Add permissions if not editing admin
    if (currentRole.title !== PredefinedRole.Admin) {
      request.permissions = currentRole.permissions;
    }

    if (type !== 'PREDEFINED') {
      request = {
        ...request,
        title: currentRole.title,
        assignmentRules: currentRole.assignmentRules,
        type,
      }
    }

    try {
      await data.community.updateRole(request);
      setDirty(false);
      showSnackbar({ type: 'info', text: 'Role updated' });
    } catch (e) {
      let errorText = 'Failed to update role, please'
      if (currentRole.assignmentRules?.type === 'token') {
        errorText += ' check claiming rules or';
      }
      errorText += ' try again later';
      showSnackbar({ type: 'warning', text: errorText });
    }
  }, [currentRole, setDirty, showSnackbar]);

  const onSaveClick = useCallback(() => {
    const originalRole = roles.find(role => role.id === selectedRoleId);
    if (
      originalRole?.assignmentRules?.type === 'token' &&
      !_.isEqual(currentRole?.assignmentRules, originalRole?.assignmentRules)
    ) {
      setShowSaveWarningModal(true);
    } else {
      return onSave();
    }
  }, [currentRole?.assignmentRules, onSave, roles, selectedRoleId]);

  const onDeleteRole = useCallback(async () => {
    if (!currentRole) return;
    setDirty(false);
    await data.community.deleteRole({
      id: currentRole.id,
      communityId: currentRole.communityId
    });
    setSelectedRoleId('');
    showSnackbar({ type: 'info', text: 'Role deleted' });
  }, [currentRole, setDirty, showSnackbar]);

  const setCurrentRoleSetDirty: React.Dispatch<React.SetStateAction<Models.Community.Role | undefined>> = useCallback((action) => {
    setCurrentRole(action);
    setDirty(true);
  }, [setDirty]);

  const setSelectedRoleIdCheckDirty = useCallback((roleId: string) => {
    if (isDirty) {
      const res = window.confirm('You have unsaved changes, do you want to leave anyway?');
      if (res) {
        setSelectedRoleId(roleId);
        setDirty(false);
      }
    } else {
      setSelectedRoleId(roleId);
    }
  }, [isDirty, setDirty]);

  const subProps: SubProps = useMemo(() => ({
    currentRole,
    setCurrentRole: setCurrentRoleSetDirty,
    isCreating,
    setIsCreating,
    selectedRoleId,
    setSelectedRoleId: setSelectedRoleIdCheckDirty,
    lockEditing,
    showSaveWarningModal,
    setShowSaveWarningModal,
    onCreateRole,
    onSave,
    onSaveClick,
    onDeleteRole,
  }), [currentRole, isCreating, lockEditing, onCreateRole, onDeleteRole, onSave, onSaveClick, selectedRoleId, setCurrentRoleSetDirty, setSelectedRoleIdCheckDirty, showSaveWarningModal]);

  if (isMobile) {
    return <>
      <RolesManagementMobile
        {...props}
        {...subProps}
      />
      <SaveRoleWarningModal
        onCancel={() => setShowSaveWarningModal(false)}
        onSave={onSave}
        visible={showSaveWarningModal}
      />
    </>
  } else {
    return <>
      <RolesManagementDesktop
        {...props}
        {...subProps}
      />
      <SaveRoleWarningModal
        onCancel={() => setShowSaveWarningModal(false)}
        onSave={onSave}
        visible={showSaveWarningModal}
      />
    </>
  }
}

const defaultRoles = [PredefinedRole.Admin, PredefinedRole.Member, PredefinedRole.Public];

const RolesManagementDesktop: React.FC<SubProps> = (props) => {
  const {
    currentRole,
    setCurrentRole,
    isCreating,
    selectedRoleId,
    setSelectedRoleId,
    lockEditing,
    onCreateRole,
    onSaveClick,
    onDeleteRole,
  } = props;
  const { isDirty } = useNavigationContext();

  return <div className='roles-management-desktop'>
    <ManagementHeader2
      title='Roles & Permissions'
      help={<span>Roles help you organise people. For example, you might create a role for special members, your team, or even parts of your team. You can then create posts, chats, and calls for each role separately. As for fixed roles, Admins are the most powerful and should only be given to trusted people, Guests are people visiting your community, and Members are people who have joined. Add more roles to bring your community to life. <SimpleLink href={learnMoreLink} className='underline cursor-pointer'>Learn more</SimpleLink></span>}
    />
    <div className='roles-management-desktop-content'>
      <RolesManagementList
        selectedId={selectedRoleId}
        isCreating={isCreating}
        onCreateRole={onCreateRole}
        onSelectRole={setSelectedRoleId}
      />
      {currentRole && <RoleEditor
        key={currentRole.id}
        currentRole={currentRole}
        setCurrentRole={setCurrentRole}
        onDeleteRole={onDeleteRole}
        lockEditing={lockEditing}
      />}
      {selectedRoleId && !currentRole && <div className='flex items-center justify-center'>
        <SpinnerIcon className='spinner' />
      </div>}
    </div>
    {selectedRoleId && currentRole && isDirty && <FloatingSaveOptions
      onDiscard={() => {
        setSelectedRoleId('');
      }}
      onSave={onSaveClick}
    />}
  </div>
}

const RolesManagementMobile: React.FC<SubProps> = (props) => {
  const navigate = useNavigate();
  const { community } = useLoadedCommunityContext();
  const {
    currentRole,
    setCurrentRole,
    isCreating,
    selectedRoleId,
    setSelectedRoleId,
    lockEditing,
    onCreateRole,
    onSaveClick,
    onDeleteRole,
  } = props;
  const { isDirty } = useNavigationContext();

  const goBack = useCallback(() => {
    if (selectedRoleId) {
      setSelectedRoleId('');
    } else {
      navigate(getUrl({ type: 'community-settings', community }));
    }
  }, [community, navigate, selectedRoleId, setSelectedRoleId]);

  let title = 'Roles & Permissions';
  if (selectedRoleId) {
    title = 'Manage Role';
  }

  const showFloatingOptions = selectedRoleId && currentRole && isDirty;

  return <div className='roles-management-mobile'>
    <ManagementHeader2
      goBack={goBack}
      title={title}
      help={<span>Roles help you organise people. For example, you might create a role for special members, your team, or even parts of your team. You can then create posts, chats, and calls for each role separately. As for fixed roles, Admins are the most powerful and should only be given to trusted people, Guests are people visiting your community, and Members are people who have joined. Add more roles to bring your community to life. <SimpleLink href={learnMoreLink} className='underline cursor-pointer'>Learn more</SimpleLink></span>}
    />
    <Scrollable>
      <div className={`p-4${showFloatingOptions ? ' pb-24' : ''}`}>
        {!selectedRoleId && <>
          <RolesManagementList
            selectedId={selectedRoleId}
            isCreating={isCreating}
            onCreateRole={onCreateRole}
            onSelectRole={setSelectedRoleId}
          />
        </>}

        {currentRole && <RoleEditor
          key={currentRole.id}
          currentRole={currentRole}
          setCurrentRole={setCurrentRole}
          onDeleteRole={onDeleteRole}
          lockEditing={lockEditing}
        />}

        {selectedRoleId && !currentRole && <div className='flex items-center justify-center max-h-screen'>
          <SpinnerIcon className='spinner' />
        </div>}
      </div>
    </Scrollable>
    {showFloatingOptions && <FloatingSaveOptions
      onDiscard={() => {
        setSelectedRoleId('');
      }}
      onSave={onSaveClick}
    />}
  </div>;
}

export default React.memo(RolesManagement);

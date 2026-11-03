// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import AnimatedContainerVertical from 'components/atoms/AnimatedContainerVertical/AnimatedContainerVertical';
import AnimatedTabPage from 'components/atoms/AnimatedTabPage/AnimatedTabPage';
import AnimatedTabPageContainer from 'components/atoms/AnimatedTabPage/AnimatedTabPageContainer';
import React from 'react'
import { OptionsPermissionView } from '../PinnedChatOptionsModal/PinnedChatOptionsModal';
import { useLiveQuery } from 'dexie-react-hooks';
import data from 'data';
import { PermissionType } from '../RolePermissionToggle/RolePermissionToggle';

type Props = {
  callId: string;
};

function toPermissionType(permissions: Common.CallPermission[]): PermissionType {
  if (permissions.includes('CALL_MODERATE')) return 'moderate';
  else if (permissions.includes('AUDIO_SEND')) return 'full';
  else return 'none';
}

export function callPermissionsToPermissionType(
  callPermissions: Models.Calls.Call['rolePermissions']
): Record<string, PermissionType> {
  return callPermissions.reduce((acc, permission) => {
    // Don't convert admin, we won't modify it and won't send it either
    // if (permission.roleTitle === PredefinedRole.Admin) return acc;
    // TODO: Do not convert admin if necessary

    return {
      ...acc,
      [permission.roleId]: toPermissionType(permission.permissions)
    }
  }, {});
}

const screenOrder = {};

const VoiceChatOptionsModal: React.FC<Props> = (props) => {
  const { callId } = props;

  const activeCall = useLiveQuery(() => {
    return data.community.getCallById(callId);
  }, [callId]);

  if (!activeCall) return null;

  const permissions = callPermissionsToPermissionType(activeCall?.rolePermissions);
  return (<div className='flex flex-col items-center px-4 pb-4 w-full gap-4'>
    <div className='flex p-1 self-stretch'>
      <span className='flex py-2 cg-text-main cg-heading-3'>Call Access</span>
    </div>
    <AnimatedContainerVertical>
      <AnimatedTabPageContainer currentScreen='' screenOrder={screenOrder}>
        <AnimatedTabPage visible={true} className='flex flex-col gap-4 w-full'>
          <OptionsPermissionView permissions={permissions} />
        </AnimatedTabPage>
      </AnimatedTabPageContainer>
    </AnimatedContainerVertical>
  </div>);
}

export default React.memo(VoiceChatOptionsModal);
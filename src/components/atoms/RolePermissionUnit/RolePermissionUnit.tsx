// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import './RolePermissionUnit.css';
import { PermissionType } from 'components/molecules/RolePermissionToggle/RolePermissionToggle';
import { ChevronDownIcon } from '@heroicons/react/20/solid';
import PreviewIcon from '../../../components/atoms/icons/20/Preview.svg?react';
import HammerIcon from '../../../components/atoms/icons/20/HammerIcon.svg?react';
import { XMarkIcon, EyeIcon, CheckIcon } from '@heroicons/react/20/solid';

type Props = {
  permissionType: PermissionType;
  title?: string;
  showChevron?: boolean;
};

const RolePermissionUnit: React.FC<Props> = (props) => {
  const { permissionType, title, showChevron } = props;

  let colorClassName: 'full' | 'limited' = 'limited';
  if (permissionType === 'full' || permissionType === 'moderate') colorClassName = 'full';

  const className = [
    'role-permission-unit',
    'cg-text-md-500',
    showChevron ? 'cursor-pointer' : '',
    colorClassName,
  ].join(' ').trim();


  return (<div className={className}>
    {title || permissionToTitle(permissionType)}
    <RolePermissionIcon permission={permissionType} />
    {showChevron && <ChevronDownIcon className='w-5 h-5 cg-text-secondary'/>}
  </div>);
}

export function permissionToTitle(permission: PermissionType): string {
  switch(permission) {
    case 'full': return 'Full access';
    case 'moderate': return 'Moderator';
    case 'none': return 'No access';
    case 'preview': return 'Preview only';
    case 'read': return 'Read only';
  }
}

export const RolePermissionIcon: React.FC<{permission: PermissionType}> = ({ permission }) => {
  let colorClassName: 'full' | 'limited' = 'limited';
  if (permission === 'full' || permission === 'moderate') colorClassName = 'full';

  const className = [
    'role-permission-icon',
    colorClassName
  ].join(' ').trim();

  return (
    <div className={className}>
      {permission === 'none' && <XMarkIcon className='w-5 h-5' />}
      {permission === 'preview' && <PreviewIcon />}
      {permission === 'read' && <EyeIcon className='w-5 h-5' />}
      {permission === 'full' && <CheckIcon className='w-5 h-5' />}
      {permission === 'moderate' && <HammerIcon />}
    </div>
  );
}

export default RolePermissionUnit
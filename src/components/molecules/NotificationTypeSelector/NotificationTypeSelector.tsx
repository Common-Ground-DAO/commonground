// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Button from '../../../components/atoms/Button/Button';
import DropdownItem from '../../atoms/ListItem/ListItem';
import React from 'react';
import Dropdown from '../Dropdown/Dropdown';
import { getIcon } from '../NotificationMessage/NotificationMessage';
import ChevronDownIcon from '../../../components/atoms/icons/16/ChevronDown.svg?react';
import CheckboxFilledIcon from '../../../components/atoms/icons/16/CheckboxFilled.svg?react';

import './NotificationTypeSelector.css';

const notificationTypes: Models.Notification.Type[] = ['Mention', 'Reply', 'Follower'];
type NotificationType = typeof notificationTypes[number];
const validNotificationTypes: NotificationType[] = ['Mention', 'Reply'];

type Props = {
  selectedOption?: NotificationType;
  setSelectedOption: (type?: NotificationType) => void;
};

const NotificationsTypeSelector: React.FC<Props> = (props) => {
  const items = React.useMemo(() => {
    const allItem = <DropdownItem icon={<CheckboxFilledIcon />} key={'All'} title={'All'} selected={!props.selectedOption} onClick={() => props.setSelectedOption(undefined)} />;

    const typeItems = validNotificationTypes.map(type => (
      <DropdownItem icon={getIcon(type)} key={type} title={type} selected={type === props.selectedOption} onClick={() => props.setSelectedOption(type)} />
    ));

    return [allItem, ...typeItems];
  }, [props]);

  return (
    <div className='notificationTypeSelector'>
      <Dropdown
        placement='bottom-start'
        triggerContent={<Button className='notificationTypeSelectorButton' iconRight={<ChevronDownIcon />} role='secondary' text={props.selectedOption || 'All'} />}
        className='notificationTypeSelectorDropdown'
        title="Filter by types"
        items={items}
      />
    </div>
  );
}

export default React.memo(NotificationsTypeSelector);
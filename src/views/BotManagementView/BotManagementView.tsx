// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useNavigate } from 'react-router-dom';
import { getUrl } from 'common/util';
import { useLoadedCommunityContext } from 'context/CommunityProvider';
import ManagementHeader2 from 'components/molecules/ManagementHeader2/ManagementHeader2';
import Scrollable from 'components/molecules/Scrollable/Scrollable';
import BotManagement from 'components/templates/CommunityLobby/BotManagement/BotManagement';

export default function BotManagementView() {
  const navigate = useNavigate();
  const { community } = useLoadedCommunityContext();

  return <div className='h-full flex flex-col'>
    <ManagementHeader2
      title='Bots'
      goBack={() => navigate(getUrl({ type: 'community-settings', community }))}
    />
    <Scrollable>
      <BotManagement showHeading={false} />
    </Scrollable>
  </div>;
}

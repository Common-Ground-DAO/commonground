// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import { useNavigate } from 'react-router';

import { useWindowSizeContext } from '../../../context/WindowSizeProvider';

import CommunityPhoto from '../../../components/atoms/CommunityPhoto/CommunityPhoto';
import { getUrl } from 'common/util';
import { getCommunityDisplayName } from '../../../util';

import './CommunityCard.css';

type Props = {
  community: Models.Community.ListView
};

const CommunityCard: React.FC<Props> = ({ community }) => {
  const { isMobile } = useWindowSizeContext();
  const navigate = useNavigate();

  return (
    <div className={`society-card${isMobile ? " mobile" : ""}`} onClick={() => navigate(getUrl({ type: 'community-lobby', community }))}>
      <CommunityPhoto
        community={community}
        size='small'
        noHover
      />
      <div className="card-title">
        {getCommunityDisplayName(community)}
      </div>
    </div>
  );
}

export default React.memo(CommunityCard);
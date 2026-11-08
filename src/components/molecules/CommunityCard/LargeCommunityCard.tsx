// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useMemo } from 'react'
import './CommunityCard.css';
import { useNavigate } from 'react-router';

import CommunityPhoto from '../../../components/atoms/CommunityPhoto/CommunityPhoto';
import { getUrl } from 'common/util';
import { getCommunityDisplayName } from '../../../util';
import { Users } from '@phosphor-icons/react';
import Tag, { TagIcon } from 'components/atoms/Tag/Tag';
import { tagStringToPredefinedTag } from '../inputs/TagInputField/TagInputField';

type Props = {
  community: Models.Community.ListView;
};

const LargeCommunityCard: React.FC<Props> = ({ community }) => {
  const navigate = useNavigate();

  const onExploreClick = React.useCallback(async (ev: React.MouseEvent) => {
    navigate(getUrl({ type: 'community-lobby', community }))
  }, [community, navigate]);

  const memberCount = React.useMemo(() => {
    return community.memberCount || 0;
  }, [community]);

  const fullCommunityTags = useMemo(() => tagStringToPredefinedTag(community.tags), [community.tags]);

  return (<div className={`large-society-card cg-content-stack cg-text-main`} onClick={onExploreClick}>
    <div className="flex items-center p-4 gap-2">
      <CommunityPhoto
        community={community}
        size='small'
        noHover
      />
      <div className="flex-1 cg-text-lg-500 overflow-hidden">
        {getCommunityDisplayName(community)}
      </div>
      <div className="flex gap-1 items-center cg-text-secondary cg-text-md-500">
        <Users className="w-5 h-5" />
        {memberCount}
      </div>
    </div>
    <div className="flex flex-col px-4 gap-4 pb-4">
      <span className="cg-text-secondary cg-text-md-400 community-card-description">{community.shortDescription}</span>
      {!!community.tags.length && <div className='flex flex-wrap items-center gap-2'>
        {fullCommunityTags.slice(0, 3).map((tag, index) => {
          return <Tag
            key={tag.name}
            variant='tag'
            label={tag.name}
            iconLeft={<TagIcon tag={tag} />}
          />
        })}
        {fullCommunityTags.length > 3 && <span className="cg-text-secondary cg-text-md-400">
          +{fullCommunityTags.length - 3} more
        </span>}
      </div>}
    </div>
  </div>);
}

export default React.memo(LargeCommunityCard);
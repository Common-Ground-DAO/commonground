// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import CommunityPhoto from 'components/atoms/CommunityPhoto/CommunityPhoto';
import { useCommunityListView } from 'context/CommunityListViewProvider';
import { useSignedUrl } from 'hooks/useSignedUrl';
import React, { useMemo } from 'react';
import { getCommunityDisplayName } from '../../../util';
import Button from 'components/atoms/Button/Button';
import { usePluginDetailsModalContext } from 'context/PluginDetailsModalProvider';
import { useNavigate } from 'react-router';
import { getUrl } from 'common/util';
import { Plug, ShareNetwork } from '@phosphor-icons/react';
import { useSnackbarContext } from 'context/SnackbarContext';
import { tagStringToPredefinedTag } from 'components/molecules/inputs/TagInputField/TagInputField';
import Tag, { TagIcon } from 'components/atoms/Tag/Tag';
import ExternalIcon, { ExternalIconType } from 'components/atoms/ExternalIcon/ExternalIcon';
import { cssBackgroundImage } from 'util/cssBackground';

type Props = API.Plugins.getAppstorePlugins.Response['plugins'][number];

const PluginCard: React.FC<Props> = (props) => {
  const { communityCount, url } = props;
  const { showSnackbar } = useSnackbarContext();
  const { showModal } = usePluginDetailsModalContext();

  return <div className='flex flex-col p-4 gap-4 cg-bg-subtle cg-border-xl cg-text-main justify-between'>
    <PluginCardInner {...props} />

    <div className='flex justify-between items-center gap-2'>
      <div className='flex flex-col gap-1 overflow-hidden'>
        <p className='cg-text-secondary cg-text-md-500 overflow-hidden whitespace-nowrap text-ellipsis'>Hosted at: {url}</p>
        <p className='cg-text-secondary cg-text-md-500'>{communityCount} {communityCount === 1 ? 'community' : 'communities'} are using this plugin</p>
      </div>
      <div className='flex items-center gap-2'>
        <Button
          role='secondary'
          text='Share'
          iconLeft={<ShareNetwork weight='duotone' className='w-5 h-5' />}
          onClick={() => {
            navigator.clipboard.writeText(`${window.location.origin}/store/${props.pluginId}`);
            showSnackbar({
              text: 'Plugin URL copied to clipboard',
              type: 'success',
            });
          }}
        />
        <Button
          role={'primary'}
          text={'Details'}
          onClick={() => {
            showModal({
              plugin: props,
            });
          }}
        />
      </div>
    </div>
  </div>;
};

export const PluginCardInner: React.FC<Models.Plugin.PluginListView> = (props) => {
  const { name, description, imageId, ownerCommunityId, tags } = props;
  const navigate = useNavigate();
  const imageUrl = useSignedUrl(imageId);
  const ownerCommunity = useCommunityListView(ownerCommunityId);
  const fullTags = useMemo(() => tagStringToPredefinedTag(tags ?? []), [tags])

  return <div className='flex gap-4'>
    <div>
      {imageId && <div className='w-28 h-28 bg-cg-bg-subtle cg-border-l bg-no-repeat bg-cover bg-center' style={{ backgroundImage: cssBackgroundImage(imageUrl) }} />}
      {!imageId && <div className='w-28 h-28 bg-cg-bg-subtle cg-border-l flex items-center justify-center'>
        <Plug weight='duotone' className='w-20 h-20' />
      </div>}
    </div>
    <div className='flex flex-col gap-2 flex-1 overflow-hidden'>
      <div className='flex flex-col gap-2'>
        <div className='flex flex-col gap-1'>
          <h3>{name}</h3>
          <div className='flex items-center gap-2 cg-text-secondary cg-text-md-500'>
            <span>From</span>
            {ownerCommunity && <div className='flex items-center gap-2 overflow-hidden cursor-pointer' onClick={() => navigate(getUrl({ type: 'community-lobby', community: ownerCommunity }))}>
              <CommunityPhoto community={ownerCommunity} size='tiny-20' noHover />
              {getCommunityDisplayName(ownerCommunity)}
            </div>}
          </div>
        </div>
        {fullTags.length > 0 && <div className='flex items-center flex-wrap gap-2'>
          {fullTags.map(tag => <Tag
            variant='tag'
            iconLeft={<TagIcon tag={tag} />}
            key={tag.name}
            label={tag.name}
          />)}
        </div>}
      </div>
      <div className='flex flex-col gap-1 cg-text-lg-400'>
        <p>{description}</p>
      </div>
    </div>
  </div>
}

export default PluginCard;
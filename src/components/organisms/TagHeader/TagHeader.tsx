// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Button from 'components/atoms/Button/Button';
import Tag, { TagIcon } from 'components/atoms/Tag/Tag';
import { PredefinedTag } from 'components/molecules/inputs/TagInputField/predefinedTags';
import React from 'react'
import TagFilterMenu from '../TagFilterMenu/TagFilterMenu';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import { ChevronDownIcon } from '@heroicons/react/20/solid';
import { Funnel, X } from '@phosphor-icons/react';

type Props = {
  preTagElements?: React.ReactNode;
  activeTags: PredefinedTag[];
  setActiveTags: React.Dispatch<React.SetStateAction<PredefinedTag[]>>;
};


const TagHeader: React.FC<Props> = (props) => {
  const { preTagElements, activeTags, setActiveTags } = props;
  const { isMobile } = useWindowSizeContext();
  // const [historyTags, setHistoryTags] = useLocalStorage<PredefinedTag[]>([], 'tag-header-recent-tags');

  // const newActiveTags = React.useMemo(() => {
  //   return activeTags.filter(tag => historyTags.every(historyTag => historyTag.name !== tag.name));
  // }, [activeTags, historyTags]);

  // const extraHistoryTags = React.useMemo(() => {
  //   const cutOff = isMobile ? MOBILE_TAG_CUTOFF : MINIMUM_TAGS_DISPLAY;

  //   return historyTags.filter((tag, index) => index < cutOff || activeTags.some(activeTag => activeTag.name === tag.name));
  // }, [isMobile, historyTags, activeTags]);

  const tags = <>
    {activeTags.map((tag) => (<Tag
      className='cursor-pointer'
      key={tag.name}
      variant={'tag-active'}
      label={tag.name}
      iconLeft={<TagIcon tag={tag} />}
      iconRight={<X className='w-4 h-4 cg-text-secondary' />}
      onClick={() => {
        setActiveTags(oldActive => oldActive.filter(activeTag => activeTag.name !== tag.name));
      }}
    />
    ))}
    {activeTags.length > 0 && <Button
      role='chip'
      text='Clear tags'
      onClick={() => setActiveTags([])}
    />}
  </>

  return (<div className='flex flex-col gap-2'>
    <div className={isMobile ? 'flex justify-between gap-2 px-4' : 'flex justify-between gap-2'}>
      <div className='flex flex-wrap gap-2 items-center'>
        {preTagElements}
        {!isMobile && tags}
      </div>

      <div className='flex gap-2 items-center shrink-0 h-fit'>
        <div className='flex-shrink-0'>
          <TagFilterMenu
            activeTags={activeTags}
            setActiveTags={setActiveTags}
            triggerContent={<Button
              role='chip'
              text='Filter by tags'
              iconLeft={<Funnel weight='duotone' className='w-5 h-5' />}
              iconRight={<ChevronDownIcon className='w-5 h-5' />}
            />}
          />
        </div>
      </div>
    </div>
    {!!isMobile && <div className='flex flex-wrap gap-2 items-center px-4'>{tags}</div>}
  </div>);
}

export default React.memo(TagHeader);
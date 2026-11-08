// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './TagFilterMenu.css';
import Button from 'components/atoms/Button/Button';
import ScreenAwarePopover from 'components/atoms/ScreenAwarePopover/ScreenAwarePopover';
import { PopoverHandle } from 'components/atoms/Tooltip/Tooltip';
import Scrollable from 'components/molecules/Scrollable/Scrollable';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import useLocalStorage from 'hooks/useLocalStorage';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { PredefinedTag, generalTagList, web3TagList } from 'components/molecules/inputs/TagInputField/predefinedTags';
import Tag, { TagIcon } from 'components/atoms/Tag/Tag';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import { tagStringToPredefinedTag } from 'components/molecules/inputs/TagInputField/TagInputField';

type Props = {
  triggerContent: React.JSX.Element;
  activeTags: PredefinedTag[];
  setActiveTags: (tags: PredefinedTag[]) => void;
};

const COLLAPSED_COUNT = 5;
const RECENT_COUNT = 10;

const TagFilterMenu: React.FC<Props> = (props) => {
  const { activeTags, setActiveTags } = props;
  const { isMobile } = useWindowSizeContext();
  const [recentTags, setRecentTags] = useLocalStorage<PredefinedTag[]>([], 'tag-header-recent-tags');
  const [inputFilter, setInputFilter] = useState('');
  const modalRef = useRef<PopoverHandle>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const [showMoreGeneralTags, setShowMoreGeneralTags] = React.useState(false);
  const [showMoreWeb3Tags, setShowMoreWeb3Tags] = React.useState(false);
  const [selectedFilterTagIndex, setSelectedFilterTagIndex] = useState<number | null>(null);

  const generalList = useMemo(() => {
    if (showMoreGeneralTags) return generalTagList;
    return generalTagList.slice(0, COLLAPSED_COUNT);
  }, [showMoreGeneralTags]);

  const web3List = useMemo(() => {
    if (showMoreWeb3Tags) return web3TagList;
    return web3TagList.slice(0, COLLAPSED_COUNT);
  }, [showMoreWeb3Tags]);

  const onToggleTag = useCallback((tag: PredefinedTag) => {
    if (activeTags.find(activeTag => activeTag.name === tag.name)) {
      setActiveTags(activeTags.filter(activeTag => activeTag.name !== tag.name));
    } else {
      setActiveTags([...activeTags, tag]);
      setRecentTags(oldTags => {
        if (oldTags.find(oldTag => oldTag.name === tag.name)) {
          return oldTags;
        }

        const uniqueTags = [tag, ...oldTags].filter((t, index, array) =>
          array.findIndex(h => h.name === t.name) === index
        );
        return uniqueTags.slice(0, RECENT_COUNT);
      });
    }

    if (!!inputFilter) {
      setInputFilter('');
      filterInputRef.current?.focus();
    }
  }, [activeTags, inputFilter, setActiveTags, setRecentTags]);

  const filteredTags = useMemo(() => {
    if (!inputFilter) return [];

    const allTags = [...generalTagList, ...web3TagList];
    return allTags.filter(tag => tag.name.toLowerCase().includes(inputFilter.toLowerCase()));
  }, [inputFilter]);

  const newTagFromInput = useMemo(() => {
    if (!inputFilter) return null;

    // Don't show on exact matches
    if (generalTagList.some(tag => tag.name.toLowerCase() === inputFilter.toLowerCase()) ||
      web3TagList.some(tag => tag.name.toLowerCase() === inputFilter.toLowerCase())) {
      return null;
    }

    return tagStringToPredefinedTag([inputFilter])[0];
  }, [inputFilter]);

  const onFilterInputKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!inputFilter) return;

    const tagLimit = filteredTags.length + (newTagFromInput ? 1 : 0);

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedFilterTagIndex(prev =>
        prev === null ? 0 :
          prev >= tagLimit - 1 ? 0 :
            prev + 1
      );
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedFilterTagIndex(prev =>
        prev === null ? tagLimit - 1 :
          prev <= 0 ? tagLimit - 1 :
            prev - 1
      );
    } else if (event.key === 'Enter' && selectedFilterTagIndex !== null) {
      event.preventDefault();
      const selectedTag = selectedFilterTagIndex < filteredTags.length ? filteredTags[selectedFilterTagIndex] : newTagFromInput;
      if (selectedTag) {
        onToggleTag(selectedTag);
        setSelectedFilterTagIndex(null);
      }
    }
  }, [filteredTags, inputFilter, newTagFromInput, onToggleTag, selectedFilterTagIndex]);

  return (<ScreenAwarePopover
    ref={modalRef}
    triggerContent={props.triggerContent}
    triggerType='click'
    closeOn='toggle'
    placement='bottom-end'
    noDefaultScrollable={!isMobile}
    tooltipClassName={`tag-filter-menu${!isMobile ? ' desktop cg-content-stack' : ''}`}
    offset={8}
    onClose={() => {
      setShowMoreGeneralTags(false);
      setShowMoreWeb3Tags(false);
    }}
    tooltipContent={<div className={`cg-text-lg-400 cg-text-main h-full overflow-hidden`}>
      <Scrollable innerClassName='flex flex-col gap-4 p-4'>
        <TextInputField
          value={inputFilter}
          inputRef={filterInputRef}
          onChange={setInputFilter}
          onKeyDown={onFilterInputKeyDown}
          placeholder='Filter tags...'
        />
        {!!inputFilter && <>
          <div className='flex flex-wrap gap-2'>
            {filteredTags.map((tag, index) => <Tag
              key={tag.name}
              className={`cursor-pointer${index === selectedFilterTagIndex ? ' hovered' : ''}`}
              variant={props.activeTags.find(activeTag => activeTag.name === tag.name) ? 'tag-active' : 'tag'}
              label={tag.name}
              iconLeft={<TagIcon tag={tag} />}
              onClick={() => onToggleTag(tag)}
            />)}
            {!!newTagFromInput && <Tag
              className={`cursor-pointer${(selectedFilterTagIndex || 0) >= filteredTags.length ? ' hovered' : ''}`}
              variant={props.activeTags.find(activeTag => activeTag.name === inputFilter) ? 'tag-active' : 'tag'}
              label={inputFilter}
              iconLeft={<TagIcon tag={newTagFromInput} />}
              onClick={() => onToggleTag(newTagFromInput)}
            />}
          </div>
        </>}

        {!inputFilter && <>
          {recentTags.length > 0 && <div className='flex flex-col gap-2'>
            <h4 className='cg-text-secondary'>Recent Tags</h4>
            <div className='flex flex-wrap gap-2'>
              {recentTags.map(tag => <Tag
                key={tag.name}
                className='cursor-pointer'
                variant={props.activeTags.find(activeTag => activeTag.name === tag.name) ? 'tag-active' : 'tag'}
                label={tag.name}
                iconLeft={<TagIcon tag={tag} />}
                onClick={() => onToggleTag(tag)}
              />)}
            </div>
          </div>}

          <div className='flex flex-col gap-2'>
            <h4 className='cg-text-secondary'>Tags</h4>
            <div className='flex flex-wrap gap-2'>
              {generalList.map(tag => <Tag
                key={tag.name}
                className='cursor-pointer'
                variant={props.activeTags.find(activeTag => activeTag.name === tag.name) ? 'tag-active' : 'tag'}
                label={tag.name}
                iconLeft={<TagIcon tag={tag} />}
                onClick={() => onToggleTag(tag)}
              />)}
              {!showMoreGeneralTags && <Button
                role='textual'
                text='Show more...'
                onClick={() => setShowMoreGeneralTags(true)}
              />}
            </div>
          </div>

          <div className='flex flex-col gap-2'>
            <h4 className='cg-text-secondary'>Web3 Tags</h4>
            <div className='flex flex-wrap gap-2'>
              {web3List.map(tag => <Tag
                key={tag.name}
                className='cursor-pointer'
                variant={props.activeTags.find(activeTag => activeTag.name === tag.name) ? 'tag-active' : 'tag'}
                label={tag.name}
                iconLeft={<TagIcon tag={tag} />}
                onClick={() => onToggleTag(tag)}
              />)}
              {!showMoreWeb3Tags && <Button
                role='textual'
                text='Show more...'
                onClick={() => setShowMoreWeb3Tags(true)}
              />}</div>
          </div>
        </>}
      </Scrollable>

    </div>}
  />);
}

export default React.memo(TagFilterMenu);
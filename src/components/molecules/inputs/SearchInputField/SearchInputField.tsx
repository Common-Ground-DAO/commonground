// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useState, useRef, useEffect, useMemo } from 'react';
import "./SearchInputField.css";
import { validateTagTextInput } from '../../../../common/validators';
import { InlineToastType } from '../../../atoms/InlineToast/InlineToast';
import { predefinedTagList, PredefinedTag } from '../TagInputField/predefinedTags';
import TagSuggestionsDropdown from '../TagInputField/TagSuggestionsDropdown';
import TextInputField from '../TextInputField/TextInputField';
import { MagnifyingGlass } from '@phosphor-icons/react';

const allPredefinedTags = new Map(predefinedTagList.map(tag => [tag.name, tag]))

export function tagStringToPredefinedTag(tagsString: string[]): PredefinedTag[] {
  return tagsString.map(tag => {
    const predefinedTag = allPredefinedTags.get(tag);
    return predefinedTag || { name: tag, externalIcon: 'tag' };
  });
}

type Props = {
  value: string
  onChange: (value: string) => void;
  onAddTag: (tag: PredefinedTag) => void;
  currentTags: PredefinedTag[];
  placeholder?: string;
  label?: string;
  labelClassName?: string;
  disabled?: boolean;
  onBlur?: (e: React.FocusEvent<Element>) => void;
  backgroundColor?: string;
}

export default function SearchInputField(props: Props) {
  const {
    value,
    onChange,
    onAddTag,
    currentTags,
    placeholder,
    label,
    labelClassName,
    disabled,
    onBlur: propsOnBlur,
    backgroundColor,
  } = props;
  const [currentTag, setCurrentTag] = React.useState<string>('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [filteredSuggestions, setFilteredSuggestions] = useState<PredefinedTag[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownContainerRef.current && !dropdownContainerRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const addTag = (newTagString: string) => {
    if (disabled) return;

    const trimmedValue = newTagString.trim();
    if (trimmedValue.length === 0) {
      setCurrentTag('');
      return;
    }

    const predefinedMatch = predefinedTagList.find(pt => pt.name.toLowerCase() === trimmedValue.toLowerCase());
    let finalTagValue = predefinedMatch ? predefinedMatch.name : trimmedValue;

    const validationError = validateTagTextInput(finalTagValue);
    if (!validationError) {
      const [newTag] = tagStringToPredefinedTag([finalTagValue]);
      onAddTag(newTag);
      setCurrentTag('');

      const lastHashIndex = value.lastIndexOf('#');
      if (lastHashIndex !== -1) {
        const textWithoutHash = value.substring(0, lastHashIndex);
        onChange(textWithoutHash.trim());
      }
    }
  };

  const handleSelectTagFromDropdown = (tagName: string) => {
    addTag(tagName);
    setCurrentTag('');
    setShowSuggestions(false);
    if (inputRef.current) inputRef.current.focus();
  };

  const handleKeyInput = (event: React.KeyboardEvent<Element>) => {
    if (event.key === 'Escape') {
      setShowSuggestions(false);
    }
  };

  const updateCurrentTag = useCallback((newCurrentTag: string) => {
    onChange(newCurrentTag);

    const lastHashIndex = newCurrentTag.lastIndexOf('#');
    if (lastHashIndex !== -1) {
      const tagPart = newCurrentTag.substring(lastHashIndex + 1);
      setCurrentTag(tagPart);
      setShowSuggestions(true);
    } else {
      setShowSuggestions(false);
    }
  }, [onChange]);


  const handleInputFocus = () => {
    if (currentTag.trim().length > 0) {
      setShowSuggestions(true);
    }
  };

  const handleInputBlur = (e: React.FocusEvent<Element>) => {
    if (propsOnBlur) {
      propsOnBlur(e);
    }
  };

  const selectedTagStrings = useMemo(() => {
    return currentTags.map(tag => tag.name);
  }, [currentTags]);

  return (
    <div className='tag-input-field' ref={dropdownContainerRef}>
      <div className="input-container">
        {label && <label className={'cg-text-lg-500 mb-2 cg-text-main ' + (labelClassName || '')}>{label}</label>}
        <div className="tag-input-container">
          <TextInputField
            inputRef={inputRef}
            value={value}
            placeholder={placeholder}
            onChange={updateCurrentTag}
            onKeyPress={handleKeyInput}
            onBlur={handleInputBlur}
            onFocus={handleInputFocus}
            disabled={disabled}
            iconLeft={<MagnifyingGlass weight='duotone' className='w-5 h-5' />}
            backgroundColor={backgroundColor}
          />
          <TagSuggestionsDropdown
            inputValue={currentTag}
            generalTags={predefinedTagList}
            onSelectTag={handleSelectTagFromDropdown}
            showDropdown={showSuggestions}
            inputRef={inputRef}
            selectedTags={selectedTagStrings}
            filteredSuggestions={filteredSuggestions}
            setFilteredSuggestions={setFilteredSuggestions}
          />
        </div>
      </div>
    </div>
  );
}
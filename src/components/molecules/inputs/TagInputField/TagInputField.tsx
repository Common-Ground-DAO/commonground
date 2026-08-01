// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useState, useRef, useEffect } from 'react';
import "./TagInputField.css";
import Tag, { TagIcon } from '../../../../components/atoms/Tag/Tag';
import { validateTagTextInput } from '../../../../common/validators';
import InlineToast, { InlineToastType } from '../../../atoms/InlineToast/InlineToast';
import { predefinedTagList, PredefinedTag } from './predefinedTags';
import TagSuggestionsDropdown from './TagSuggestionsDropdown';
import { X } from '@phosphor-icons/react';

const allPredefinedTags = new Map(predefinedTagList.map(tag => [tag.name, tag]))

export function tagStringToPredefinedTag(tagsString: string[]): PredefinedTag[] {
    return tagsString.map(tag => {
        const predefinedTag = allPredefinedTags.get(tag);
        return predefinedTag || { name: tag, externalIcon: 'tag' };
    });
}

type Props = {
    tags: string[];
    onTagsChange: (tags: string[]) => void;
    placeholder?: string;
    label?: string;
    inputClassName?: string;
    labelClassName?: string;
    disabled?: boolean;
    hideTooltips?: boolean;
    onBlur?: (e: React.FocusEvent<Element>) => void;
    inlineToast?: InlineToastType;
}

export default function TagInputField(props: Props) {
    const {
        tags,
        onTagsChange,
        placeholder,
        label,
        inputClassName,
        labelClassName,
        disabled,
        hideTooltips,
        onBlur: propsOnBlur,
        inlineToast,
    } = props;
    const [error, setError] = React.useState<string | undefined>(undefined);
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

    const handleAddTagFromInput = (inputValue: string) => {
        addTag(inputValue);
        setShowSuggestions(false);
    };

    const handleSelectTagFromDropdown = (tagName: string) => {
        addTag(tagName);
        setCurrentTag('');
        setError(undefined);
        setShowSuggestions(false);
        if (inputRef.current) inputRef.current.focus();
    };

    const handleKeyInput = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (showSuggestions && (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === 'Escape')) {
            return;
        }

        if (event.key === 'Escape') {
            setShowSuggestions(false);
        }
    };

    const updateCurrentTag = useCallback((newCurrentTag: string) => {
        let displayError: string | undefined = undefined;
        if (newCurrentTag) {
            const parts = newCurrentTag.split(',');
            const lastPart = parts.length > 0 ? parts[parts.length - 1].trim() : newCurrentTag.trim();
            if (lastPart) {
                displayError = validateTagTextInput(lastPart);
            }
        }
        setError(displayError);
        setCurrentTag(newCurrentTag);
        if (newCurrentTag.trim().length > 0) {
            setShowSuggestions(true);
        } else {
            setShowSuggestions(false);
        }
    }, [setError, setCurrentTag, setShowSuggestions]);

    const addTag = (value: string) => {
        if (disabled) return;

        const trimmedValue = value.trim();
        if (trimmedValue.length === 0) {
            setCurrentTag('');
            setError(undefined);
            return;
        }

        const individualTagValues = trimmedValue.split(',')
            .map(v => v.trim())
            .filter(v => !!v);

        const tagsToAdd: string[] = [];
        let anErrorOccurred = false;
        let lastValidationError: string | undefined = undefined;

        for (const val of individualTagValues) {
            const predefinedMatch = predefinedTagList.find(pt => pt.name.toLowerCase() === val.toLowerCase());
            let finalTagValue = predefinedMatch ? predefinedMatch.name : val;

            const validationError = validateTagTextInput(finalTagValue);
            if (validationError) {
                lastValidationError = validationError;
                anErrorOccurred = true;
                continue;
            }

            const isDuplicateInExisting = tags.some(existingTag => existingTag.toLowerCase() === finalTagValue.toLowerCase());
            if (isDuplicateInExisting) {
                continue;
            }

            const isDuplicateInCurrentBatch = tagsToAdd.some(t => t.toLowerCase() === finalTagValue.toLowerCase());
            if (isDuplicateInCurrentBatch) {
                continue;
            }

            tagsToAdd.push(finalTagValue);
        }

        if (tagsToAdd.length > 0) {
            onTagsChange([...tags, ...tagsToAdd]);
        }

        if (anErrorOccurred && lastValidationError) {
            setError(lastValidationError);
        } else if (!anErrorOccurred && individualTagValues.length > 0 && tagsToAdd.length === 0) {
            setCurrentTag('');
            setError(undefined);
        } else if (tagsToAdd.length > 0 || (!anErrorOccurred && individualTagValues.length === 0)) {
            setCurrentTag('');
            setError(undefined);
        }
    };

    const handleTagRemove = (tag: string) => {
        if (disabled) return;

        const filteredTags = tags.filter(thisTag => thisTag !== tag);
        onTagsChange(filteredTags);
    };

    const handleInputFocus = () => {
        if (currentTag.trim().length > 0) {
            setShowSuggestions(true);
        }
    };

    const handleInputBlur = (e: React.FocusEvent<HTMLInputElement>) => {
        if (propsOnBlur) {
            propsOnBlur(e);
        }
    };

    const customTags = React.useMemo(() => tagStringToPredefinedTag(tags), [tags]);

    return (
        <div className='tag-input-field' ref={dropdownContainerRef}>
            <div className="input-container">
                {label && <label className={'cg-text-lg-500 mb-2 cg-text-main ' + (labelClassName || '')}>{label}</label>}
                <div className="tag-input-container">
                    <span className={`pre-icon cg-text-secondary${error ? " error" : ""}`}>#</span>
                    <input
                        ref={inputRef}
                        type="text"
                        value={currentTag}
                        placeholder={placeholder}
                        className={`input input-bordered w-full ${inputClassName}${error ? " error" : ""}`}
                        onChange={(ev) => updateCurrentTag(ev.target.value)}
                        onKeyDown={handleKeyInput}
                        onFocus={handleInputFocus}
                        onBlur={handleInputBlur}
                        disabled={disabled}
                        autoComplete="off"
                        aria-haspopup="listbox"
                    />
                    {inlineToast && <InlineToast type={inlineToast} textAreaToast />}
                    <TagSuggestionsDropdown
                        inputValue={currentTag}
                        generalTags={predefinedTagList}
                        onSelectTag={handleSelectTagFromDropdown}
                        showDropdown={showSuggestions}
                        inputRef={inputRef}
                        selectedTags={tags}
                        filteredSuggestions={filteredSuggestions}
                        setFilteredSuggestions={setFilteredSuggestions}
                    />
                </div>
                {!hideTooltips && error && <span className="error">{error}</span>}
            </div>
            {!hideTooltips && customTags.length > 0 && <div className="flex flex-wrap gap-2">
                {customTags.map(tag => <Tag
                    variant='tag'
                    iconRight={<X className='w-4 h-4 cg-text-secondary' />}
                    iconLeft={<TagIcon tag={tag} />}
                    className={disabled ? 'cursor-not-allowed' : 'cursor-pointer'}
                    key={tag.name}
                    label={tag.name}
                    onClick={() => handleTagRemove(tag.name)}
                />)}
            </div>}
        </div>
    );
}
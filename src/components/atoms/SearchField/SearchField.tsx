// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import TextInputField from "../../molecules/inputs/TextInputField/TextInputField";
import SearchIcon from "../../atoms/icons/16/Search.svg?react";

import './SearchField.css';

type Props = {
    value: string;
    placeholder?: string;
    onChange: (value: string) => void
}

const SearchField: React.FC<Props> = (props) => {
    return (
        <div className="search-input-container">
            <SearchIcon className="pre-icon" />
            <TextInputField
                value={props.value}
                onChange={props.onChange}
                inputClassName="search-input-field"
                labelClassName="search-input-label"
                placeholder={props.placeholder || 'Search'}
            />
        </div>
    )
}

export default React.memo(SearchField);
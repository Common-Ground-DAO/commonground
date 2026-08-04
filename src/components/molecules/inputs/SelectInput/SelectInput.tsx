// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import Select, { Options, SingleValue } from "react-select";
import "./SelectInput.css";

type Props<T> = {
    selectedValue: SingleValue<{value: T, label: string | React.JSX.Element}> | undefined;
    options: Options<{value: T, label: string | React.JSX.Element}>;
    onChange: (newValue:  any) => void;
    placeholder?: string;
    label?: string;
    labelClassName?: string;
    selectClassName?: string;
    hideSelectedOptions?: boolean;
    isSearchable?: boolean;
    menuPlacement?: "top" | "bottom" | "auto";
    DropdownIndicator?: React.FC;
    styles?: {
        valueColor?: string;
    }
}

export default function SelectInput<T>(props: Props<T>) {
    const { selectedValue, options, onChange, placeholder, label, labelClassName, selectClassName, hideSelectedOptions, isSearchable, menuPlacement, DropdownIndicator, styles } = props;

    const overrideComponents = {} as any;
    if (DropdownIndicator) {
        overrideComponents.DropdownIndicator = DropdownIndicator;
    }

    return (
        <label className={labelClassName ? labelClassName : ""}>
            {label}
            <Select
                styles={{ singleValue: (css => (
                    {...css,
                        color: styles?.valueColor || '#F9F9F9'
                    }
                ))}}
                components={overrideComponents}
                value={selectedValue}
                options={options}
                onChange={onChange}
                placeholder={placeholder}
                className={`select-input ${selectClassName ? selectClassName : ""}`}
                classNamePrefix='select-input'
                hideSelectedOptions={hideSelectedOptions}
                isSearchable={isSearchable}
                menuPlacement={menuPlacement}
            />
        </label>
    )
}
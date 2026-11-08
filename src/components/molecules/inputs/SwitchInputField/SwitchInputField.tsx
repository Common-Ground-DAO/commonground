// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import Button from "../../../atoms/Button/Button";
import "./SwitchInputField.css";

type SwitchOption = {
    value: string;
    iconLeft?: React.JSX.Element;
    iconRight?: React.JSX.Element;
    text?: string;
}

type Props = {
    options: SwitchOption[];
    value: string;
    onChange: (value: string) => void;
    label?: string;
    subtitle?: string;
    disabled?: boolean;
    className?: string;
}

export default function SwitchInputField(props: Props) {
    const { options, value, onChange, label, subtitle, disabled, className } = props;

    return (
        <div className={`switch-input-field ${className ? className : ''}`}>
            {label && <p className="title">{label}</p>}
            <div className="switch">
                <div className="options">
                    {options.map(option => (
                        <Button key={option.value} role="secondary" className={`${option.value === value ? 'switch-input-active' : ''}`} iconLeft={option.iconLeft} iconRight={option.iconRight} text={option.text} onClick={() => onChange(option.value)} disabled={disabled} />
                    ))}
                </div>
            </div>
            {subtitle && <p className="sub-title">{subtitle}</p>}
        </div>
    );
}
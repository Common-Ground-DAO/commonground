// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import { createSearchParams, useNavigate } from "react-router-dom";
import { useManagementContentModalContext } from "../ManagementContentModalContext";
import "./ManagementContentModalMenu.css";
import SettingsButton from "components/molecules/SettingsButton/SettingsButton";

type Props = {
    items: string[] | React.JSX.Element[];
}

export default function ManagementContentModalMenu(props: Props) {
    const { items } = props;

    return (<div className="flex flex-col p-2 gap-2 w-full">
        {items}
    </div>)
}

export function ManagementContentModalMenuItem(props: { text: string | React.JSX.Element, url: string, disabled?: boolean; leftElement?: React.JSX.Element }) {
    const navigate = useNavigate();
    const { activeModalContent, modalSearchParameter } = useManagementContentModalContext();
    const { text, url, disabled, leftElement } = props;

    const handleClick = (ev: React.MouseEvent<HTMLDivElement>) => {
        ev.stopPropagation();
        if (!disabled) {
            navigate({
                search: createSearchParams({
                    [modalSearchParameter]: url
                }).toString()
            });
        }
    }

    return (<SettingsButton
        onClick={handleClick}
        text={text}
        active={activeModalContent === url}
        disabled={disabled}
        leftElement={leftElement}
    />);
}
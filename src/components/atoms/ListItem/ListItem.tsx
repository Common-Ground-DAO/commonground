// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from "react";
import { useWindowSizeContext } from "../../../context/WindowSizeProvider";
import "./ListItem.css";

type Props = {
    title: React.JSX.Element | string;
    subtitle?: string;
    description?: string | React.JSX.Element;
    icon?: React.JSX.Element | null;
    iconRight?: React.JSX.Element | null;
    disabled?: boolean;
    selected?: boolean;
    onClick?: () => void;
    className?: string;
    propagateEventsOnClick?: boolean;
}

export default function ListItem(props: Props) {
    const { isMobile } = useWindowSizeContext();
    const { title, subtitle, description, icon, iconRight, disabled, selected, onClick, className, propagateEventsOnClick } = props;

    const handleOnClick = (ev: React.MouseEvent) => {
        if (!propagateEventsOnClick) {
            ev.stopPropagation();
        }
        if (onClick && !disabled) {
            onClick();
        }
    }

    const listItemClassName = [
        "list-item-dropdown",
        disabled ? "disabled" : "",
        selected ? "selected" : "",
        className ?? className
    ].join(" ").trim();

    return (
        <div className={listItemClassName} onClick={handleOnClick}>
            {icon && <span className="list-item-dropdown-icon">{icon}</span>}
            <div className="list-item-dropdown-right-side">
                <span className="list-item-dropdown-title">{title}{subtitle && <span className="list-item-dropdown-subtitle">{subtitle}</span>}</span>
                {description && <span className="list-item-dropdown-description">{description}</span>}
            </div>
            {iconRight && <span className="list-item-dropdown-icon">{iconRight}</span>}
        </div>
    )
}
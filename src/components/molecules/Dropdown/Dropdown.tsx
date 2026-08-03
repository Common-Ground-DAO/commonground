// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { Placement } from "@floating-ui/react-dom-interactions";
import Button from "../../atoms/Button/Button";
import { Popover, PopoverHandle } from "../../atoms/Tooltip/Tooltip";
import ChevronDownIcon from '../../../components/atoms/icons/16/ChevronDown.svg?react';

import "./Dropdown.css";
import React, { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import Scrollable from "../Scrollable/Scrollable";

export type Props = {
    triggerContent: string | JSX.Element;
    triggerClassname?: string;
    items: JSX.Element[];
    placement?: Placement;
    offset?: number;
    className?: string;
    footer?: JSX.Element | null;
    closeOnToggleOrLeave?: boolean;
    stayOpenOnClick?: boolean;
    closeOnClick?: boolean;
    title?: string;
    buttonClassName?: string;
    icon?: JSX.Element;
    domChildOfTrigger?: boolean;
    onOpen?: () => void;
    onClose?: () => void;
}

const Dropdown = forwardRef<PopoverHandle, React.PropsWithChildren<Props>>((props, ref) => {
    const {
        triggerContent,
        triggerClassname,
        items,
        placement,
        offset,
        className,
        footer,
        closeOnToggleOrLeave,
        stayOpenOnClick,
        closeOnClick,
        title,
        buttonClassName,
        icon,
        onOpen,
        onClose,
        domChildOfTrigger
    } = props;
    const popoverHandle = useRef(null);
    useImperativeHandle(ref, () => popoverHandle.current!, []);

    const wrappedTriggerContent = useMemo(() => {
        if (typeof triggerContent === "string") {
            return (
                <Button
                    text={triggerContent}
                    className={buttonClassName}
                    iconRight={icon || <ChevronDownIcon />}
                    role="secondary"
                />
            )
        }
        return triggerContent;
    }, [triggerContent, buttonClassName, icon]);

    const tooltipClassName = [
        "dropdown-tooltip",
        className || "",
    ].join(" ").trim();

    const closeOn: 'toggleOrClick' | 'toggleOrLeavePopover' | 'mouseleavePopover' | 'clickPopover' = useMemo(() => {
        if (closeOnToggleOrLeave) return 'toggleOrLeavePopover';
        if (stayOpenOnClick) return 'mouseleavePopover';
        if (closeOnClick) return 'clickPopover';
        return 'toggleOrClick';
    }, [closeOnToggleOrLeave, stayOpenOnClick, closeOnClick]);

    return useMemo(() => (
        <Popover
            ref={popoverHandle}
            placement={placement || "bottom"}
            triggerContent={wrappedTriggerContent}
            triggerClassName={triggerClassname}
            tooltipContent={
                <>
                    {title && <div className="dropdown-title">{title}</div>}
                    <Scrollable
                        innerClassName="dropdown-items-container"
                    >
                        <div className="dropdown-items">
                            {items}
                        </div>
                    </Scrollable>
                    {footer}
                </>
            }
            tooltipClassName={tooltipClassName}
            triggerType="click"
            closeOn={closeOn}
            offset={offset || 8}
            onOpen={onOpen}
            onClose={onClose}
            singletonGroupIdentifier="dropdown"
            domChildOfTrigger={domChildOfTrigger ?? true}
        />
    ), [placement, wrappedTriggerContent, triggerClassname, title, items, footer, tooltipClassName, closeOn, offset, onOpen, onClose, domChildOfTrigger]);
});

export default React.memo(Dropdown);
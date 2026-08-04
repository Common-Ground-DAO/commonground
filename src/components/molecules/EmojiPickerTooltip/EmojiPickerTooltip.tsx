// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Button from "../../atoms/Button/Button";
import AddEmojiIcon from '../../../components/atoms/icons/20/AddEmoji.svg?react';
import "./EmojiPickerTooltip.css";
import ScreenAwarePopover from "components/atoms/ScreenAwarePopover/ScreenAwarePopover";
import EmojiPicker, { EmojiClickData, EmojiStyle, Theme } from "emoji-picker-react";
import { useDarkModeContext } from "context/DarkModeProvider";
import { useWindowSizeContext } from "context/WindowSizeProvider";
import { Placement } from "@floating-ui/react";

type Props = {
    onEmojiClick: (value: string) => void;
    isTooltipOpen?: (isSticky: boolean) => void;
    placement?: Placement;
    triggerContent?: JSX.Element;
}

export default function EmojiPickerTooltip(props: Props) {
    const { onEmojiClick } = props;
    const { isDarkMode } = useDarkModeContext();
    const { isMobile } = useWindowSizeContext();

    const handleEmojiInput = (emoji: EmojiClickData) => {
        onEmojiClick(emoji.emoji);
    }

    const isTooltipOpen = (isOpen: boolean) => {
        props.isTooltipOpen?.(isOpen);
    }

    return (<ScreenAwarePopover
        domChildOfTrigger
        onOpen={() => isTooltipOpen(true)}
        onClose={() => isTooltipOpen(false)}
        placement={props.placement || "left"}
        triggerContent={props.triggerContent || <Button iconLeft={<AddEmojiIcon />} role="borderless" />}
        tooltipContent={<EmojiPicker
            emojiStyle={EmojiStyle.NATIVE}
            onEmojiClick={handleEmojiInput}
            theme={isDarkMode ? Theme.DARK : Theme.LIGHT}
            autoFocusSearch={false}
            searchDisabled={isMobile}
            width={'100%'}
        />}
        triggerType="click"
        closeOn="toggle"
        tooltipClassName="emoji-picker-tooltip"
    />);
}
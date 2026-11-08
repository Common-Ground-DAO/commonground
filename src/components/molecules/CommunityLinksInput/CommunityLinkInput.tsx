// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Button from "../../atoms/Button/Button";
import { useState } from "react";
import { InlineToastType } from "../../atoms/InlineToast/InlineToast";
import TextInputField from "../../molecules/inputs/TextInputField/TextInputField";
import { Tooltip } from "../../atoms/Tooltip/Tooltip";
import CloseIcon from '../../atoms/icons/16/Close.svg?react';

type Props = {
    link: Common.Link;
    index: number;
    removeLink: (index: number) => void;
    changeLink: (link: Common.Link, index: number, hasError: boolean) => void;
    inlineToast?: InlineToastType;
}

export default function CommunityLinkInput (props: Props) {
    const { link, index, removeLink, changeLink, inlineToast } = props;
    const [url, setURL] = useState<string>(link.url);
    const [text, setText] = useState<string>(link.text);
    const [urlInputState, setURLInputState] = useState<string>('');
    const [textInputState, setTextInputState] = useState<string>('');
    const [textError, setTextError] = useState<string>();

    const updateURL = (newURL: string) => {
        setURL(newURL);
        changeLink({ url: newURL, text }, index, !!textError);
    };

    const updateText = (newText: string) => {
        if (newText.length === 30) { 
            setTextError("Link texts has a maximum of 30 characters!");
            setTimeout(() => {
                setTextError(undefined);
            }, 4000);
        } else {
            setTextError(undefined);
            setText(newText);
            changeLink({ url, text: newText }, index, newText.length > 30);
        }
    };

    const onClickRemoveLink = (ev: React.MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
        removeLink(index);
    };

    return (
        <div className='community-link-editor' key={`link-${index}`}>
            <TextInputField
                inputClassName={`rounded ${textInputState}`}
                value={text}
                placeholder="Text to display"
                onChange={updateText}
                onMouseEnter={() => setTextInputState('hovered')}
                onMouseLeave={() => setTextInputState('')}
                tabIndex={index * 3 + 2}
                inlineToast={(!!textError || !text || !url) ? undefined : inlineToast}
                hideErrorText
            />
            <TextInputField
                inputClassName={`rounded ${urlInputState}`}
                value={url}
                placeholder={`Link ${index + 1}`}
                onChange={(value) => updateURL(value.trim())}
                onMouseEnter={() => setURLInputState('hovered')}
                onMouseLeave={() => setURLInputState('')}
                tabIndex={index * 3 + 1}
            />
            <Tooltip
                placement="right"
                triggerContent={
                    <Button
                        role="secondary"
                        onClick={(ev) => onClickRemoveLink(ev)}
                        tabIndex={index * 3 + 3}
                        iconLeft={<CloseIcon />}
                    />
                }
                tooltipContent="Remove"
                offset={4}
            />
            {textError && <span className="error">{textError}</span>}
        </div>
    );
}
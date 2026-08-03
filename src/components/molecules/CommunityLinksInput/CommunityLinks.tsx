// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useRef, useState } from 'react';
import { InlineToastType } from '../../atoms/InlineToast/InlineToast';
import CommunityLinkInput from './CommunityLinkInput';
import Button from '../../atoms/Button/Button';
import Add from '../../atoms/icons/16/Add.svg?react';

import "./CommunityLinks.css";

type Props = {
    links: Common.Link[];
    onChange: (links: Common.Link[]) => void; // reflect the changes to parent component
    label?: string;
    subLabel?: string;
    labelClassName?: string;
    onSave?: (links: Common.Link[]) => void; // immediately save the changes
    inlineToast?: InlineToastType;
}

const MAX_LINKS_ERROR = "You can only add up to 10 links!";

export default function CommunityLinks(props: Props) {
    const { links, onChange, label, subLabel, labelClassName, onSave, inlineToast } = props;
    const [_links, _setLinks] = useState(links);
    const linksRef = useRef<Common.Link[]>(_links);
    const delayedSaveTimeoutRef = useRef<any>(null);
    const [ error, setError] = useState<string>();

    const saveLinks = (): void => {
        if (!error) {
            if (delayedSaveTimeoutRef.current) {
                clearTimeout(delayedSaveTimeoutRef.current);
                delayedSaveTimeoutRef.current = null;
            }
            if (onSave) {
                onSave(linksRef.current);
            }
        }
    }

    const delayDebouncedSave = (timeout: number) => {
        if (delayedSaveTimeoutRef.current) {
            clearTimeout(delayedSaveTimeoutRef.current);
        }
        delayedSaveTimeoutRef.current = setTimeout(() => {
            saveLinks();
        }, timeout);
    }

    const addLink = () => {
        if (_links.length === 10) {
            setError(MAX_LINKS_ERROR);
            setTimeout(() => {
                setError(undefined);
            }, 3000);
        } else {
            const links = [..._links, { url: '', text: '' }];
            _setLinks(links);
            linksRef.current = links;
            onChange(links);
            delayDebouncedSave(500);
            setError(undefined);
        }
    }

    const removeLink = (index: number) => {
        _links.splice(index, 1);
        _setLinks([..._links]);
        linksRef.current = _links;
        onChange(links);
        delayDebouncedSave(500);
    }

    const changeLink = (link: Common.Link, index: number, hasError: boolean) => {
        _links.splice(index, 1, link);
        _setLinks([..._links]);
        linksRef.current = _links;
        if (!hasError) {
            onChange([..._links]);
            delayDebouncedSave(2000);
        }
    }

    return (
        <div className="input-container">
            {label && <label className={'cg-text-lg-500 mb-2 cg-text-main ' + (labelClassName || '')}>{label}</label>}
            {subLabel && <span className="sub-label">{subLabel}</span>}
            <div className="community-links">
                {_links.map((link: Common.Link, index: number) => <CommunityLinkInput key={index} link={link} index={index} removeLink={removeLink} changeLink={changeLink} inlineToast={inlineToast} />)}
                <Button
                    text="Add link"
                    iconLeft={<Add />}
                    role="secondary"
                    onClick={() => addLink()}
                    className="self-start"
                />
            </div>
            {error && <div className='text-red-400'>{error}</div>}
        </div>
    );
}
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import { Placement } from '@floating-ui/react-dom-interactions';

import CheckIcon from '../../../components/atoms/icons/20/Check.svg?react';
import CloseIcon from '../../../components/atoms/icons/20/Close.svg?react';
import QuestionMarkCircleIcon from '../../../components/atoms/icons/20/QuestionMarkCircle.svg?react';
import ShieldCheckIcon from '../../../components/atoms/icons/20/ShieldCheck.svg?react';
import CloseFilledIcon from '../../../components/atoms/icons/16/Close-1.svg?react';
import { SignalIcon, WalletIcon } from '@heroicons/react/20/solid';

import { Tooltip } from '../Tooltip/Tooltip';

import "./Tag.css";
import { Info, Warning } from '@phosphor-icons/react';
import { PredefinedTag } from 'components/molecules/inputs/TagInputField/predefinedTags';
import ExternalIcon, { ExternalIconType } from '../ExternalIcon/ExternalIcon';

export type TagVariant = "success" | "info" | "safe" | "warning" | "error" | "date" | "default" | "category" | "help" | "wallet" | "live" | "new" | "tag" | "tag-active";

export interface TagProps {
    label?: string;
    iconLeft?: JSX.Element;
    iconRight?: JSX.Element;
    tooltipContent?: string | JSX.Element;
    tooltipPlacement?: Placement;
    className?: string;
    variant?: TagVariant;
    onClick?: (ev: React.MouseEvent<HTMLDivElement>) => void;
    largeFont?: boolean;
};

const Tag: React.FC<TagProps> = ({ onClick, label, tooltipContent, tooltipPlacement, variant, className, iconLeft, iconRight, largeFont }) => {
    const tagClassname = ["tag", className || ""];

    switch (variant) {
        case "warning":
            iconLeft = <Warning weight='duotone' className='w-5 h-5' />;
            tagClassname.push("tag-warning");
            break;
        case "safe":
            iconLeft = <ShieldCheckIcon />;
            tagClassname.push("tag-safe");
            break;
        case "success":
            iconLeft = <CheckIcon />;
            tagClassname.push("tag-success");
            break;
        case "error":
            iconLeft = <CloseIcon />
            tagClassname.push("tag-error");
            break;
        case "info":
            iconLeft = <Info weight='duotone' className='w-5 h-5' />;
            tagClassname.push("tag-info");
            break;
        case "help":
            iconLeft = <QuestionMarkCircleIcon />;
            tagClassname.push("tag-help");
            break;
        case "wallet":
            iconLeft = <WalletIcon className='w-5 h-5' />;
            tagClassname.push("tag-wallet");
            break;
        case "live":
            iconLeft = <SignalIcon className='w-5 h-5' />;
            tagClassname.push("tag-live");
            break;
        case "new":
            iconLeft = undefined;
            tagClassname.push("tag-new");
            break;
        case 'tag':
            tagClassname.push("tag-tag");
            break;
        case 'tag-active':
            tagClassname.push("tag-tag active");
            break;
        default:
            iconRight = <CloseFilledIcon />;
            tagClassname.push("tag-default");
            break;
    }

    if (largeFont) tagClassname.push('largeTag');
    if (!!tooltipContent) tagClassname.push('cursor-pointer');

    const content = (
        <div className={tagClassname.join(" ").trim()} onClick={onClick}>
            {!!iconLeft && <div className='tagIconLeft flex'>{iconLeft}</div>}
            {label && <span className='tagLabel'>{label}</span>}
            {!!iconRight && <div className='tagIconRight flex'>{iconRight}</div>}
        </div>
    )

    if (!!tooltipContent) {
        return (
            <Tooltip
                triggerContent={content}
                placement={tooltipPlacement || "top"}
                offset={8}
                tooltipContent={tooltipContent}
                triggerClassName="tag-tooltip-trigger"
            />
        )
    }

    return content;
}

export const TagIcon: React.FC<{ tag: PredefinedTag }> = (props) => {
    const { tag } = props;
    return (tag.icon && !tag.externalIcon)
        ? <span className="text-base cg-text-main">{tag.icon}</span>
        : (!!tag.externalIcon ? <ExternalIcon type={tag.externalIcon as ExternalIconType} className="cg-text-secondary w-5 h-5" /> : null)
}

export default React.memo(Tag);
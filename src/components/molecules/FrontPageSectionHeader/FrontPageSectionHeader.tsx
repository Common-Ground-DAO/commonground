// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import { useWindowSizeContext } from "../../../context/WindowSizeProvider";
import { useNavigate } from "react-router-dom";

import './FrontPageSectionHeader.css';
type Props = {
    sectionTitle: React.JSX.Element;
    dedicatedBrowserUrl?: string;
    leftContent?: React.JSX.Element;
    rightContent?: React.JSX.Element | undefined;
    buttonsClassName?: string;
    useLargeHeader?: boolean;
}

export default function FrontPageSectionHeader(props: Props) {
    const { isMobile } = useWindowSizeContext();
    const navigate = useNavigate();
    const { sectionTitle, dedicatedBrowserUrl, leftContent, rightContent, useLargeHeader } = props;

    const titleClassName = [
        "front-page-section-title",
        useLargeHeader ? 'cg-heading-1' : 'cg-heading-2'
    ].join(' ');

    return (
        <div className='front-page-section-header'>
            <div className={titleClassName}>
                {sectionTitle}
            </div>
            {(leftContent || rightContent) && (
                <div className={`btnList front-page-section-scrollable-buttons ${props.buttonsClassName || ''}`}>
                    {isMobile && <div />}
                    {leftContent}
                    {rightContent && <div className="ml-auto px-4" onClick={() => dedicatedBrowserUrl && navigate(dedicatedBrowserUrl)}>{rightContent}</div>}
                </div>
            )}
        </div>
    )
}
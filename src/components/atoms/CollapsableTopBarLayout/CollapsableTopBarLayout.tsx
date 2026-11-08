// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useRef } from "react";

import './CollapsableTopBarLayout.css';

type Props = {
    topPart: React.JSX.Element;
    bottomPart: React.JSX.Element;
    isTopVisible: boolean;
}

const CollapsableTopBarLayout: React.FC<Props> = (props) => {
    const headerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    
    // setTimeout so refs have time to load on the first load 
    setTimeout(() => {
        const paddingTop = headerRef.current?.clientHeight || 100;
        const content = contentRef.current;
        if (content) {
            const el = content.querySelector('.cg-scrollable-content') as HTMLElement;
            if (el) {
                el.style.paddingTop = `${paddingTop}px`;
            }
        }
    }, 1);

    return <div className={`collapsable-top-bar-layout${props.isTopVisible ? ' with-top-bar' : ''}`}>
        <div ref={headerRef} className="collapsable-top-bar-layout-top">
            {props.topPart}
        </div>
        <div ref={contentRef} className="collapsable-top-bar-layout-bottom">
            {props.bottomPart}
        </div>
    </div>
};

export default React.memo(CollapsableTopBarLayout);
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import "./ArticleView.css";
import React, { useCallback, useRef, useState } from "react";
import { useParams } from "react-router-dom";

import { useLoadedCommunityContext } from "../../context/CommunityProvider";
import { useWindowSizeContext } from "../../context/WindowSizeProvider";

import { useMobileLayoutContext } from "../../views/Layout/MobileLayout";

import Article from "../../components/organisms/Article/Article";
import Scrollable, { PositionData } from "../../components/molecules/Scrollable/Scrollable";

import { createTranslator } from "short-uuid";

export const shortUuidRegex = /.*([a-zA-Z0-9]{22})$/;
const t = createTranslator();

type Props = {

}

const MIN_SCROLL_UP_DELTA = 20;
const MIN_SCROLL_DOWN_DELTA = 100;
const MAX_SCROLL_DELTA = 200; // For huge avoid updating on huge rerenders

export default function ArticleView(props: Props) {
    const { articleUri } = useParams<'articleUri'>();
    const articleIdShort = articleUri?.match(shortUuidRegex)?.[1];
    if (!articleIdShort) {
        throw new Error("Article uri invalid");
    }
    const articleId = t.toUUID(articleIdShort);
    const { community, communityPermissions } = useLoadedCommunityContext();
    const { isMobile } = useWindowSizeContext();
    const { setMenuHidden } = useMobileLayoutContext();
    const [isHeaderHidden, setHeaderHidden] = useState(false);

    const lastStableScrollY = useRef<number>(0);

    const positionCallback = useCallback((data: PositionData) => {
        const lastY = lastStableScrollY.current;
        const currDiff = lastY - data.scrollTop;

        const scrolledMinUp = MIN_SCROLL_UP_DELTA < currDiff;
        const scrolledMinDown = MIN_SCROLL_DOWN_DELTA < currDiff * -1;

        if (scrolledMinUp || scrolledMinDown) {
            // Only callback if there was a feasible change
            if (Math.abs(currDiff) <= MAX_SCROLL_DELTA) {
                if (currDiff > 0) {
                    setMenuHidden(false);
                    setHeaderHidden(false);
                } else if (currDiff < 0) {
                    setMenuHidden(true);
                    setHeaderHidden(true);
                }
            }
            // Always update lastScroll in steps
            lastStableScrollY.current = data.scrollTop;
        }
    }, [setMenuHidden]);

    const maincontent = React.useMemo(() => (
        <Scrollable innerClassName="article-view-scrollable" positionCallback={positionCallback}>
            <div className="article-view-inner">
                {<Article articleId={articleId} communityId={community.id} />}
            </div>
        </Scrollable>
    ), [articleId, community.id, positionCallback]);

    
    return (<div className="article-view">
        {maincontent}
    </div>);

    // return <CommunityRolesProvider myRole={myRole} community={community || {} as any}>
    //     {getContent()}
    // </CommunityRolesProvider>;
}
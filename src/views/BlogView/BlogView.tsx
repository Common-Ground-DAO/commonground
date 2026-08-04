// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import "./BlogView.css";
import { useRef, useCallback } from 'react';
import { useParams } from "react-router-dom";

import { useWindowSizeContext } from "../../context/WindowSizeProvider";
import { useMobileLayoutContext } from "../../views/Layout/MobileLayout";

import Blog from "../../components/organisms/Blog/Blog";
import Scrollable, { PositionData } from "../../components/molecules/Scrollable/Scrollable";
import UserProfileDetails from "../../components/organisms/UserProfileDetails/UserProfileDetails";
import { useLoadedProfileContext } from 'context/ProfileProvider';
import { shortUuidRegex } from 'views/ArticleView/ArticleView';
import { createTranslator } from "short-uuid";

const t = createTranslator();

export default function BlogView() {
    const { articleUri } = useParams<'articleUri'>();
    const articleIdShort = articleUri?.match(shortUuidRegex)?.[1];
    if (!articleIdShort) {
        throw new Error("Article uri invalid");
    }
    
    const articleId = t.toUUID(articleIdShort);
    const { isMobile } = useWindowSizeContext();
    const { setMenuHidden } = useMobileLayoutContext();
    const { user } = useLoadedProfileContext();
    const scrollY = useRef<number>(0);

    const positionCallback = useCallback((data: PositionData) => {
        if (data.scrollTop > 0 && !data.isBottom) {
            if (scrollY.current > data.scrollTop) {
                setMenuHidden(false);
            } else if (scrollY.current < data.scrollTop) {
                setMenuHidden(true);
            }
        }
        scrollY.current = data.scrollTop;
    }, [scrollY, setMenuHidden]);

    if (isMobile) {
        return (
            <div className="blog-view">
                <Scrollable positionCallback={positionCallback}>
                    <div className="blog-view-inner">
                        {!!articleId && <Blog articleId={articleId} userId={user.id} />}
                    </div>
                </Scrollable>
            </div>
        );
    } else {
        return (
            <div className="blog-view">
                <Scrollable>
                    <div className="blog-view-inner">
                        {!!articleId && <Blog articleId={articleId} userId={user.id} />}
                    </div>
                </Scrollable>
            </div>
        );
    }
}
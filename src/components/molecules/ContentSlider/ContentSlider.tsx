// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import { useMemo } from "react";
import { useWindowSizeContext } from "../../../context/WindowSizeProvider";

import Button from "../../../components/atoms/Button/Button";
import CommunityContentSkeletonCard from "../CommunityContentSkeletonCard/CommunityContentSkeletonCard";
import ArticleCardV2 from "../ArticleCardV2/ArticleCardV2";

import "./ContentSlider.css";

type Props = {
    sliderTitle?: 'Announcements' | 'Articles' | 'Governance' | 'Rules' | 'Drafts' | 'Posts';
    items: API.User.getArticleList.Response | API.Community.getArticleList.Response;
    cardCountLimit?: number;
    loadingAmount?: number;
    viewAllText?: string;
    onViewAllClick?: () => void;
    emptyState?: React.JSX.Element;
    isLoading?: boolean;

    hideAuthors?: boolean;
}

const DESKTOP_ROW_COUNT = 2;
const MOBILE_ROW_COUNT = 1;

export default function ContentSlider(props: Props) {
    const { isMobile } = useWindowSizeContext();
    const { sliderTitle, items, cardCountLimit, loadingAmount, viewAllText, onViewAllClick, hideAuthors, isLoading } = props;
    const itemsPerRow = isMobile ? MOBILE_ROW_COUNT : DESKTOP_ROW_COUNT;
    const showMoreButton = cardCountLimit !== undefined && items.length > cardCountLimit;

    const calculatedLoadingAmount = useMemo(() => {
        if (!loadingAmount && !cardCountLimit) {
            return 3;
        }
        if (!loadingAmount && !!cardCountLimit) {
            return cardCountLimit;
        }
        if (!!loadingAmount && !!cardCountLimit && loadingAmount > cardCountLimit) {
            return cardCountLimit;
        }
        return loadingAmount;
    }, [loadingAmount, cardCountLimit]);

    const filteredItems = useMemo(() => {
        if (cardCountLimit) {
            return items.slice(0, cardCountLimit);
        } else {
            return items;
        }
    }, [items, cardCountLimit]);

    const header = (
        <>
            {sliderTitle && <div className="slider-topbar">
                {sliderTitle}
            </div>}
        </>
    );

    const content = useMemo(() => {
        if (!isLoading && filteredItems.length === 0 && props.emptyState) return props.emptyState;

        const getContentItem = (item: API.User.getArticleList.Response[0] | API.Community.getArticleList.Response[0]): React.JSX.Element => {
            return <div className="flex flex-col gap-4" key={item.article.articleId}>
                <ArticleCardV2
                    article={item}
                    hideAuthor={hideAuthors}
                />
                <div className='cg-separator' key={`${item.article.articleId}-separator`} />
            </div>
        };

        const cardsContainerClassname = [
            'cards-container',
        ].join(' ').trim();

        let content = (
            <div className={cardsContainerClassname}>
                {filteredItems.map(getContentItem)}
                {showMoreButton && onViewAllClick && <div className="read-more-container" key='read-more'>
                    <Button
                        key='readMoreButton'
                        role='secondary'
                        text={viewAllText || 'Read more'}
                        onClick={onViewAllClick}
                    />
                </div>}
                {isLoading && filteredItems.length === 0 && Array.from(Array(calculatedLoadingAmount).keys()).map(index => <CommunityContentSkeletonCard featured={index < itemsPerRow} key={`community-content-skeleton-card-${index}`} />)}
            </div>
        );

        return content;
    }, [
        isLoading,
        props.emptyState,
        hideAuthors,
        calculatedLoadingAmount,
        itemsPerRow,
        onViewAllClick,
        viewAllText,
        showMoreButton,
        filteredItems
    ]);

    return (
        <div className={"content-slider content-slider-home"}>
            {header}
            {content}
        </div>
    );
}
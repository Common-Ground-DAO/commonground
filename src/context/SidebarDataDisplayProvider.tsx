// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useState } from "react";
import { Props } from "components/organisms/UserProfileModal/UserProfileModal";
import BottomSliderModal from "components/atoms/BottomSliderModal/BottomSliderModal";
import { useLocation } from "react-router-dom";
import { useWindowSizeContext } from "./WindowSizeProvider";
import SidebarContainer from "components/atoms/SidebarContainer/SidebarContainer";
import UserProfileInner from "components/organisms/UserProfile/UserProfileInner/UserProfileInner";
import Article from "components/organisms/Article/Article";
import Event from "views/EventView/Event";
import Blog from "components/organisms/Blog/Blog";
type SidebarContentProps = ({
  type: 'user';
} & Props) | {
  type: 'article';
  articleId: string;
  communityId: string;
} | {
  type: 'user-article';
  articleId: string;
  userId: string;
} | {
  type: 'event';
  eventId: string;
  communityId: string;
};

type SidebarDataDisplayState = {
  showTooltip: (data: SidebarContentProps) => void;
  closeSlider: () => void;
  currentData: SidebarContentProps | undefined;
}

export const SidebarDataDisplayContext = React.createContext<SidebarDataDisplayState>({
  showTooltip: () => { },
  closeSlider: () => { },
  currentData: undefined,
});

export function SidebarDataDisplayProvider(props: React.PropsWithChildren<{}>) {
  const { isMobile } = useWindowSizeContext();
  const [dataStack, setDataStack] = useState<SidebarContentProps[]>([{ type: 'user', userId: '', showDeleteButton: false }]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [trayLockedOpen, setTrayLockedOpen] = useState(false);
  const { pathname } = useLocation();

  const showTooltip = useCallback((data: SidebarContentProps) => {
    const newFinalIndex = Math.max(currentIndex + 1, 0);
    setDataStack(oldDataStack => [...oldDataStack.slice(0, newFinalIndex), data]);

    setTimeout(() => {
      setCurrentIndex(newFinalIndex);
    }, 1);
  }, [currentIndex]);

  const popDataStack = useCallback(() => {
    setCurrentIndex(oldIndex => oldIndex - 1);
  }, []);

  const closeSlider = useCallback(() => {
    setCurrentIndex(-1);
  }, []);

  const renderItemAtIndex = useCallback((item: SidebarContentProps) => {
    if (item.type === 'user') {
      return <UserProfileInner
        key={item.userId}
        trayMode
        closeTray={closeSlider}
        lockTray={setTrayLockedOpen}
        goBack={popDataStack}
        {...item}
      />
    } else if (item.type === 'article') {
      return <Article
        key={item.articleId}
        articleId={item.articleId}
        communityId={item.communityId}
        goBack={popDataStack}
        sidebarMode
      />;
    } else if (item.type === 'user-article') {
      return <Blog
        key={item.articleId}
        articleId={item.articleId}
        userId={item.userId}
        goBack={popDataStack}
        sidebarMode
      />;
    } else if (item.type === 'event') {
      return <Event
        key={item.eventId}
        eventId={item.eventId}
        communityId={item.communityId}
        goBack={popDataStack}
        sidebarMode
      />;
    }
  }, [closeSlider, popDataStack]);

  useEffect(() => {
    // Close slider when navigating to a new page
    closeSlider();
  }, [closeSlider, pathname]);

  return (
    <SidebarDataDisplayContext.Provider value={{ showTooltip, closeSlider, currentData: dataStack[currentIndex] }}>
      {props.children}
      {isMobile ? (<>
        {dataStack.map((item, index) =>
          <BottomSliderModal
            key={index}
            isOpen={currentIndex === index}
            onClose={closeSlider}
            noDefaultScrollable
            floatingMode={false}
          >
            {renderItemAtIndex(item)}
          </BottomSliderModal>
        )}
      </>) : (<>
        {dataStack.map((item, index) =>
          <SidebarContainer
            key={index}
            isOpen={currentIndex === index}
            onClose={!trayLockedOpen ? closeSlider : () => { }}
          >
            {renderItemAtIndex(item)}
          </SidebarContainer>
        )}
      </>)}
    </SidebarDataDisplayContext.Provider>
  )
}

export function useSidebarDataDisplayContext() {
  const context = React.useContext(SidebarDataDisplayContext);
  return context;
}
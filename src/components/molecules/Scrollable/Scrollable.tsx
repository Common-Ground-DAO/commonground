// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import "./Scrollable.css";

export type PositionData = {
  scrollTop: number;
  visibleHeight: number;
  contentHeight: number;
  isTop: boolean;
  isBottom: boolean;
};

type ScrollLockType = 'expandingTop' | 'expandingBottom' | 'lockByVisibleItemDate' | 'scrollToItemDate' | 'scrollToElementId' | 'scrollToBottom' | 'scrollToTop';

export type ScrollLockOptions = {
  type: ScrollLockType;
} & ({
  type: 'expandingTop' | 'expandingBottom' | 'scrollToBottom' | 'scrollToTop';
} | {
  type: 'lockByVisibleItemDate';
  elementClassWithTimestamp: string;
  dateOrder: 'ASC' | 'DESC';
} | {
  type: 'scrollToItemDate';
  elementClassWithTimestamp: string;
  targetDate: string;
  dateOrder: 'ASC' | 'DESC';
} | {
  type: 'scrollToElementId';
  elementId: string;
});

export type ScrollableHandle = {
  scrollToTop: () => void;
  scrollToBottom: () => void;
  scrollToElementId: (elementId: string) => void;
  lockScrollForNextUpdate: (options: ScrollLockOptions) => void;
  forceUpdate: () => void;
  contentRef: React.RefObject<HTMLDivElement | null>;
};

type ScrollableProps = React.PropsWithChildren<{
  className?: string;
  innerClassName?: string;
  bodyColor?: string;
  handleColor?: string;
  hideOnNoScroll?: boolean;
  hideOnNoScrollDelay?: number;
  defaultWidth?: number;
  proximityWidth?: number;
  proximityThreshold?: number;
  transitionDuration?: string;
  autoScroll?: boolean;
  topAndBottomThreshold?: number;
  positionCallback?: (data: PositionData) => void;
  innerId?: string;
  rootDivRef?: React.RefObject<HTMLDivElement | null>;
  alwaysVisible?: boolean;
}>;

const Scrollable: React.ForwardRefRenderFunction<ScrollableHandle, ScrollableProps> = (props, thisRef) => {
  const {
    children,
    className,
    innerClassName,
    hideOnNoScrollDelay,
    positionCallback,
    innerId,
    rootDivRef,
    alwaysVisible
  } = props;
  const defaultWidthPx = props.defaultWidth !== undefined ? props.defaultWidth : 4;
  const defaultWidth = `${defaultWidthPx}px`;
  const proximityWidthPx = props.proximityWidth !== undefined ? props.proximityWidth : 7;
  const proximityWidth = `${proximityWidthPx}px`;
  const proximityThreshold = props.proximityThreshold !== undefined ? props.proximityThreshold : 20;
  const topAndBottomThreshold = props.topAndBottomThreshold !== undefined ? props.topAndBottomThreshold : 20;
  const bodyColor = props.bodyColor || "rgba(165, 165, 165, 0)";
  const handleColor = props.handleColor || "#929292";
  const transitionDuration = props.transitionDuration || "0.1s";
  const hideOnNoScroll = props.hideOnNoScroll !== undefined ? props.hideOnNoScroll : true;
  const autoScroll = props.autoScroll !== undefined ? props.autoScroll : false;

  // element refs
  const _outerRef = useRef<HTMLDivElement>(null);
  const outerRef = rootDivRef || _outerRef;
  const contentRef = useRef<HTMLDivElement>(null);
  const barBodyRef = useRef<HTMLDivElement>(null);
  const barHandleRef = useRef<HTMLDivElement>(null);

  // status refs
  const mutationOccurredRef = useRef<boolean>(false);
  const scrollOccurredRef = useRef<boolean>(false);
  const resizeOccurredRef = useRef<boolean>(true);
  const proximityOccurredRef = useRef<boolean>(false);
  const mouseOccurredRef = useRef<boolean>(false);

  const visibleRef = useRef<boolean>(!hideOnNoScroll);
  const hideTimeoutRef = useRef<any>(undefined);
  const barRectRef = useRef<{ top: number, left: number, width: number, height: number }>(undefined);
  const proximityRef = useRef<boolean>(false);
  const grabbedRef = useRef<boolean>(false);
  const grabbedReleasedRef = useRef<boolean>(false);
  const resetHideTimeoutRef = useRef<boolean>(false);
  const previousYRef = useRef<number>(undefined);
  const nextYRef = useRef<number>(undefined);
  const lastKnownContentHeightRef = useRef<number>(0);
  const lastKnownScrollTopRef = useRef<number>(0);
  const nextMutationScrollLockedRef = useRef<ScrollLockOptions | undefined>(undefined);
  const scrollIsAtBottomRef = useRef<boolean>(true);
  const executeAutoScrollRef = useRef<boolean>(autoScroll);
  const dateLockScrollRef = useRef<{ timestamp: string, top: number, element: HTMLElement } | undefined>(undefined);
  const updateBarFnRef = useRef<(time: number) => void>(undefined);
  const animationFrameScheduledRef = useRef<boolean>(false);
  const preventScrollRef = useRef<boolean>(false);
  const mountedRef = useRef<boolean>(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const barBodyStyle = useMemo<React.CSSProperties>(() => ({
    backgroundColor: bodyColor,
    transition: `width ${transitionDuration}, background-color ${transitionDuration}`
  }), [bodyColor, transitionDuration]);

  const barHandleStyle = useMemo<React.CSSProperties>(() => ({
    backgroundColor: handleColor,
    transition: `top 0.1s, background-color ${transitionDuration}`
  }), [handleColor, transitionDuration]);

  const grabbedOverlay = useMemo(() => document.getElementById("cg-scrollable-grabbed-overlay") as HTMLDivElement, []);

  const updateBarLayout = useCallback(() => {
    if (!mountedRef.current) return;
    if (!(animationFrameScheduledRef.current === true) && updateBarFnRef.current !== undefined) {
      animationFrameScheduledRef.current = true;
      requestAnimationFrame(updateBarFnRef.current);
    }
  }, []);

  const mouseUpListener = useCallback((ev: MouseEvent) => {
    document.body.removeEventListener("mouseup", mouseUpListener);
    const content = contentRef.current;
    if (content && content.style.getPropertyValue("user-select") === "none") {
      console.log("Scrollable: removing user select inline style");
      content.style.removeProperty("user-select");
      content.style.removeProperty("-webkit-user-drag");
    }
    if (grabbedReleasedRef.current !== true && grabbedRef.current === true) {
      grabbedReleasedRef.current = true;
      mouseOccurredRef.current = true;
      updateBarLayout();
    }
  }, []); // updateBarLayout never changes

  // release all and hide completely on mouseleve on document
  useEffect(() => {
    const mouseLeaveListener = (ev: MouseEvent) => {
      document.body.removeEventListener("mouseup", mouseUpListener);
      const content = contentRef.current;
      if (content && content.style.getPropertyValue("user-select") === "none") {
        console.log("Scrollable: removing user select inline style");
        content.style.removeProperty("user-select");
        content.style.removeProperty("-webkit-user-drag");
      }
      if (hideOnNoScroll === true) {
        visibleRef.current = false;
      }
      proximityRef.current = false;
      grabbedReleasedRef.current = true; // Todo: this can be annoying when dragging and leaving the window
      mouseOccurredRef.current = true;
      updateBarLayout();
    }
    document.body.addEventListener("mouseleave", mouseLeaveListener);
    return () => {
      document.body.removeEventListener("mouseleave", mouseLeaveListener);
    }
  }, [hideOnNoScroll, updateBarLayout]);

  const setPreventScroll = useCallback((value: boolean) => {
    preventScrollRef.current = value;
    const content = contentRef.current;
    if (content) {
      if (value) {
        content.style.overflowY = 'hidden';
      }
      else {
        content.style.overflowY = 'scroll';
      }
    }
  }, []);


  const scrollToTop = useCallback(() => {
    const content = contentRef.current;
    if (content) {
      content.scrollTo({
        top: 0,
        behavior: "smooth"
      });
      updateBarLayout();
    }
  }, [updateBarLayout]);

  const scrollToBottom = useCallback(() => {
    const outer = outerRef.current;
    const content = contentRef.current;
    if (outer && content) {
      content.scrollTo({
        top: Math.max(0, content.scrollHeight - outer.clientHeight),
        behavior: "smooth"
      });
      updateBarLayout();
    }
  }, [updateBarLayout]);

  const getElementVerticalData = useCallback((elementOrId: HTMLElement | string) => {
    let element: HTMLElement | null = null;
    if (typeof elementOrId === 'string') {
      element = document.getElementById(elementOrId);
    }
    else {
      element = elementOrId;
    }
    const content = contentRef.current;
    if (element && content?.contains(element)) {
      let currEl = element;
      let topTmp = currEl.offsetTop;
      while (currEl.offsetParent !== content && currEl.offsetParent !== null && content.contains(currEl.offsetParent)) {
        currEl = currEl.offsetParent as HTMLElement;
        topTmp += currEl.offsetTop;
      }
      return {
        top: topTmp,
        height: element.clientHeight
      };
    }
    else {
      return undefined;
    }
  }, []);

  const scrollToElementId = useCallback((elementId: string) => {
    const verticalData = getElementVerticalData(elementId);
    const outer = outerRef.current;
    const content = contentRef.current;
    if (outer && content && verticalData !== undefined) {
      const newScrollTop = Math.round(verticalData.top - (outer.clientHeight / 2) + (verticalData.height / 2));
      content.scrollTo({
        top: newScrollTop,
        behavior: "smooth",
      });
    }
  }, [updateBarLayout, getElementVerticalData]);

  const byDateLock = useCallback((elementClassWithTimestamp: string) => {
    const content = contentRef.current;
    if (content) {
      const children = content.getElementsByClassName(elementClassWithTimestamp) as HTMLCollectionOf<HTMLElement>;
      const elements = Array.from(children);
      for (const element of elements) {
        const rect = element.getBoundingClientRect();
        if (rect.top >= 0 && rect.bottom <= window.innerHeight) {
          const timestamp = element.dataset["timestamp"];
          if (!timestamp) {
            console.warn("Scrollable byDateLock: No timestamp found on element");
          }
          else {
            const verticalData = getElementVerticalData(element);
            if (verticalData) {
              if (dateLockScrollRef.current) {
                dateLockScrollRef.current.element = element;
                dateLockScrollRef.current.timestamp = timestamp;
                dateLockScrollRef.current.top = verticalData.top - content.scrollTop;
              }
              else {
                dateLockScrollRef.current = { timestamp, top: verticalData.top - content.scrollTop, element };
              }
              break;
            }
          }
        }
      }
      if (!dateLockScrollRef.current) {
        console.error("Could not find visible element with timestamp for scroll lock");
      }
    }
  }, []);
  
  const lockScrollForNextUpdate = useCallback((options: ScrollLockOptions) => {
    nextMutationScrollLockedRef.current = options;
    setPreventScroll(true);
    if (options.type === "lockByVisibleItemDate") {
      byDateLock(options.elementClassWithTimestamp);
    }
  }, [byDateLock, setPreventScroll]);

  const forceUpdate = useCallback(() => {
    resizeOccurredRef.current = true;
    updateBarLayout();
  }, [updateBarLayout]);

  useImperativeHandle(thisRef, () => ({
    scrollToTop,
    scrollToBottom,
    scrollToElementId,
    lockScrollForNextUpdate,
    forceUpdate,
    contentRef
  }), [scrollToTop, scrollToBottom, scrollToElementId, lockScrollForNextUpdate, forceUpdate, contentRef]);

  const updateBarRectFn = useCallback(() => {
    const outer = outerRef.current;
    if (outer) {
      const outerRect = outer.getBoundingClientRect();
      barRectRef.current = {
        left: outerRect.left + outerRect.width - defaultWidthPx,
        top: outerRect.top,
        width: defaultWidthPx,
        height: outerRect.height,
      };
    }
  }, []);

  useEffect(() => {
    window.addEventListener("resize", updateBarRectFn);
    const outer = outerRef.current;
    const animationListenerRoot = document.getElementById("management-content-modal-root");
    if (animationListenerRoot && animationListenerRoot.contains(outer)) {
      animationListenerRoot.addEventListener("animationend", updateBarRectFn);
    }
    return () => {
      window.removeEventListener("resize", updateBarRectFn);
      if (animationListenerRoot && animationListenerRoot.contains(outer)) {
        animationListenerRoot.removeEventListener("animationend", updateBarRectFn);
      }
    }
  }, []);

  useEffect(() => {
    updateBarFnRef.current = (time: number) => {
      animationFrameScheduledRef.current = false;

      // element refs
      const outer = outerRef.current;
      const barBody = barBodyRef.current;
      const barHandle = barHandleRef.current;
      const content = contentRef.current;

      // status refs
      const resizeOccurred = resizeOccurredRef.current;
      const mouseOccurred = mouseOccurredRef.current;
      const mutationOccurred = mutationOccurredRef.current;
      const scrollOccurred = scrollOccurredRef.current;
      const proximityOccurred = proximityOccurredRef.current;

      const visible = visibleRef.current;
      const proximity = proximityRef.current;
      const grabbed = grabbedRef.current;
      const grabbedReleased = grabbedReleasedRef.current;
      const previousY = previousYRef.current;
      const nextY = nextYRef.current;
      const executeAutoScroll = executeAutoScrollRef.current;
      const scrollIsAtBottom = scrollIsAtBottomRef.current;

      if (outer && barBody && barHandle && content) {
        const outerHeight = outer.clientHeight;
        const contentHeight = content.scrollHeight;

        // resize handle
        if (resizeOccurred) {
          updateBarRectFn();
        }

        // general handle
        if (resizeOccurred || mouseOccurred || scrollOccurred || mutationOccurred || proximityOccurred) {
          barBody.style.height = `${outer.clientHeight}px`;
          const __handleHeight = outerHeight * (outerHeight / contentHeight);
          const handleHeightPx = Math.max(Math.round(__handleHeight), 15);

          // scroll if necessary
          let contentTop = content.scrollTop;
          if (nextMutationScrollLockedRef.current && mutationOccurred === true) {
            // Set correct next top position
            if (nextMutationScrollLockedRef.current.type === 'expandingTop') {
              contentTop = Math.min(contentHeight - outerHeight, Math.max(0, contentTop + contentHeight - lastKnownContentHeightRef.current));
            }
            else if (nextMutationScrollLockedRef.current.type === 'expandingBottom') {
              if (executeAutoScroll && scrollIsAtBottom) {
                contentTop = contentHeight - outerHeight;
              }
              else {
                contentTop = lastKnownScrollTopRef.current;
              }
            }
            else if (nextMutationScrollLockedRef.current.type === 'scrollToBottom') {
              contentTop = contentHeight - outerHeight;
            }
            else if (nextMutationScrollLockedRef.current.type === 'scrollToTop') {
              contentTop = 0;
            }
            else if (nextMutationScrollLockedRef.current.type === 'lockByVisibleItemDate') {
              const { elementClassWithTimestamp, dateOrder } = nextMutationScrollLockedRef.current;

              const dateLockData = dateLockScrollRef.current;
              let handled = false;
              if (elementClassWithTimestamp && dateLockData) {
                const children = content.getElementsByClassName(elementClassWithTimestamp) as HTMLCollectionOf<HTMLElement>;
                const elements = Array.from(children);
                for (const element of elements) {
                  const timestamp = element.dataset["timestamp"];
                  if (!timestamp) {
                    console.warn("Scrollable updateFn: No timestamp found on element");
                  }
                  else if (
                    (dateOrder === 'ASC' && timestamp >= dateLockData.timestamp) ||
                    (dateOrder === 'DESC' && timestamp <= dateLockData.timestamp)
                   ) {
                    // this is the matching element
                    const verticalData = getElementVerticalData(element);
                    if (verticalData) {
                      contentTop = verticalData.top - dateLockData.top;
                      handled = true;
                    }
                    break;
                  }
                }
                if (!handled) {
                  // scroll to bottom
                  contentTop = contentHeight - outerHeight;
                }
                dateLockScrollRef.current = undefined;
              }
            }
            else if (nextMutationScrollLockedRef.current.type === 'scrollToItemDate') {
              const { elementClassWithTimestamp, dateOrder, targetDate } = nextMutationScrollLockedRef.current;
              let handled = false;
              if (elementClassWithTimestamp && targetDate) {
                const children = content.getElementsByClassName(elementClassWithTimestamp) as HTMLCollectionOf<HTMLElement>;
                const elements = Array.from(children);
                for (const element of elements) {
                  const timestamp = element.dataset["timestamp"];
                  if (!timestamp) {
                    console.warn("Scrollable updateFn: No timestamp found on element");
                  }
                  else if (
                    (dateOrder === 'ASC' && timestamp >= targetDate) ||
                    (dateOrder === 'DESC' && timestamp <= targetDate)
                  ) {
                    // this is the matching element
                    const verticalData = getElementVerticalData(element);
                    if (verticalData) {
                      contentTop = verticalData.top - (outerHeight / 2) + (verticalData.height / 2);
                      handled = true;
                    }
                    break;
                  }
                }
              }
              if (!handled) {
                // scroll to bottom
                contentTop = contentHeight - outerHeight;
              }
            }
            else if (nextMutationScrollLockedRef.current.type === 'scrollToElementId') {
              let handled = false;
              const verticalData = getElementVerticalData(nextMutationScrollLockedRef.current.elementId);
              console.log("SCROLLTOITEMID", nextMutationScrollLockedRef.current.elementId)
              if (verticalData !== undefined) {
                contentTop = Math.round(verticalData.top - (outerHeight / 2) + (verticalData.height / 2));
                handled = true;
              }
              if (!handled) {
                // scroll to bottom
                contentTop = contentHeight - outerHeight;
              }
            }

            nextMutationScrollLockedRef.current = undefined;
            setPreventScroll(true);
            content.scrollTo({
              top: contentTop,
              behavior: "instant" as any
            });
          } else if (grabbed === true && grabbedReleased === false && previousY !== undefined && nextY !== undefined) {
            if (previousY !== nextY) {
              const scrollTopDelta = ((nextY - previousY) / __handleHeight) * outerHeight;
              contentTop = Math.min(contentHeight - outerHeight, Math.max(0, content.scrollTop + Math.round(scrollTopDelta)));
              setPreventScroll(true);
              content.scrollTo({
                top: contentTop,
                behavior: "instant" as any
              });
              previousYRef.current = nextY;
            }
          } else if (executeAutoScroll) {
            executeAutoScrollRef.current = false;
            if (scrollIsAtBottom) {
              contentTop = contentHeight - outerHeight;
              setPreventScroll(true);
              content.scrollTo({
                top: contentTop,
                behavior: "instant" as any
              });
            }
          }

          lastKnownScrollTopRef.current = contentTop;
          lastKnownContentHeightRef.current = contentHeight;
          const handleTopPx = Math.floor((contentTop / (contentHeight - outerHeight)) * (outerHeight - handleHeightPx));
          scrollIsAtBottomRef.current = contentTop + outerHeight > contentHeight - topAndBottomThreshold;
          if (positionCallback) {
            const positionData = {
              scrollTop: contentTop,
              visibleHeight: outerHeight,
              contentHeight,
              isTop: contentTop < topAndBottomThreshold,
              isBottom: scrollIsAtBottomRef.current
            };
            setTimeout(() => {
              positionCallback(positionData)
            }, 0);
          }

          const handleHeight = `${handleHeightPx}px`
          if (barHandle.style.height !== handleHeight) {
            barHandle.style.height = handleHeight;
          }
          const handleTop = `${handleTopPx}px`;
          if (barHandle.style.top !== handleTop) {
            barHandle.style.top = handleTop;
          }
        }

        // check width depending on status
        if (proximity) {
          if (barBody.style.width !== proximityWidth) {
            barBody.style.width = proximityWidth;
          }
        } else if (grabbed || visible || alwaysVisible) {
          if (barBody.style.width !== defaultWidth) {
            barBody.style.width = defaultWidth;
          }
        } else if (barBody.style.width !== "0px") {
          barBody.style.width = "0px";
        }

        // set hide timer
        const resetHideTimeout = resetHideTimeoutRef.current;
        if (hideOnNoScroll === true) {
          if (resetHideTimeout === true) {
            resetHideTimeoutRef.current = false;
            if (hideTimeoutRef.current) {
              clearTimeout(hideTimeoutRef.current);
              hideTimeoutRef.current = undefined;
            }
          }
          if (hideTimeoutRef.current === undefined && barBody.style.width !== "0px") {
            hideTimeoutRef.current = setTimeout(() => {
              visibleRef.current = false;
              hideTimeoutRef.current = undefined;
              updateBarLayout();
            }, hideOnNoScrollDelay || 0);
          }
        }

        // check if grab was released
        if (grabbedReleased === true) {
          grabbedRef.current = false;
          grabbedReleasedRef.current = false;
          grabbedOverlay.style.display = "none";
        }

        if (contentHeight > outerHeight) {
          // content is scrollable, show scrollbar
          if(barBody.style.display !== "block") {
            barBody.style.display = "block";
          }
        } else {
          // content is not scrollable, hide scrollbar
          if(barBody.style.display !== "none") {
            barBody.style.display = "none";
          }
        }

        resizeOccurredRef.current = false;
        mouseOccurredRef.current = false;
        mutationOccurredRef.current = false;
        scrollOccurredRef.current = false;
        proximityOccurredRef.current = false;
        if (preventScrollRef.current === true) {
          requestAnimationFrame(() => {
            setPreventScroll(false);
          });
        }
      }
    }
  }, [topAndBottomThreshold, defaultWidth, hideOnNoScroll, hideOnNoScrollDelay, proximityWidth, updateBarLayout, defaultWidthPx, positionCallback, getElementVerticalData]);

  // attach mutation observer and child element resize observer
  useEffect(() => {
    const content = contentRef.current;
    if (content) {
      // create resize listener and observer
      const resizeListener: ResizeObserverCallback = (entries) => {
        resizeOccurredRef.current = true;
        if (autoScroll && scrollIsAtBottomRef.current) {
          executeAutoScrollRef.current = true;
        }
        updateBarLayout();
      };
      const resizeObserver = new ResizeObserver(resizeListener);
      resizeObserver.observe(content);

      const updateResizeObserved = () => {
        const resizeObserverElements = Array.from(content.children) as HTMLElement[];
        for (const element of resizeObserverElements) {
          resizeObserver.observe(element);
        }
      }
      // initial setup
      updateResizeObserved();

      const mutationListener: MutationCallback = (mutations) => {
        mutationOccurredRef.current = true;
        executeAutoScrollRef.current = autoScroll;
        //console.log("mutated, recalculating");
        updateBarLayout();
        updateResizeObserved();
      };
      const contentObserver = new MutationObserver(mutationListener);
      contentObserver.observe(content, {
        childList: true,
        subtree: true,
      });
      return () => {
        contentObserver.disconnect();
        resizeObserver.disconnect();
      };
    }
  }, [autoScroll, updateBarLayout]);

  // attach mousemove handler
  useEffect(() => {
    const threshold = proximityThreshold || 0;
    const mouseListener = (ev: MouseEvent) => {
      const rect = barRectRef.current;
      if (rect && !preventScrollRef.current) {
        const newProximity = (
          ev.clientX >= rect.left - threshold &&
          ev.clientX <= rect.left + rect.width + threshold &&
          ev.clientY >= rect.top - threshold &&
          ev.clientY <= rect.top + rect.height + threshold
        );
        if (newProximity !== proximityRef.current) {
          proximityRef.current = newProximity;
          proximityOccurredRef.current = true;
          updateBarLayout();
        }
        if (grabbedRef.current === true) {
          // save coordinate and trigger recalculate
          nextYRef.current = ev.clientY;
          mouseOccurredRef.current = true;
          updateBarLayout();
        }
      }
    }
    document.body.addEventListener("mousemove", mouseListener);
    return () => {
      document.body.removeEventListener("mousemove", mouseListener);
    }
  }, [proximityThreshold, updateBarLayout]);

  // set up
  useEffect(() => {
    updateBarLayout();
    return () => {
      grabbedOverlay.style.display = "none";
      if (!!hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
    }
  }, [updateBarLayout, grabbedOverlay]);

  const scrollHandler = useMemo(() => (
    (ev: React.UIEvent<HTMLDivElement>) => {
      if (grabbedRef.current === false) {
        if (preventScrollRef.current === false) {
          scrollOccurredRef.current = true;
          visibleRef.current = true;
          resetHideTimeoutRef.current = true;
          //console.log("scrolled, recalculating");
          updateBarLayout();
        }
        else if (dateLockScrollRef.current) {
          const { element } = dateLockScrollRef.current;
          if (document.contains(element) === true) {
            const content = contentRef.current;
            const verticalData = getElementVerticalData(element);
            if (verticalData && content) {
              dateLockScrollRef.current.top = verticalData.top - content.scrollTop;
            }
          }
        }
      }
    }
  ), [updateBarLayout]);

  const grabHandler = useCallback((ev: React.MouseEvent<HTMLDivElement>) => {
    grabbedRef.current = true;
    previousYRef.current = ev.clientY;
    nextYRef.current = ev.clientY;
    if (hideOnNoScroll === true) {
      visibleRef.current = false;
    }
    mouseOccurredRef.current = true;
    const content = contentRef.current;
    if (content) {
      grabbedOverlay.style.display = "block";
      if (content.style.getPropertyValue("user-select") !== "none") {
        console.log("Scrollable: setting user select to none");
        content.style.setProperty("user-select", "none", "important");
        content.style.setProperty("-webkit-user-drag", "none", "important");
      }
    }
    updateBarLayout();
    (document.activeElement as HTMLElement | null)?.blur();
    window.getSelection?.()?.removeAllRanges();
    document.body.addEventListener("mouseup", mouseUpListener);
  }, [grabbedOverlay, hideOnNoScroll, updateBarLayout]);

  return (
    <div className={`cg-scrollable ${className ?? ''}`} ref={outerRef}>
      <div className={`cg-scrollable-content ${innerClassName ?? ''}`} id={innerId} ref={contentRef} onScroll={scrollHandler}>
        {children}
      </div>
      <div className="cg-scrollbar-body" ref={barBodyRef} style={barBodyStyle}>
        <div className="cg-scrollbar-handle" ref={barHandleRef} style={barHandleStyle} onMouseDown={grabHandler}/>
      </div>
    </div>
  );
};
export default React.forwardRef(Scrollable);
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect, useLayoutEffect } from 'react';

export function isElementOverlappingViewport(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const windowHeight = (window.innerHeight || document.documentElement.clientHeight);
  const windowWidth = (window.innerWidth || document.documentElement.clientWidth);

  // Check if any part of the element is within the viewport
  const isPartiallyVisible = (
    ((rect.top < windowHeight && rect.top > 0) || (rect.bottom < windowHeight && rect.bottom > 0)) &&
    ((rect.left < windowWidth && rect.left > 0) || (rect.right < windowWidth && rect.right > 0))
  );
  return isPartiallyVisible;
}


export function areElementsIntersecting(el1: HTMLElement, el2: HTMLElement, compareWithEqual = true): boolean {
  const rect1 = el1.getBoundingClientRect();
  const rect2 = el2.getBoundingClientRect();

  if (compareWithEqual) {
    return (
      ((rect1.top >= rect2.top && rect1.top <= rect2.bottom) ||
      (rect1.bottom >= rect2.top && rect1.bottom <= rect2.bottom))
      &&
      ((rect1.left >= rect2.left && rect1.left <= rect2.right) ||
      (rect1.right >= rect2.left && rect1.right <= rect2.right))
    );
  }
  else {
    return (
      ((rect1.top > rect2.top && rect1.top < rect2.bottom) ||
      (rect1.bottom > rect2.top && rect1.bottom < rect2.bottom))
      &&
      ((rect1.left > rect2.left && rect1.left < rect2.right) ||
      (rect1.right > rect2.left && rect1.right < rect2.right))
    );
  }
}


export default function useOnScreen(ref: React.RefObject<HTMLDivElement | null>, rootRef: React.RefObject<HTMLDivElement | null>, callback: () => void, triggerDelayedCheckDependencies: any[] = []) {
  const [observer, setObserver] = React.useState<IntersectionObserver | null>(null);
  const timeoutRef = React.useRef<any>(undefined);
  const intersectionTriggeredRef = React.useRef(false);
  const callbackRef: React.MutableRefObject<() => void> = React.useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          intersectionTriggeredRef.current = true;
          callbackRef.current();
        }
        else {
          intersectionTriggeredRef.current = false;
        }
      }, {
        root: rootRef.current,
        rootMargin: '0px',
        threshold: 0,
      },
    );
    setObserver(obs);
    return () => {
      obs.disconnect();
    }
  }, [rootRef.current]);

  useLayoutEffect(() => {
    const el = ref.current;
    const rootEl = rootRef.current;
    if (el && rootEl && observer) {
      observer.observe(el);
      return () => {
        observer.unobserve(el);
      };
    }
  }, [ref.current, rootRef.current, observer]);

  useEffect(() => {
    if (timeoutRef.current === undefined) {
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = undefined;
        const el = ref.current;
        const rootEl = rootRef.current;
        if (el && rootEl) {
          if (areElementsIntersecting(el, rootEl)) {
            intersectionTriggeredRef.current = true;
            callback();
          }
          else {
            intersectionTriggeredRef.current = false;
          }
        }
      }, 300);
    }
  }, triggerDelayedCheckDependencies);
}
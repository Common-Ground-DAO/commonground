// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import ReactDOM from "react-dom";
import {
  useFloating,
  useInteractions,
  useHover,
  shift,
  flip,
  Placement,
  useDelayGroup,
  useFloatingParentNodeId,
  FloatingTree,
  useClick,
  useDismiss,
  autoUpdate,
  HandleCloseContext
} from "@floating-ui/react";
import { motion, AnimatePresence } from "motion/react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { useGlobalDictionaryContext } from "../../../context/GlobalDictionaryProvider";
import { randomString } from "../../../util";

type Props = {
  placement: Placement;
  padding: number;
  triggerContent: string | JSX.Element;
  tooltipContent: string | JSX.Element;
  triggerClassName?: string;
  tooltipClassName?: string;
  openDelay?: number;
  closeDelay?: number;
  withDelayGroup?: boolean;
  delayGroupListId?: string;
  isMessageTooltip?: boolean;
  modalDescendantRef?: React.RefObject<HTMLDivElement>; // is using to prevent close popover when its modal descendant is alive
}

export type UserTooltipHandle = {
  open: () => void;
}

const UserProfilePopover = forwardRef<UserTooltipHandle, Props>((props, ref) => {
  const {
    placement,
    padding,
    triggerContent,
    tooltipContent,
    triggerClassName,
    tooltipClassName,
    openDelay,
    closeDelay,
    withDelayGroup,
    delayGroupListId,
    modalDescendantRef
  } = props;

  const [open, setOpen] = useState<boolean>(false);
  const { dict, setEntry } = useGlobalDictionaryContext();
  const parentId = useFloatingParentNodeId();
  const tooltipRoot = useMemo(() => document.getElementById("tooltip-root") as HTMLElement, []);
  const thisId = useMemo(() => randomString(), []);

  const onOpenChange = useCallback(
    (open: boolean) => {
      setOpen(open);
      // `useDelayGroup` publishes the group's `currentId` itself since
      // `@floating-ui/react` 0.27 (a layout effect on `open`); the old
      // `react-dom-interactions` hook did not, which is why this callback used
      // to call `setCurrentId` by hand.
      if (open === true) {
        setEntry('tooltip-user-tooltip', thisId);
      }
    }
    , [setEntry, thisId]);

  useEffect(() => {
    if (dict['tooltip-user-tooltip'] !== thisId) {
      setOpen(false);
    }
  }, [dict, thisId]);

  const { x, y, refs, strategy, context, isPositioned } = useFloating({
    placement,
    open,
    onOpenChange,
    middleware: [
      flip(),
      shift({ padding })
    ],
    // See the note in Tooltip.tsx: 0.27 requires the autoUpdate teardown to be
    // returned, and returning nothing leaked the `animationFrame` rAF loop.
    whileElementsMounted: (reference, floating, update) =>
      autoUpdate(reference, floating, update, {
        ancestorScroll: true,
        ancestorResize: true,
        elementResize: true,
        animationFrame: true
      })
  });

  // 0.27 turned `useDelayGroup` from an `useInteractions` entry into a hook
  // that returns the group context, replacing the deprecated
  // `useDelayGroupContext()`. It also publishes `currentId` itself, which the
  // old hook left to the caller — so `enabled` has to carry the `withDelayGroup`
  // gate that used to sit on the manual `setCurrentId` call, or a popover that
  // never opted into grouping would start claiming the group.
  const { delay } = useDelayGroup(context, { id: delayGroupListId, enabled: !!withDelayGroup });

  const { getReferenceProps, getFloatingProps } = useInteractions([
    useHover(context, {
      enabled: open,
      delay: openDelay !== undefined && closeDelay !== undefined ? {
        open: openDelay,
        close: closeDelay
      } : delay,
      handleClose: (() => {
        const fn = ({ onClose, refs }: HandleCloseContext) => (event: MouseEvent) => {
          const path = event.composedPath();
          const triggerEl = refs.reference.current;
          const floatEl = refs.floating.current;
          if (!(path.includes(triggerEl as any)) && !(path.includes(floatEl as any)) && !(path.includes(tooltipRoot)) && !modalDescendantRef?.current) {
            onClose();
          }
        };
        fn.__options = {
          blockPointerEvents: false
        }
        return fn;
      })()
    }),
    useClick(context, {
      enabled: true
    }),
    useDismiss(context, {
      enabled: true,
      outsidePressEvent: 'pointerdown'
    })
  ]);

  useImperativeHandle(ref, () => ({
    open: () => {
      onOpenChange(true);
    }
  }), [onOpenChange]);

  // `isPositioned` goes false again the moment `open` does, but AnimatePresence
  // keeps this element mounted through its exit animation — gating visibility on
  // `isPositioned` alone would hide the popover instantly instead of fading it
  // out. Latch it for the lifetime of one open cycle: hidden only before the
  // first placement.
  const [hasBeenPositioned, setHasBeenPositioned] = useState(false);
  useEffect(() => {
    if (isPositioned) setHasBeenPositioned(true);
    else if (open) setHasBeenPositioned(false);
  }, [isPositioned, open]);

  const floatingStyle: React.CSSProperties = useMemo(() => ({
    position: strategy,
    top: y,
    left: x,
    visibility: isPositioned || hasBeenPositioned ? "visible" : "hidden",
    zIndex: 600,
    boxSizing: "border-box",
    maxHeight: `calc(100vh - ${2 * padding}px)`,
    paddingLeft: `${padding}px`,
    paddingRight: `${padding}px`,
  }), [strategy, x, y, isPositioned, hasBeenPositioned, padding]);

  const content = (
    <>
      <div ref={refs.setReference} {...getReferenceProps({ className: triggerClassName })}>
        {triggerContent}
      </div>
      {ReactDOM.createPortal((
        <AnimatePresence>
          {open &&
            <motion.div
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ type: "spring", damping: 20, stiffness: 300 }}
              ref={refs.setFloating}
              className={tooltipClassName}
              style={floatingStyle}
              {...getFloatingProps()}
            >
              {tooltipContent}
            </motion.div>
          }
        </AnimatePresence>
      ), tooltipRoot)}
    </>
  );

  if (parentId === null) {
    return (
      <FloatingTree>
        {content}
      </FloatingTree>
    )
  } else {
    return content;
  }
});

export default UserProfilePopover;
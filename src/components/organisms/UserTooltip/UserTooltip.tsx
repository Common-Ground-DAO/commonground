// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { forwardRef, useCallback, useImperativeHandle } from "react";
import { UserTooltipHandle } from "../../atoms/Tooltip/UserProfilePopover";
import { useSidebarDataDisplayContext } from "context/SidebarDataDisplayProvider";

type Props = {
  userId: string;
  isMessageTooltip: boolean;
  defaultView?: 'admin' | 'profile';
  placement?: 'left' | 'right';
  hoveredMessageId?: string;
  channelId?: string;
  triggerClassName?: string;
  tooltipClassName?: string;
  listId?: string;
  openDelay?: number;
  closeDelay?: number;
}

const UserTooltip = forwardRef<UserTooltipHandle, React.PropsWithChildren<Props>>((props, ref) => {
  const {
    userId,
    children,
    isMessageTooltip,
    defaultView,
    hoveredMessageId,
    channelId,
    triggerClassName,
  } = props;
  const { showTooltip } = useSidebarDataDisplayContext();

  const openTooltip = useCallback(() => showTooltip({
    userId,
    showDeleteButton: isMessageTooltip,
    hoveredMessageId,
    channelId,
    defaultView,
    type: 'user'
  }), [channelId, defaultView, hoveredMessageId, isMessageTooltip, showTooltip, userId]);

  useImperativeHandle(ref, () => ({
    open: openTooltip
  }), [openTooltip]);

  // let triggerContent: React.JSX.Element;
  // if (!isMessageTooltip) {
  //   triggerContent = (<>
  //     <button className="user-trigger-btn" style={{ pointerEvents: 'auto' }}>
  //       {!!ownUser && ownUser?.id === userId ? (
  //         <div onClick={handleChildrenClick} ref={profileDrawerTriggerRef}>
  //           {children}
  //         </div>
  //       ) : (
  //         <>{children}</>
  //       )}
  //     </button>
  //   </>);
  // } else {
  //   triggerContent = (<>{children}</>);
  // }

  return (<div className={triggerClassName} onClick={openTooltip}>
    {children}
  </div>);

  // if (isMobile) {
  //   return (<div className={triggerClassName} onClick={openTooltip}>
  //     {triggerContent}
  //   </div>);
  // } else {
  //   return (
  //     <UserProfilePopover
  //       ref={desktopPopoverHandle}
  //       tooltipContent={
  //         <UserProfileModal
  //           key={userId}
  //           userId={userId}
  //           showDeleteButton={isMessageTooltip}
  //           hoveredMessageId={hoveredMessageId}
  //           channelId={channelId}
  //           defaultView={defaultView}
  //           // observedRef={observedRef} // FIXME: Currently doing nothing, is it needed?
  //         />
  //       }
  //       triggerContent={triggerContent}
  //       triggerClassName={triggerClassName}
  //       tooltipClassName={tooltipClassName}
  //       placement={placement ?? "left"}
  //       padding={16}
  //       withDelayGroup
  //       delayGroupListId={listId}
  //       openDelay={openDelay}
  //       closeDelay={closeDelay}
  //       isMessageTooltip={isMessageTooltip}
  //       modalDescendantRef={observedRef}        
  //     />
  //   );
  // }
});

export default UserTooltip;
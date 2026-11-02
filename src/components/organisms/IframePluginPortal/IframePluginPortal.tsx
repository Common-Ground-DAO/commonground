// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './IframePluginPortal.css';
import React, { CSSProperties, useRef, useState, useEffect, useMemo } from "react";
import { useWindowSizeContext } from "context/WindowSizeProvider";
import { usePluginIframeContext } from "context/PluginIframeProvider";
import { createPortal } from "react-dom";
import { Resize, X } from "@phosphor-icons/react";
import { useNavigate } from "react-router";
import { getUrl } from "common/util";
import communityDatabase from "data/databases/community";
import { isPluginUrlAllowed } from "data/auth/pluginOrigin";

const IframePluginPortal = () => {
  const navigate = useNavigate();
  const { isMobile, isTablet } = useWindowSizeContext();
  const { iframeUrl, iframeRef, iframeOrigin, isDocked, dockRef, pluginData, unloadIframe } = usePluginIframeContext();
  const [dockCoordinates, setDockCoordinates] = useState({ top: 0, left: 0, width: 0, height: 0 });
  const positionRef = useRef({ top: 0, left: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isDocked || !dockRef?.current) {
      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;
      setDockCoordinates({
        top: windowHeight - 220, // 200px height + 20px margin
        left: windowWidth - 220, // 200px width + 20px margin
        width: 200,
        height: 200
      });
      positionRef.current = {
        top: windowHeight - 220,
        left: windowWidth - 220
      };
      return;
    }

    const dockResizeListener = () => {
      if (!dockRef?.current) {
        return;
      }

      const { top, left, width, height } = dockRef.current.getBoundingClientRect();
      setDockCoordinates({ top, left, width, height });
      positionRef.current = { top, left };
    }

    const observer = new ResizeObserver(dockResizeListener);
    observer.observe(dockRef.current);
    return () => observer.disconnect();
  }, [dockRef, isDocked, isMobile, isTablet]);

  // Drag handler
  useEffect(() => {
    const handlePointerDown = (event: Event) => {
      if (!(event instanceof MouseEvent)) {
        return;
      }

      setIsDragging(true);
      const startX = event.clientX - positionRef.current.left;
      const startY = event.clientY - positionRef.current.top;

      const handlePointerMove = (moveEvent: MouseEvent) => {
        const newLeft = moveEvent.clientX - startX;
        const newTop = moveEvent.clientY - startY;
        setDockCoordinates(old => ({
          ...old,
          left: newLeft,
          top: newTop,
        }));
        positionRef.current = {
          left: newLeft,
          top: newTop,
        };
      };

      const handlePointerUp = () => {
        setIsDragging(false);
        document.removeEventListener("pointermove", handlePointerMove);
        document.removeEventListener("pointerup", handlePointerUp);
      };

      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", handlePointerUp);
    };

    const dragHandle = containerRef.current?.querySelector(".drag-handle");
    if (dragHandle) {
      dragHandle.addEventListener("pointerdown", handlePointerDown);
    }

    return () => {
      if (dragHandle) {
        dragHandle.removeEventListener("pointerdown", handlePointerDown);
      }
    };
  }, [isDocked]);

  const allowString = useMemo(() => {
    const basePermissions = 'cross-origin-isolated; web-share; clipboard-read; clipboard-write';

    if (!pluginData?.acceptedPermissions) {
      return basePermissions;
    }

    return `${basePermissions}; microphone ${pluginData?.acceptedPermissions?.includes('ALLOW_MICROPHONE') ? iframeOrigin : 'none'}; camera ${pluginData?.acceptedPermissions?.includes('ALLOW_CAMERA') ? iframeOrigin : 'none'}`;
  }, [iframeOrigin, pluginData?.acceptedPermissions]);

  const navigateToPlugin = async () => {
    const community = await communityDatabase.getCommunityDetailView(pluginData?.communityId || '');
    if (!community) {
      return;
    }

    navigate(getUrl({ type: 'community-plugin', community, plugin: { id: pluginData?.id || '' } }));
  }

  if (!iframeUrl || !iframeRef) {
    return null;
  }

  // never run plugin content on this instance's host or a subdomain of it
  const urlAllowed = isPluginUrlAllowed(iframeUrl);

  const style: CSSProperties = {
    top: `${dockCoordinates.top}px`,
    left: `${dockCoordinates.left}px`,
    width: `${dockCoordinates.width}px`,
    height: `${dockCoordinates.height}px`,
  };

  return createPortal(<div
    style={style}
    className='flex flex-col absolute z-10 cg-border-xxl overflow-hidden cg-box-shadow-lg'
    ref={containerRef}
  >
    {!isDocked && <div className='drag-handle flex justify-between items-center cg-bg-2nd cg-border-subtle rounded-t-lg' style={{ cursor: isDragging ? "grabbing" : "grab", borderBottom: "none" }}>
      <h4 className='cg-text-main px-2 overflow-hidden text-ellipsis whitespace-nowrap'>{pluginData?.name}</h4>
      <div className='flex'>
        <div className='collapsed-iframe-button' role='button' onClick={navigateToPlugin}>
          <Resize weight='duotone' className='w-5 h-5' />
        </div>
        <div className='collapsed-iframe-button' role='button' onClick={unloadIframe}>
          <X weight='duotone' className='w-5 h-5' />
        </div>
      </div>
    </div>}
    {!urlAllowed && <div className='flex flex-1 items-center justify-center p-4 text-center cg-text-main cg-bg-2nd cg-text-md-400'>
      This plugin can't be shown: it is served from this site's own address.
    </div>}
    {urlAllowed && allowString && iframeUrl && <iframe title={`iframe_${iframeUrl}`} allow={allowString} ref={iframeRef} src={iframeUrl} sandbox='allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads' className='w-full h-full' />}
  </div>,
    document.body
  );
}


export default React.memo(IframePluginPortal);
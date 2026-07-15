// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useCallback, useEffect, useRef, useState } from 'react';

import { ReactComponent as SyncIcon } from '../../../components/atoms/icons/16/Sync.svg';

import "./ConnectionStatusIndicator.css";
import { useConnectionContext } from '../../../context/ConnectionProvider';
import { ArrowPathIcon, CheckCircleIcon, ExclamationCircleIcon } from '@heroicons/react/20/solid';
import { useNavigationContext } from 'components/SuspenseRouter/SuspenseRouter';
import { useCallContext } from 'context/CallProvider';

const DELAY_BEFORE_SHOW = 3000;
const DELAY_BEFORE_HIDE = 1200;

export default function ConnectionStatusIndicator() {
  const { webSocketState, serviceWorkerState, onlineState, finishInstallation, visibilityState } = useConnectionContext();
  const { setUpdateOnNavigate } = useNavigationContext();
  const { call } = useCallContext();
  const visibilityTimeoutRef = useRef<any>();

  const [ state, _setState ] = useState<"hidden" | "offline" | "updated" | "updating" | "connecting" | "connected" | "disconnected">("hidden");
  const preRenderState = useRef<typeof state>(state);
  const [ isVisible, _setIsVisible ] = useState<boolean>(false);
  const preRenderVisible = useRef<boolean>(false);

  const clearTimeouts = useCallback(() => {
    if (!!visibilityTimeoutRef.current) {
      clearTimeout(visibilityTimeoutRef.current);
      visibilityTimeoutRef.current = undefined;
    }
  }, []);

  const setIsVisible = useCallback((value: boolean) => {
    if (preRenderVisible.current !== value) {
      preRenderVisible.current = value;
      _setIsVisible(value);
    }
  }, []);

  useEffect(() => {
    if (visibilityState === "visible") {
      clearTimeouts();
      visibilityTimeoutRef.current = setTimeout(() => {
        if (preRenderState.current !== 'connected') {
          setIsVisible(true);
        }
      }, DELAY_BEFORE_SHOW);
    }
  }, [clearTimeouts, setIsVisible, visibilityState]);

  const setState = useCallback((newState: typeof state) => {
    if (newState === 'updated' && !call) {
      setUpdateOnNavigate(true);
    }

    if (preRenderState.current !== newState) {
      clearTimeouts();
      _setState(newState);
      if (newState === "offline" || newState === "updated" || newState === "updating") {
        setIsVisible(true);
      }
      else if (newState === "connected") {
        visibilityTimeoutRef.current = setTimeout(() => {
          visibilityTimeoutRef.current = undefined;
          setIsVisible(false);
        }, DELAY_BEFORE_HIDE);
      }
      else if (newState === "connecting") {
        visibilityTimeoutRef.current = setTimeout(() => {
          visibilityTimeoutRef.current = undefined;
          setIsVisible(true);
        }, DELAY_BEFORE_SHOW);
      }
      else if (newState === "disconnected") {
        visibilityTimeoutRef.current = setTimeout(() => {
          visibilityTimeoutRef.current = undefined;
          setIsVisible(true);
        }, DELAY_BEFORE_SHOW);
      }
      preRenderState.current = newState;
      return true;
    }
    return false;
  }, [call, clearTimeouts, setIsVisible, setUpdateOnNavigate]);

  useEffect(() => {
    if (onlineState === "offline") {
      if (state !== onlineState) setState("offline");
    } else if (serviceWorkerState === "updated") {
      if (state !== serviceWorkerState) setState("updated");
    } else if (serviceWorkerState === "updating") {
      if (state !== serviceWorkerState) setState("updating");
    } else if (webSocketState === "connected") {
      if (state !== webSocketState) setState("connected");
    } else if (webSocketState === "version-update") {
      // The socket is connected when it learns about a new version; the
      // service-worker update flow (updating/updated above) owns the toast
      // from here. Without this branch the indicator would freeze on
      // whatever state rendered last.
      if (state !== "connected") setState("connected");
    } else if (webSocketState === "connecting") {
      if (state !== webSocketState) setState("connecting");
    } else if (webSocketState === "disconnected") {
      if (state !== webSocketState) setState("disconnected");
    }
  }, [webSocketState, onlineState, serviceWorkerState, clearTimeouts, setState, state]);

  let content: JSX.Element;
  if (state === "connected") {
    content = (
      <div className="cg-connection-indicator-content">
        Connected
        <CheckCircleIcon className='w-5 h-5'/>
      </div>
    );
  } else if (state === "connecting") {
    content = (
      <div className="cg-connection-indicator-content">
        Connecting
        <SyncIcon className="w-5 h-5" style={{
          animationName: "preview_spin",
          animationDuration: "2s",
          animationIterationCount: "infinite",
          animationTimingFunction: "linear"
        }} />
      </div>
    );

  } else if (state === "disconnected") {
    content = (
      <div className="cg-connection-indicator-content">
        Disconnected
        <ExclamationCircleIcon className='w-5 h-5' />
      </div>
    );

  } else if (state === "offline") {
    content = (
      <div className="cg-connection-indicator-content">
        You are offline
        <ExclamationCircleIcon className='w-5 h-5' />
      </div>
    );

  } else if (state === "updating") {
    content = (
      <div className="cg-connection-indicator-content">
        Updating...
        <SyncIcon className="w-5 h-5" style={{
          animationName: "preview_spin",
          animationDuration: "2s",
          animationIterationCount: "infinite",
          animationTimingFunction: "linear"
        }} />
      </div>
    );

  } else if (state === "updated") {
    content = (
      <div className="cg-connection-indicator-content">
        Update is ready 🥳 tap to reload
        <ArrowPathIcon className='w-5 h-5' />
      </div>
    );
  } else {
    content = (
      <></>
    );
  }

  return (
    <div
      id="cg-connection-indicator"
      className={`cg-connection-indicator-${state}`}
      style={
        isVisible
          ? {
            opacity: "1.0",
            pointerEvents: "auto",
            marginTop: "0px",
            cursor: state === "updated" ? "pointer" : "auto",
          } : {
            opacity: "0.0",
            pointerEvents: "none",
            marginTop: "-50px",
          }
      }
      onClick={(ev) => {
        if (state === "updated") {
          finishInstallation();
        }
      }}
    >
      {content}
    </div>
  )
}
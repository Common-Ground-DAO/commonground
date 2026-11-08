// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect, useMemo, useRef } from "react";
import { useNavigate, useParams } from "react-router";
import { parseIdOrUrl } from "../util";
import { useLoadedCommunityContext } from "./CommunityProvider";
import { getUrl } from "common/util";
import { useSnackbarContext } from "./SnackbarContext";

export const CommunityChannelIdContext = React.createContext<{ channelId?: string }>({});

export function CommunityChannelIdProvider(props: React.PropsWithChildren) {
  const { channels, community } = useLoadedCommunityContext();
  const { channelIdOrUrl } = useParams<'channelIdOrUrl'>();
  const timeoutRef = useRef<any>(null);
  const navigate = useNavigate();
  const { showSnackbar} = useSnackbarContext();

  const channelId = useMemo(() => {
    if (!channelIdOrUrl) {
      return undefined;
    }
    const whatIsIt = parseIdOrUrl(channelIdOrUrl);
    let channelId: string | undefined;
    if (!!whatIsIt.uuid) {
      channelId = channels.find(ch => ch.channelId === whatIsIt.uuid)?.channelId;
    } else if (!!whatIsIt.url) {
      channelId = channels.find(ch => ch.url === whatIsIt.url)?.channelId;
    }
    return channelId;
  }, [channelIdOrUrl, channels]);

  useEffect(() => {
    if (!channelId && !!channelIdOrUrl && timeoutRef.current === null) {
      showSnackbar({
        text: `Channel "${channelIdOrUrl}" not found or invisible to you, redirecting to lobby`,
        type: 'warning'
      });
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        navigate(getUrl({ type: 'community-lobby', community: { url: community.url } }));
      }, 500);
    }
    else if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, [channelId, navigate, community.url, channelIdOrUrl]);

  useEffect(() => {
    return () => {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    };
  }, []);

  return (
    <CommunityChannelIdContext.Provider value={{channelId}}>
      {props.children}
    </CommunityChannelIdContext.Provider>
  );
}

export function useCommunityChannelIdContext() {
  const context = React.useContext(CommunityChannelIdContext);
  return context;
}
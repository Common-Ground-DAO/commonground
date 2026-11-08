// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useEffect, useMemo, useRef } from 'react';
import { getRandomReadableString } from 'common/util';
import pluginsApi from 'data/api/plugins';
import { useOwnUser } from 'context/OwnDataProvider';
import { PluginRequestInner, PluginResponseInner, SafeRequestInner, PluginRequest, PluginResponse, GiveRoleActionPayload } from '@common-ground-dao/cg-plugin-lib-host';
import { useRoleClaimedContext } from 'context/RoleClaimedProvider';
import communityDatabase from 'data/databases/community';
import { useDarkModeContext } from 'context/DarkModeProvider';
import { isLocalUrl } from 'components/atoms/SimpleLink/SimpleLink';
import { useNavigate } from 'react-router';
import { useExternalModalContext } from 'context/ExternalModalProvider';
import { requestedPermissionToPermission  } from 'context/PluginIframeProvider';

export const MAX_REQUESTS_PER_MINUTE = 100;
export const MAX_NAVIGATES_PER_5_SECS = 1;

const useIframePlugin = (
  communityId: string,
  plugin: Models.Plugin.Plugin | null,
  showPermissionModal: (permission: 'email' | 'twitter' | 'lukso' | 'farcaster' | 'friends' | null) => void
) => {
  const navigate = useNavigate();
  const { openModal } = useRoleClaimedContext();
  const { isDarkMode } = useDarkModeContext();
  const { showModal: showExternalLinkModal } = useExternalModalContext();
  const ownUser = useOwnUser();
  const origin = plugin?.url || '';

  const requestTimestampHistory = useRef<number[]>([]);
  const navigateRequestTimestampHistory = useRef<number[]>([]);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const ownIframeUid = useMemo(() => getRandomReadableString(10), [origin, plugin?.id]);

  const pluginId = plugin?.id || '';
  const pluginConfig = plugin?.config || undefined;

  const [iframeUrl, iframeOrigin]  = useMemo(() => {
    if (!origin) {
      return ['',''];
    }

    const finalOrigin = origin.startsWith('http') ? origin : `https://${origin}`;

    const url = new URL(finalOrigin);
    url.searchParams.append('iframeUid', ownIframeUid);
    url.searchParams.append('cg_theme', isDarkMode ? 'dark' : 'light');
    url.searchParams.append('cg_bg_color', isDarkMode ? '#161820' : '#F1F1F1');

    return [url.toString(), url.origin];
  }, [origin, ownIframeUid, isDarkMode]);

  useEffect(() => {
    const eventHandler = async (event: MessageEvent) => {
      const iframe = iframeRef.current;
      const eventOriginUrl = new URL(event.origin);
      const originUrl = new URL(iframeUrl);
      if (event.origin !== 'null' && eventOriginUrl.origin !== originUrl.origin) {
        return;
      }

      // console.log('Received message from iframe:', event.data);
      const pluginRequest = event.data as PluginRequest;
      const request = JSON.parse(pluginRequest.request) as PluginRequestInner | SafeRequestInner;

      try {
        if (ownIframeUid !== request.iframeUid) {
          console.warn('Received message from unknown iframe:', request.iframeUid);
          throw new Error('UNKNOWN_IFRAME');
        }

        const history = requestTimestampHistory.current ?? [];
        const now = Date.now();

        // Remove all timestamps older than 1 minute
        requestTimestampHistory.current = history.filter((timestamp) => timestamp > now - 60000);
        requestTimestampHistory.current.push(now);

        if (history.length >= MAX_REQUESTS_PER_MINUTE) {
          console.warn('Max requests per minute reached for iframe:', ownIframeUid);
          throw new Error('MAX_REQUESTS_PER_MINUTE');
        }

        if (request.type === 'safeRequest') {
          let responseInner: PluginResponseInner;
          if (request.data.type === 'init') {
            let assignableRoleIds: string[] = []
            if (pluginConfig?.canGiveRole) {
              assignableRoleIds = pluginConfig.giveableRoleIds || [];
            }

            responseInner = {
              data: {
                pluginId,
                assignableRoleIds,
                userId: ownUser?.id || '',
              },
              pluginId,
              requestId: request.requestId,
            };
          } else if (request.data.type === 'navigate') {
            const navigateHistory = navigateRequestTimestampHistory.current ?? [];

            // Remove all timestamps older than 5 seconds
            navigateRequestTimestampHistory.current = navigateHistory.filter((timestamp) => timestamp > now - 5000);
            navigateRequestTimestampHistory.current.push(now);
            
            if (navigateHistory.length > MAX_NAVIGATES_PER_5_SECS) {
              console.warn('Max navigates per 5 seconds reached for iframe:', ownIframeUid);
              throw new Error('MAX_NAVIGATES_PER_5_SECS');
            }

            const isLocal = isLocalUrl(request.data.to);
            if (isLocal) {
              navigate(isLocal);
            } else {
              showExternalLinkModal(request.data.to);
            }

            responseInner = {
              data: {
                ok: true,
              },
              pluginId,
              requestId: request.requestId,
            };
          } else if (request.data.type === 'requestPermission') {
            const navigateHistory = navigateRequestTimestampHistory.current ?? [];

            // Remove all timestamps older than 5 seconds
            navigateRequestTimestampHistory.current = navigateHistory.filter((timestamp) => timestamp > now - 5000);
            navigateRequestTimestampHistory.current.push(now);
            
            if (navigateHistory.length > MAX_NAVIGATES_PER_5_SECS) {
              console.warn('Max navigates per 5 seconds reached for iframe:', ownIframeUid);
              throw new Error('MAX_NAVIGATES_PER_5_SECS');
            }

            const requestedPermission = request.data.permission;
            const userHasAccount = (requestedPermission === 'email' && !!ownUser?.email && ownUser.emailVerified) || (ownUser?.accounts.some((account) => account.type === requestedPermission));
            const hasPermission = plugin?.acceptedPermissions?.includes(requestedPermissionToPermission(requestedPermission));
            const canAddPermission = plugin?.permissions?.optional?.includes(requestedPermissionToPermission(requestedPermission)) || plugin?.permissions?.mandatory?.includes(requestedPermissionToPermission(requestedPermission));

            if (canAddPermission && (!userHasAccount || !hasPermission)) {
              showPermissionModal(requestedPermission);
            }

            responseInner = {
              data: {
                ok: true,
              },
              pluginId,
              requestId: request.requestId,
            };
          } else {
            throw new Error('UNKNOWN_SAFE_REQUEST');
          }

          const response: PluginResponse = {
            response: JSON.stringify(responseInner),
          };

          const pluginResponse = {
            type: request.requestId,
            payload: response,
          };

          iframe?.contentWindow?.postMessage(pluginResponse, '*');
          return;
        }

        const response = await pluginsApi.pluginRequest(pluginRequest);

        // On correct response handlers
        const responseData = JSON.parse(response.response) as PluginResponseInner;

        // If role has been claimed, open modal
        if (request.data.type === 'giveRole' && 'success' in responseData.data && responseData.data.success) {
          const requestData = request.data as GiveRoleActionPayload;
          const roles = await communityDatabase.getRoles(communityId);

          const givenRole = roles.find((role) => role.id === requestData.roleId);
          if (givenRole) {
            openModal(givenRole);
          }
        }

        iframe?.contentWindow?.postMessage({
          type: request.requestId,
          payload: response,
        }, origin);
      } catch (error) {
        const responseInner: PluginResponseInner = {
          data: {
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          pluginId,
          requestId: request.requestId,
        };

        const pluginResponse: PluginResponse = {
          response: JSON.stringify(responseInner),
        };

        iframe?.contentWindow?.postMessage({
          type: request.requestId,
          payload: pluginResponse,
        }, origin);
      }
    };

    if (!!pluginId) {
      window.addEventListener('message', eventHandler);
    }

    return () => {
      window.removeEventListener('message', eventHandler);
    };
  }, [origin, ownIframeUid, ownUser?.id, openModal, communityId, iframeUrl, navigate, showExternalLinkModal, pluginId, pluginConfig?.canGiveRole, pluginConfig?.giveableRoleIds]);

  return {
    iframeRef,
    iframeUrl,
    iframeOrigin,
  };
}

export default useIframePlugin;
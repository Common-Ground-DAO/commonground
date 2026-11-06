// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { io, type Socket } from 'socket.io-client';

/**
 * The gateway opens no data socket (docs/auth-identity §12). The one thing it
 * needs a socket for is the result of the legacy CG ID passkey popup
 * (`cliCgIdSignResponse`, sent to the room of the request the page watches):
 * this minimal socket connects for one request, watches it
 * (`watchCgIdRequest`, one of the two events a gateway's wsapi serves) and
 * closes again. The popup also posts the result to its opener; whichever
 * arrives first counts (src/context/LegacyCgIdPasskey.tsx).
 */
export function watchCgIdResult(
  frontendRequestId: string,
  onResult: (event: Events.CgId.SignResponse) => void,
  onConnected: () => void = () => undefined,
): () => void {
  const socket: Socket = io({
    path: '/api/ws/',
    transports: ['polling', 'websocket'],
    reconnectionDelayMax: 10_000,
  });
  socket.on('connect', () => {
    socket.emit('watchCgIdRequest', { frontendRequestId });
    onConnected();
  });
  socket.on('cliCgIdSignResponse', (event: Omit<Events.CgId.SignResponse, 'type'>) => {
    onResult({ ...event, type: 'cliCgIdSignResponse' } as Events.CgId.SignResponse);
  });
  return () => {
    socket.close();
  };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

// Replacement service worker of a gateway (docs/auth-identity §12): served by
// the gateway's site (common.caddy, cg_gateway_app) at /service-worker.js,
// the URL the old web app registered its worker under (scope "/"). Browsers
// keep checking that URL for updates, so an old installed app picks this up
// and ends on the gateway page instead of the copy of the old app its worker
// kept in Cache Storage (docs/frontend "Service worker on a gateway").
//
// - install: takes over at once (skipWaiting), without waiting for the old
//   app's pages to close.
// - activate: deletes every Cache Storage cache of the origin (the old
//   precache with the old app), takes control of every page (clients.claim)
//   and reloads the pages the previous worker controlled, so they load the
//   gateway page from the network (started, not awaited, inside the
//   activation). Pages that no worker controlled (a first visit to the
//   gateway page, which registers this worker itself) are not reloaded, so
//   nothing reloads twice.
// - no fetch handler: every request goes to the network.
// - push: shows a pushed notification (one-off notices to old subscriptions)
//   in the old app's payload format; a click opens the gateway page.
//
// Leaves IndexedDB and localStorage alone: the gateway signs in with the
// device key stored there.
//
// Plain JavaScript without imports, copied into the Caddy image as is (no
// build step). Change VERSION with every change: browsers install a new
// worker only when its bytes differ, and every installed copy reloads the
// pages it controls once more.

const VERSION = 'gateway-sw-1';

const FALLBACK_TITLE = 'Common Ground has moved';
const FALLBACK_BODY = 'Open this notification to continue.';

self.addEventListener('install', () => {
  self.skipWaiting();
});

/**
 * reloads a page; the old app reloads itself on the message where navigate()
 * is missing or refused. The target drops the fragment: navigating to the
 * same URL with a fragment is a same-document navigation, not a reload.
 */
function reload(client) {
  try {
    const target = new URL(client.url);
    target.hash = '';
    return Promise.resolve(client.navigate(target.href)).catch(() => client.postMessage({ action: 'reload' }));
  } catch (error) {
    client.postMessage({ action: 'reload' });
    return Promise.resolve();
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // the pages the previous worker controlled: on activation they are
    // controlled by this one, before clients.claim() adds the others
    const previouslyControlled = await self.clients.matchAll({ type: 'window' });
    const names = await self.caches.keys();
    await Promise.all(names.map((name) => self.caches.delete(name)));
    await self.clients.claim();
    console.log(`${VERSION}: activated, ${names.length} cache(s) deleted, reloading ${previouslyControlled.length} page(s)`);
    // Not awaited: a navigation of a page this worker controls waits until
    // the worker is activated, which in turn waits for this promise — waiting
    // for the navigations here would hold both up (measured in Chrome 151).
    for (const client of previouslyControlled) reload(client);
  })());
});

/** title, body and same-origin path of a push in the old app's format, else a fixed notice */
function notificationFromPush(data) {
  let payload = null;
  try {
    payload = data ? data.json() : null;
  } catch (error) {
    payload = null;
  }
  const item = payload && typeof payload === 'object' ? payload.data : null;
  const extra = item && typeof item === 'object' ? item.extraData : null;
  if (extra && typeof extra === 'object' && extra.type === 'generalData'
      && typeof extra.title === 'string' && extra.title !== '') {
    return {
      title: extra.title,
      body: typeof item.text === 'string' ? item.text : '',
      path: typeof extra.navUrl === 'string' ? extra.navUrl : '/',
    };
  }
  return { title: FALLBACK_TITLE, body: FALLBACK_BODY, path: '/' };
}

/** a URL on this origin for `path`, else the origin's root */
function ownUrl(path) {
  try {
    const url = new URL(path, self.location.origin);
    if (url.origin === self.location.origin) return url.href;
  } catch (error) {
    // not a URL
  }
  return new URL('/', self.location.origin).href;
}

self.addEventListener('push', (event) => {
  const { title, body, path } = notificationFromPush(event.data);
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/icons/192.png',
    data: { url: ownUrl(path) },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  const url = ownUrl(data && typeof data.url === 'string' ? data.url : '/');
  event.waitUntil((async () => {
    // an open gateway window is focused and sent there instead of opening another
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((client) => 'focus' in client);
    if (open) {
      try {
        await open.focus();
        if ('navigate' in open) await open.navigate(url);
        return;
      } catch (error) {
        // focus or navigate refused: open a new window below
      }
    }
    await self.clients.openWindow(url);
  })());
});

// gcnb service worker: shows Web Push notifications and opens the right chat when you tap one.
// No offline cache: gcnb is useless without its server, and a stale cached app is worse than none.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (e) => {
  const n = e.data ? e.data.json() : { title: 'gcnb', body: '' }
  e.waitUntil(
    self.registration.showNotification(n.title, {
      body: n.body,
      tag: n.tag, // replies to one thread replace each other; "needs you" has its own tag
      renotify: !!n.urgent, // buzz again for a new card, stay quiet for a follow-up bubble
      requireInteraction: !!n.urgent,
      icon: '/icon-192.png',
      badge: '/favicon.png',
      data: { threadId: n.threadId },
    }),
  )
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const threadId = e.notification.data && e.notification.data.threadId
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
      const tab = tabs[0]
      if (!tab) return self.clients.openWindow(threadId ? `/?t=${encodeURIComponent(threadId)}` : '/')
      tab.postMessage({ open: threadId })
      return tab.focus()
    }),
  )
})

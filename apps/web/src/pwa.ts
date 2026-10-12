import type { Note } from '@gcnb/shared'

// PWA + notifications. Web Push (via the service worker) reaches your phone with the screen off;
// the plain Notification API is the fallback for browsers or origins without push (e.g. plain http).

export type Config = { vapidPublicKey: string; whisper: boolean }
export type Pings = 'unsupported' | 'off' | 'blocked' | 'push' | 'local'

const swReady = 'serviceWorker' in navigator ? navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).catch(() => null) : Promise.resolve(null)

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

// Re-sends an existing subscription (cheap, and heals a wiped server data dir).
async function sync(sub: PushSubscription) {
  const res = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub) })
  if (!res.ok) throw new Error(`subscribe failed (${res.status})`)
}

export async function currentPings(): Promise<Pings> {
  if (!('Notification' in window)) return 'unsupported'
  if (Notification.permission === 'denied') return 'blocked'
  if (Notification.permission !== 'granted') return 'off'
  const reg = await swReady
  const sub = await reg?.pushManager?.getSubscription()
  if (sub) {
    await sync(sub).catch(() => {})
    return 'push'
  }
  return 'local'
}

// Must run from a tap/click: browsers only show the permission prompt for a user gesture.
// On iPhone this works once gcnb is added to the home screen.
export async function enablePings(cfg: Config | null): Promise<Pings> {
  if (!('Notification' in window)) return 'unsupported'
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return perm === 'denied' ? 'blocked' : 'off'
  try {
    const reg = await swReady
    if (!reg?.pushManager || !cfg) return 'local'
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.vapidPublicKey) }))
    await sync(sub)
    return 'push'
  } catch (err) {
    console.warn('push unavailable, using in-page notifications', err)
    return 'local'
  }
}

// Fallback banner while this tab is hidden (push already covers it when on).
export async function localNotify(n: Note, open: (threadId: string) => void) {
  const opts = { body: n.body, tag: n.tag, icon: '/icon-192.png', data: { threadId: n.threadId } }
  const reg = await swReady
  if (reg) return reg.showNotification(n.title, opts) // Android only allows notifications through the SW
  const note = new Notification(n.title, opts)
  note.onclick = () => {
    window.focus()
    open(n.threadId)
  }
}

// Tapping a notification while gcnb is open: the service worker asks this tab to switch threads.
export function onOpenThread(open: (threadId: string) => void) {
  const handler = (e: MessageEvent) => e.data?.open && open(e.data.open)
  navigator.serviceWorker?.addEventListener('message', handler)
  return () => navigator.serviceWorker?.removeEventListener('message', handler)
}

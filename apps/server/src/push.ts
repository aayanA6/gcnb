import webpush, { type PushSubscription } from 'web-push'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Note } from '@gcnb/shared'

const read = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// Web Push, so your phone buzzes even with the screen off and the tab asleep. The VAPID key pair is made
// once and kept in the data dir; subscriptions live next to it (one per browser that turned pings on).
export class Push {
  readonly publicKey: string
  private subs: PushSubscription[]
  private subsFile: string

  constructor(dataDir: string) {
    const keyFile = join(dataDir, 'vapid.json')
    let keys = read<{ publicKey: string; privateKey: string }>(keyFile)
    if (!keys) writeFileSync(keyFile, JSON.stringify((keys = webpush.generateVAPIDKeys())), { mode: 0o600 })
    webpush.setVapidDetails(process.env.GCNB_VAPID_SUBJECT ?? 'https://github.com/aayanA6/gcnb', keys.publicKey, keys.privateKey)
    this.publicKey = keys.publicKey
    this.subsFile = join(dataDir, 'push.json')
    this.subs = read<PushSubscription[]>(this.subsFile) ?? []
  }

  get count() {
    return this.subs.length
  }

  subscribe(sub: PushSubscription) {
    this.subs = [...this.subs.filter((s) => s.endpoint !== sub.endpoint), sub]
    this.save()
  }

  send(note: Note) {
    for (const sub of this.subs)
      webpush.sendNotification(sub, JSON.stringify(note), { TTL: 3600, urgency: note.urgent ? 'high' : 'normal' }).catch((err: { statusCode?: number }) => {
        // 404/410: the browser dropped this subscription (pings turned off, app uninstalled).
        if (err.statusCode === 404 || err.statusCode === 410) {
          this.subs = this.subs.filter((s) => s.endpoint !== sub.endpoint)
          this.save()
        }
      })
  }

  private save() {
    writeFileSync(this.subsFile, JSON.stringify(this.subs), { mode: 0o600 })
  }
}

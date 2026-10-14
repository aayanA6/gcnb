// The server runs the group chat, not a model: it decides who receives each message and counts
// every hand-off so agents can't loop forever (plan: "Group chat design").
import { HOP_LIMIT, type Message, type ServerEvent, type Thread } from '@gcnb/shared'
import type { Db } from './db.ts'

export type Delivery = { threadId: string; text: string; hops: number }

// What the router needs from a contact's runtime.
export type Deliverable = { state(): { live: boolean; reason?: string }; deliver(d: Delivery): void }

const HOUR = 3_600_000
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export class Router {
  // ponytail: hourly group spend is kept in memory, so a restart forgets the last hour; persist it if the cap must survive restarts.
  private spend = new Map<string, { at: number; usd: number }[]>()

  constructor(
    private db: Db,
    private runtimes: Map<string, Deliverable>,
    private emit: (e: ServerEvent) => void,
    private userName = process.env.GCNB_USER_NAME ?? 'You',
  ) {}

  /** The user posted in a thread. */
  post(threadId: string, text: string) {
    const t = this.db.thread(threadId)
    if (!t) return
    if (t.kind === 'dm') {
      const rt = this.runtimes.get(t.contactIds[0])
      if (!rt) return
      const state = rt.state()
      this.add({ threadId, sender: 'user', contactId: null, kind: 'text', body: { text, delivered: state.live } })
      if (state.live) rt.deliver({ threadId, text, hops: 0 })
      else this.line(threadId, t.contactIds[0], `Not delivered: ${state.reason}`)
      return
    }
    // Group: to each @mentioned member, else the lead. A user post starts a fresh hop count.
    const message = this.add({ threadId, sender: 'user', contactId: null, kind: 'text', body: { text, delivered: false } })
    const delivered = this.recipients(t, text).map((id) => this.deliver(t, id, this.userName, text, 0) === null)
    if (delivered.some(Boolean)) this.patch(message.id, { delivered: true })
  }

  recipients(t: Thread, text: string): string[] {
    // A mention starts the text or follows whitespace, so "me@coder.dev" isn't one.
    if (/(^|\s)@everyone\b/i.test(text)) return t.contactIds
    const hit = t.contactIds.filter((id) => {
      const c = this.db.contact(id)
      return c && new RegExp(`(^|\\s)@(${escape(c.agentName)}|${escape(c.displayName)})\\b`, 'i').test(text)
    })
    return hit.length ? hit : [t.leadContactId ?? t.contactIds[0]]
  }

  /** The hand_off tool. Returns the tool result the calling agent sees. */
  handOff(fromId: string, from: Delivery, to: string, message: string): string {
    const t = this.db.thread(from.threadId)
    if (!t || t.kind !== 'group') return 'hand_off only works inside a group chat. Ask the user to add you and the other contact to a group.'
    const target = t.contactIds
      .filter((id) => id !== fromId)
      .map((id) => this.db.contact(id)!)
      .find((c) => [c.agentName, c.displayName].some((n) => n.toLowerCase() === to.replace(/^@/, '').trim().toLowerCase()))
    if (!target) return `No other member called "${to}". Members: ${this.names(t)}.`
    const hops = from.hops + 1
    if (hops > HOP_LIMIT) {
      this.line(t.id, fromId, `Paused after ${HOP_LIMIT} hand-offs, waiting for you`)
      return `Paused: ${HOP_LIMIT} hand-offs in a row without the user. Do not hand off again; wrap up and wait for the user.`
    }
    const fromName = this.db.contact(fromId)!.displayName
    this.add({ threadId: t.id, sender: 'system', contactId: fromId, kind: 'status', body: { text: `${fromName} handed off to ${target.displayName}`, handoff: { from: fromId, to: target.id } } })
    const err = this.deliver(t, target.id, fromName, message, hops)
    return err ? `Not delivered to ${target.displayName}: ${err}` : `Handed off to ${target.displayName} (hand-off ${hops} of ${HOP_LIMIT}). Their reply will post to the group.`
  }

  /** Called when a group turn finishes, with what it cost. */
  recordSpend(threadId: string, usd: number) {
    if (usd <= 0) return
    this.spend.set(threadId, [...this.recent(threadId), { at: Date.now(), usd }])
    const t = this.db.thread(threadId)
    if (t) this.emit({ type: 'thread', thread: this.withSpend(t) })
  }

  withSpend = (t: Thread): Thread => (t.kind === 'group' ? { ...t, spentHourUsd: this.spentLastHour(t.id) } : t)

  spentLastHour = (threadId: string) => this.recent(threadId).reduce((sum, s) => sum + s.usd, 0)

  private recent(threadId: string) {
    return (this.spend.get(threadId) ?? []).filter((s) => s.at > Date.now() - HOUR)
  }

  // Delivery = a user message into the member's own session, prefixed with group and sender.
  private deliver(t: Thread, contactId: string, from: string, text: string, hops: number): string | null {
    const rt = this.runtimes.get(contactId)
    const name = this.db.contact(contactId)?.displayName ?? contactId
    if (!rt) return 'not a contact'
    const state = rt.state()
    if (!state.live) {
      this.line(t.id, contactId, `${name}: not delivered (${state.reason})`)
      return state.reason ?? 'offline'
    }
    const lead = t.leadContactId ? ` · lead: ${this.db.contact(t.leadContactId)?.agentName ?? t.leadContactId}` : ''
    rt.deliver({ threadId: t.id, text: `[#${t.title} · from ${from}${lead} · members: ${this.names(t)}] ${text}`, hops })
    return null
  }

  private names(t: Thread) {
    return t.contactIds.map((id) => this.db.contact(id)?.agentName ?? id).join(', ')
  }

  private add(m: Omit<Message, 'id' | 'createdAt'>) {
    const message = this.db.addMessage(m)
    this.emit({ type: 'message', message })
    return message
  }

  private patch(id: string, body: Partial<Message['body']>) {
    const message = this.db.patchMessageBody(id, body)
    if (message) this.emit({ type: 'message', message })
  }

  private line(threadId: string, contactId: string, text: string) {
    this.add({ threadId, sender: 'system', contactId, kind: 'status', body: { text } })
  }
}

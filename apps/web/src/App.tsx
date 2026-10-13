import { Fragment, useEffect, useReducer, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { HOP_LIMIT, PERMISSION_MODES, ServerEvent, noteFor, type AgentState, type ClientEvent, type Contact, type Decision, type Message, type Question, type Thread, type Typing } from '@gcnb/shared'
import { applyTheme, themes } from './theme.ts'
import { currentPings, enablePings, localNotify, onOpenThread, type Config, type Pings } from './pwa.ts'
import { useVoice, voiceEngine, type Engine } from './voice.ts'
import { usePip } from './pip.tsx'

type State = {
  connected: boolean
  contacts: Contact[]
  threads: Thread[]
  messages: Message[]
  agents: Record<string, AgentState>
  typing: Typing[]
}
type Action = ServerEvent | { type: 'connected'; on: boolean }

const initial: State = { connected: false, contacts: [], threads: [], messages: [], agents: {}, typing: [] }

function reduce(s: State, e: Action): State {
  switch (e.type) {
    case 'connected':
      return { ...s, connected: e.on }
    case 'snapshot':
      return { ...s, contacts: e.contacts, threads: e.threads, messages: e.messages, typing: e.typing, agents: Object.fromEntries(e.agents.map((a) => [a.contactId, a])) }
    case 'message': // a known id is a card changing state; otherwise it's new
      return s.messages.some((m) => m.id === e.message.id)
        ? { ...s, messages: s.messages.map((m) => (m.id === e.message.id ? e.message : m)) }
        : { ...s, messages: [...s.messages, e.message] }
    case 'typing': {
      const rest = s.typing.filter((t) => t.contactId !== e.contactId)
      return { ...s, typing: e.on ? [...rest, { contactId: e.contactId, threadId: e.threadId }] : rest }
    }
    case 'thread':
      return s.threads.some((t) => t.id === e.thread.id)
        ? { ...s, threads: s.threads.map((t) => (t.id === e.thread.id ? e.thread : t)) }
        : { ...s, threads: [...s.threads, e.thread] }
    case 'agent':
      return { ...s, agents: { ...s.agents, [e.agent.contactId]: e.agent } }
    case 'contact':
      return { ...s, contacts: s.contacts.map((c) => (c.id === e.contact.id ? e.contact : c)) }
  }
}

// One socket to the server; reconnects every second and gets a fresh snapshot on open.
// It also tells the server whether this tab is on screen, so phone pings only fire when nobody's looking —
// `pipOpenRef` counts the PiP mini window as "looking" too, since it floats on top of everything else.
function useGcnb(onEvent: (e: ServerEvent) => void, pipOpenRef: RefObject<boolean>) {
  const [state, dispatch] = useReducer(reduce, initial)
  const ws = useRef<WebSocket | null>(null)
  const handler = useRef(onEvent)
  handler.current = onEvent
  useEffect(() => {
    let stopped = false
    let timer = 0
    const send = (ev: ClientEvent) => ws.current?.readyState === WebSocket.OPEN && ws.current.send(JSON.stringify(ev))
    const visibility = () => send({ type: 'visible', on: pipOpenRef.current || !document.hidden })
    const connect = () => {
      const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
      ws.current = sock
      sock.onopen = () => {
        dispatch({ type: 'connected', on: true })
        visibility()
      }
      sock.onmessage = (m) => {
        const parsed = ServerEvent.safeParse(JSON.parse(m.data))
        if (!parsed.success) return console.warn('bad server event', parsed.error)
        dispatch(parsed.data)
        handler.current(parsed.data)
      }
      sock.onclose = () => {
        dispatch({ type: 'connected', on: false })
        if (!stopped) timer = window.setTimeout(connect, 1000)
      }
    }
    connect()
    document.addEventListener('visibilitychange', visibility)
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibility)
      ws.current?.close()
    }
  }, [])
  const emit = (ev: ClientEvent) => ws.current?.send(JSON.stringify(ev))
  return { state, emit }
}

function useMedia(query: string) {
  const [on, setOn] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const mq = matchMedia(query)
    const f = (e: MediaQueryListEvent) => setOn(e.matches)
    mq.addEventListener('change', f)
    return () => mq.removeEventListener('change', f)
  }, [query])
  return on
}

// Whether this tab is on screen right now (for "mark thread as seen").
function usePageVisible() {
  const [on, setOn] = useState(() => !document.hidden)
  useEffect(() => {
    const f = () => setOn(!document.hidden)
    document.addEventListener('visibilitychange', f)
    return () => document.removeEventListener('visibilitychange', f)
  }, [])
  return on
}

const load = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key)
    if (v !== null) return JSON.parse(v)
  } catch {}
  return fallback
}
const save = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {}
}

// First-run time, saved once: unread counts only look at messages after this, so upgrading
// to the unread feature doesn't suddenly show a huge count for every old message.
const SEEN_SINCE = (() => {
  const existing = load<number | null>('gcnb.seenSince', null)
  if (existing) return existing
  const now = Date.now()
  save('gcnb.seenSince', now)
  return now
})()

// "Auto" follows the system's light/dark setting: Cartoon by day, Cartoon Night after dark.
const AUTO = { light: 'cartoon', dark: 'cartoon-night' }
function useTheme() {
  const [id, setId] = useState(() => {
    const saved = load('gcnb.themeId', 'auto')
    return saved === 'auto' || themes[saved] ? saved : 'auto'
  })
  const dark = useMedia('(prefers-color-scheme: dark)')
  const active = id === 'auto' ? AUTO[dark ? 'dark' : 'light'] : id
  useEffect(() => {
    applyTheme(themes[active])
    save('gcnb.themeId', id)
  }, [id, active])
  return [id, setId] as const
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

// "Today · 2:14 PM" / "Yesterday · …" / weekday within a week / short date beyond that.
function dateLabel(ms: number): string {
  const d = new Date(ms)
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000)
  const day = days === 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? d.toLocaleDateString([], { weekday: 'long' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return `${day} · ${time(ms)}`
}
const DatePill = ({ ms }: { ms: number }) => <div className="self-center px-3 py-1 text-center text-xs font-bold text-muted">{dateLabel(ms)}</div>

function Avatar({ c, size = 'size-10' }: { c: Contact; size?: string }) {
  if (c.avatarPath) return <img src={c.avatarPath} alt="" className={`${size} btn shrink-0 rounded-full object-cover`} />
  const initials = c.displayName.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()
  return (
    <div aria-hidden className={`${size} btn grid shrink-0 place-items-center rounded-full font-bold text-[#1d1b2e]`} style={{ background: c.color }}>
      {initials}
    </div>
  )
}

function Bubble({ m, showReceipt }: { m: Message; showReceipt: boolean }) {
  if (m.sender === 'system')
    return <div className="self-center px-3 py-1 text-center font-mono text-xs text-muted">{m.body.text}</div>
  const mine = m.sender === 'user'
  return (
    <div className={`flex max-w-[75%] flex-col ${mine ? 'self-end items-end' : 'self-start items-start'}`}>
      <div className={`bubble ${mine ? 'bg-me text-on-me' : 'bg-them text-on-them'}`} title={time(m.createdAt)}>
        {m.body.text}
      </div>
      {mine && showReceipt && (
        <div className={`mt-1 text-[11px] ${m.body.delivered ? 'text-muted' : 'text-alert'}`}>
          {m.body.delivered ? 'Delivered' : 'Not delivered'}
        </div>
      )}
    </div>
  )
}

type Answer = { decision?: Decision; answers?: Record<string, string> }

// Small grey line between bubbles: what the agent is doing ("Read src/auth.ts", "Ran npm test").
// In a group each line carries the member's pfp, so the group doubles as "what is everyone doing".
function ToolLine({ m, c }: { m: Message; c?: Contact }) {
  return (
    <div className="b-dashed flex items-center gap-1.5 self-start rounded-button px-3 py-0.5 font-mono text-xs text-muted">
      {c && <Avatar c={c} size="size-4 text-[7px]" />}
      {c && <span className="font-body">{c.displayName}</span>}
      {m.body.text}
    </div>
  )
}

const OUTCOME: Record<string, string> = {
  allow: '👍 Allowed once',
  always: '‼️ Always allowed',
  deny: '👎 Denied',
  answered: 'Answered',
  cancelled: 'Cancelled',
  expired: 'Expired: gcnb restarted before you answered',
}

// Tapbacks: 👍 allow once (biggest, Y), ‼️ always allow, 👎 deny (N).
function ApprovalCard({ m, onAnswer }: { m: Message; onAnswer: (a: Answer) => void }) {
  const b = m.body
  return (
    <div
      role="group"
      aria-label={b.text}
      className="bubble flex w-full max-w-md flex-col gap-2 self-start text-on-them"
      style={{ background: 'color-mix(in srgb, var(--colors-accent) 14%, var(--colors-them))' }}
    >
      <div className="font-bold">{b.text}</div>
      {b.detail && <pre className="field max-h-40 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-xs">{b.detail}</pre>}
      {b.status === 'pending' ? (
        <>
          <button className="btn bg-ok py-2.5 text-base text-on-accent" onClick={() => onAnswer({ decision: 'allow' })}>
            👍 Allow once <kbd className="ml-1 text-xs opacity-70">Y</kbd>
          </button>
          <div className="flex gap-2">
            {b.canAlways && (
              <button className="btn flex-1 bg-panel py-1.5 text-sm text-ink" onClick={() => onAnswer({ decision: 'always' })}>
                ‼️ Always allow
              </button>
            )}
            <button className="btn flex-1 bg-alert py-1.5 text-sm text-on-alert" onClick={() => onAnswer({ decision: 'deny' })}>
              👎 Deny <kbd className="ml-1 text-xs opacity-70">N</kbd>
            </button>
          </div>
        </>
      ) : (
        <div className="text-sm font-bold">{OUTCOME[b.status ?? ''] ?? b.status}</div>
      )}
    </div>
  )
}

// AskUserQuestion as quick-reply chips plus "Other" for free text.
function QuestionCard({ m, onAnswer }: { m: Message; onAnswer: (a: Answer) => void }) {
  const b = m.body
  const questions = b.questions ?? []
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string | undefined>>({}) // undefined = "Other" closed
  const answerFor = (q: Question) => [...(picked[q.question] ?? []), ...(other[q.question]?.trim() ? [other[q.question]!.trim()] : [])].join(', ')
  const submit = (answers = Object.fromEntries(questions.map((q) => [q.question, answerFor(q)]))) => onAnswer({ answers })
  const pick = (q: Question, label: string) => {
    if (!q.multiSelect && questions.length === 1) return submit({ [q.question]: label }) // one tap answers
    const cur = picked[q.question] ?? []
    setPicked({ ...picked, [q.question]: q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label] })
    if (!q.multiSelect) setOther({ ...other, [q.question]: undefined })
  }

  return (
    <div role="group" aria-label={b.text} className="bubble flex w-full max-w-md flex-col gap-3 self-start bg-them text-on-them">
      {questions.map((q) => (
        <div key={q.question} className="flex flex-col gap-2">
          <div className="font-bold">{q.question}</div>
          {b.status === 'pending' ? (
            <div className="flex flex-wrap gap-2">
              {q.options.map((o) => {
                const on = picked[q.question]?.includes(o.label)
                return (
                  <button key={o.label} title={o.description} aria-pressed={on} onClick={() => pick(q, o.label)} className={`btn px-3 py-1 text-sm ${on ? 'bg-me text-on-me' : 'bg-panel text-ink'}`}>
                    {o.label}
                  </button>
                )
              })}
              {other[q.question] === undefined ? (
                <button className="b-dashed rounded-button px-3 py-1 text-sm" onClick={() => setOther({ ...other, [q.question]: '' })}>
                  Other…
                </button>
              ) : (
                <input
                  autoFocus
                  value={other[q.question]}
                  onChange={(e) => setOther({ ...other, [q.question]: e.target.value })}
                  onKeyDown={(e) => e.key === 'Enter' && questions.every(answerFor) && submit()}
                  placeholder="Type your answer"
                  aria-label={`Other answer to: ${q.question}`}
                  className="field min-w-40 flex-1 px-3 py-1 text-sm"
                />
              )}
            </div>
          ) : (
            <div className="text-sm">{b.answers?.[q.question] ? `→ ${b.answers[q.question]}` : OUTCOME[b.status ?? '']}</div>
          )}
        </div>
      ))}
      {b.status === 'pending' && (questions.length > 1 || questions.some((q) => q.multiSelect) || Object.values(other).some((v) => v !== undefined)) && (
        <button className="btn self-end bg-me px-4 py-1 text-sm text-on-me" disabled={!questions.every(answerFor)} onClick={() => submit()}>
          Send
        </button>
      )}
    </div>
  )
}

const ICONS = {
  back: 'M15 18l-6-6 6-6',
  close: 'M18 6 6 18M6 6l12 12',
  send: 'M5 12h14M13 6l6 6-6 6',
  info: 'M12 16v-4M12 8h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18',
  mic: 'M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3M5 11a7 7 0 0 0 14 0M12 18v3',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  popout: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h6',
}
const Icon = ({ d }: { d: keyof typeof ICONS }) => (
  <svg aria-hidden viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
    <path d={ICONS[d]} />
  </svg>
)

const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

// `targetWindow` is the browsing context that actually gets the keydown/keyup events: the main
// window normally, or the PiP window when this Composer is portaled into it (its own top-level
// context, so listeners on the opener's `window` never see its keystrokes).
function Composer({ name, mentions, disabled, engine, onSend, targetWindow = window }: { name: string; mentions?: string[]; disabled: boolean; engine: Engine; onSend: (text: string) => void; targetWindow?: Window }) {
  const [text, setText] = useState('')
  const [, tick] = useState(0)
  const held = useRef(false) // recording started by holding Space
  const voice = useVoice(engine, (t, send) => (send && !disabled ? onSend(t) : setText((cur) => (cur ? `${cur} ${t}` : t))))
  const { rec } = voice
  const submit = () => {
    if (rec) return voice.stop(true) // the arrow while talking sends what you said
    const t = text.trim()
    if (!t || disabled) return
    onSend(t)
    setText('')
  }

  // Hold Space to talk (in an empty box, or with nothing focused); let go to drop the transcript in the box.
  useEffect(() => {
    if (!engine) return
    const idle = (t: EventTarget | null) => t === targetWindow.document.body || (t instanceof HTMLTextAreaElement && t.dataset.composer !== undefined && !t.value)
    const down = (e: KeyboardEvent) => {
      if (e.key !== ' ' || !idle(e.target)) return
      e.preventDefault() // a leading space is useless anyway
      if (e.repeat && !rec && !held.current) {
        held.current = true
        voice.start()
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ' && held.current) {
        held.current = false
        voice.stop(false)
      }
    }
    targetWindow.addEventListener('keydown', down)
    targetWindow.addEventListener('keyup', up)
    return () => {
      targetWindow.removeEventListener('keydown', down)
      targetWindow.removeEventListener('keyup', up)
    }
  })
  useEffect(() => {
    if (!rec) return
    const t = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [rec])

  return (
    <div className={`rule-t pb-[env(safe-area-inset-bottom)] ${rec ? 'bg-accent/30' : ''}`}>
      {mentions && (
        <div className="flex flex-wrap items-center gap-2 px-3 pt-2 text-xs">
          <span className="font-bold">Mention:</span>
          {[...mentions, 'everyone'].map((n) => (
            <button key={n} type="button" className="btn bg-panel px-2.5 py-0.5 text-ink" onClick={() => setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}@${n} `)}>
              @{n}
            </button>
          ))}
        </div>
      )}
      {voice.error && <div className="px-4 pt-2 text-xs font-bold text-alert">{voice.error}</div>}
      <form className="flex items-center gap-2 p-3" onSubmit={(e) => (e.preventDefault(), submit())}>
        {rec ? (
          <>
            <button type="button" aria-label="Cancel recording" onClick={() => voice.stop(null)} className="btn grid size-10 shrink-0 place-items-center bg-panel text-ink">
              <Icon d="close" />
            </button>
            <div className="field flex min-w-0 flex-1 items-center gap-2 px-4 py-2" aria-live="polite">
              <span className="rec-dot" aria-hidden />
              <span className="font-mono text-sm font-bold">{clock(Date.now() - rec.startedAt)}</span>
              <span className="truncate italic">{rec.text || 'Listening…'}</span>
            </div>
          </>
        ) : (
          <textarea
            rows={1}
            value={text}
            data-composer
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={`Message ${name}…${engine ? ' (hold Space to talk)' : ''}`}
            aria-label={`Message ${name}`}
            className="field max-h-40 min-w-0 flex-1 resize-none px-4 py-2"
          />
        )}
        {engine && !rec && (
          <button type="button" aria-label="Talk" title="Talk (or hold Space)" onClick={voice.start} className="btn grid size-10 shrink-0 place-items-center bg-ok text-on-accent">
            <Icon d="mic" />
          </button>
        )}
        <button type="submit" aria-label="Send" disabled={rec ? rec.busy : disabled || !text.trim()} className="btn grid size-10 shrink-0 place-items-center bg-me text-on-me">
          <Icon d="send" />
        </button>
      </form>
    </div>
  )
}

const MODELS = ['sonnet', 'opus', 'haiku']

// "Open in terminal": copies `claude --resume <id>` so the same session opens in the CLI.
function CopyButton({ text, label, className = '' }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      title={text}
      className={`btn bg-panel px-3 py-1.5 text-sm text-ink ${className}`}
      onClick={() =>
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }
    >
      {copied ? 'Copied resume command' : label}
    </button>
  )
}
type PermissionMode = (typeof PERMISSION_MODES)[number]
type ContactPatch = { displayName?: string; model?: string; cwd?: string; budgetUsd?: number; permissionMode?: PermissionMode }
const PERMISSION_LABELS: Record<PermissionMode, string> = {
  default: 'Ask me first',
  acceptEdits: 'Accept edits',
  plan: 'Plan only',
  bypassPermissions: 'Allow everything',
}
const resumeCommand = (c: Contact) => `cd "${c.cwd}" && claude --resume ${c.sessionId}`

// A spend bar: label, "$used / $cap", turns alert-colored at or over cap.
function Meter({ label, used, cap }: { label: string; used: number; cap: number }) {
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0
  const over = cap > 0 && used >= cap
  return (
    <div className="w-full text-sm">
      <div className="mb-1 flex justify-between font-bold">
        <span>{label}</span>
        <span>
          ${used.toFixed(2)} / ${cap.toFixed(2)}
        </span>
      </div>
      <div className="field h-3 overflow-hidden">
        <div className={`h-full ${over ? 'bg-alert' : 'bg-ok'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

// Right-hand panels are always shown on wide screens; on a phone they open as a drawer from the ⓘ button.
const drawer = (open: boolean) => `${open ? 'fixed inset-2 z-20 flex' : 'hidden'} lg:static lg:z-auto lg:flex`
const CloseDrawer = ({ onClose }: { onClose: () => void }) => (
  <button aria-label="Close" onClick={onClose} className="btn grid size-9 place-items-center self-end bg-panel text-ink lg:hidden">
    <Icon d="close" />
  </button>
)

// Plan's contact card: pfp, bio, the three common edits on top, engine settings below.
function ContactCard({ c, open, onClose, onSave }: { c: Contact; open: boolean; onClose: () => void; onSave: (patch: ContactPatch) => void }) {
  const [form, setForm] = useState({ displayName: c.displayName, model: c.model, cwd: c.cwd, budget: String(c.budgetUsd), permissionMode: c.permissionMode })
  const [error, setError] = useState('')
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })

  const budget = Number(form.budget)
  const patch: ContactPatch = {}
  if (form.displayName.trim() && form.displayName.trim() !== c.displayName) patch.displayName = form.displayName.trim()
  if (form.model !== c.model) patch.model = form.model
  if (form.cwd.trim() && form.cwd.trim() !== c.cwd) patch.cwd = form.cwd.trim()
  if (budget > 0 && budget !== c.budgetUsd) patch.budgetUsd = budget
  if (form.permissionMode !== c.permissionMode) patch.permissionMode = form.permissionMode as PermissionMode
  const dirty = Object.keys(patch).length > 0

  const upload = async (file?: File) => {
    if (!file) return
    setError('')
    const res = await fetch(`/api/contacts/${encodeURIComponent(c.id)}/avatar`, { method: 'POST', headers: { 'content-type': file.type }, body: file })
    if (!res.ok) setError((await res.json().catch(() => null))?.error ?? `Upload failed (${res.status})`)
  }

  return (
    <aside className={`panel ${drawer(open)} min-h-0 flex-col items-center gap-4 overflow-y-auto p-5`}>
      <CloseDrawer onClose={onClose} />
      <label className="cursor-pointer" title="Change pfp">
        <Avatar c={c} size="size-24 text-3xl" />
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" aria-label="Change pfp" onChange={(e) => upload(e.target.files?.[0])} />
      </label>
      <div className="text-center">
        <div className="title-type text-2xl font-bold">{c.displayName}</div>
        <div className="text-sm text-muted">{c.bio}</div>
      </div>
      {error && <div className="w-full bg-alert px-3 py-1 text-sm text-on-alert">{error}</div>}

      <form
        className="flex w-full flex-col gap-2 text-sm"
        onSubmit={(e) => {
          e.preventDefault()
          if (dirty) onSave(patch)
        }}
      >
        <label className="flex flex-col gap-1 font-bold">
          Name
          <input value={form.displayName} onChange={set('displayName')} maxLength={40} className="field px-3 py-1.5 font-normal" />
        </label>
        <label className="flex flex-col gap-1 font-bold">
          Model
          <select value={form.model} onChange={set('model')} className="field px-3 py-1.5 font-normal">
            {[...new Set([...MODELS, c.model])].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 font-bold">
          Folder
          <input value={form.cwd} onChange={set('cwd')} className="field px-3 py-1.5 font-mono font-normal" />
        </label>
        <label className="flex flex-col gap-1 font-bold">
          Before risky tools
          <select value={form.permissionMode} onChange={set('permissionMode')} className="field px-3 py-1.5 font-normal">
            {PERMISSION_MODES.map((p) => (
              <option key={p} value={p}>
                {PERMISSION_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 font-bold">
          Budget (USD)
          <input type="number" min="0.01" step="0.5" value={form.budget} onChange={set('budget')} className="field px-3 py-1.5 font-normal" />
        </label>
        <button type="submit" disabled={!dirty} className="btn bg-me py-1.5 text-on-me">
          Save
        </button>
        <p className="text-xs text-muted">Name and pfp change now. Model, folder, permissions and budget apply from the next message.</p>
      </form>

      <Meter label="Spent" used={c.spentUsd} cap={c.budgetUsd} />
      {c.sessionId && <CopyButton text={resumeCommand(c)} label="Open in terminal" className="mt-auto w-full" />}
    </aside>
  )
}

// Group pfps, overlapped.
function Stack({ cs, size = 'size-7 text-[10px]' }: { cs: Contact[]; size?: string }) {
  return (
    <div className="flex shrink-0 -space-x-3">
      {cs.slice(0, 3).map((c) => (
        <Avatar key={c.id} c={c} size={size} />
      ))}
    </div>
  )
}

// "Pip → Bolt  Pip handed off to Bolt"
function HandoffPill({ m, from, to }: { m: Message; from?: Contact; to?: Contact }) {
  return (
    <div className="btn flex items-center gap-1.5 self-center bg-accent px-3 py-1 text-sm text-on-accent">
      {from && <Avatar c={from} size="size-6 text-[9px]" />}
      <span aria-hidden>→</span>
      {to && <Avatar c={to} size="size-6 text-[9px]" />}
      <span className="ml-1 font-bold">{m.body.text}</span>
    </div>
  )
}

function NewGroup({ contacts, onCreate, onCancel }: { contacts: Contact[]; onCreate: (g: Extract<ClientEvent, { type: 'createGroup' }>) => void; onCancel: () => void }) {
  const [title, setTitle] = useState('')
  const [ids, setIds] = useState(contacts.map((c) => c.id))
  const [lead, setLead] = useState(contacts[0]?.id ?? '')
  const [cap, setCap] = useState('5')
  const ok = title.trim() && ids.length >= 2 && ids.includes(lead) && Number(cap) > 0
  return (
    <form
      className="field flex flex-col gap-2 p-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault()
        if (ok) onCreate({ type: 'createGroup', title: title.trim(), contactIds: ids, leadContactId: lead, hourlyCapUsd: Number(cap) })
      }}
    >
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="#group name" aria-label="Group name" maxLength={40} className="field px-2 py-1" />
      <fieldset className="flex flex-col gap-1">
        <legend className="font-bold">Members</legend>
        {contacts.map((c) => (
          <label key={c.id} className="flex items-center gap-2">
            <input type="checkbox" checked={ids.includes(c.id)} onChange={(e) => setIds(e.target.checked ? [...ids, c.id] : ids.filter((i) => i !== c.id))} />
            {c.displayName}
          </label>
        ))}
      </fieldset>
      <label className="flex flex-col gap-1 font-bold">
        Lead (gets un-mentioned posts)
        <select value={lead} onChange={(e) => setLead(e.target.value)} className="field px-2 py-1 font-normal">
          {contacts.filter((c) => ids.includes(c.id)).map((c) => (
            <option key={c.id} value={c.id}>
              {c.displayName}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 font-bold">
        Spend cap per hour (USD)
        <input type="number" min="0.01" step="0.5" value={cap} onChange={(e) => setCap(e.target.value)} className="field px-2 py-1 font-normal" />
      </label>
      <div className="flex gap-2">
        <button type="button" onClick={onCancel} className="btn flex-1 bg-panel py-1 text-ink">
          Cancel
        </button>
        <button type="submit" disabled={!ok} className="btn flex-1 bg-me py-1 text-on-me">
          Create
        </button>
      </div>
    </form>
  )
}

function GroupInfo({ t, members, open, onClose, statusOf }: { t: Thread; members: Contact[]; open: boolean; onClose: () => void; statusOf: (c: Contact) => 'Needs you' | 'Typing' | 'Idle' }) {
  const spent = t.spentHourUsd ?? 0
  return (
    <aside className={`panel ${drawer(open)} min-h-0 flex-col gap-4 overflow-y-auto p-5`}>
      <div className="flex items-center justify-between">
        <div className="title-type text-2xl font-bold">Group info</div>
        <CloseDrawer onClose={onClose} />
      </div>
      <ul className="flex flex-col gap-3">
        {members.map((c) => {
          const s = statusOf(c)
          return (
            <li key={c.id} className="flex items-center gap-3">
              <Avatar c={c} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-bold">
                  {c.displayName}
                  {c.id === t.leadContactId && <span className="ml-1 text-xs font-normal text-muted">· lead</span>}
                </div>
                <div className="text-xs text-muted">{c.agentName}</div>
              </div>
              <span className={`b-tag rounded-full px-2 text-xs ${s === 'Needs you' ? 'bg-alert text-on-alert' : s === 'Typing' ? 'bg-ok text-on-accent' : ''}`}>{s}</span>
            </li>
          )
        })}
      </ul>
      <div className="text-sm">
        Pauses after <b>{HOP_LIMIT}</b> agent-to-agent hand-offs without you.
      </div>
      {t.hourlyCapUsd !== null && <Meter label="Group spend this hour" used={spent} cap={t.hourlyCapUsd} />}
    </aside>
  )
}

const TypingBubble = ({ c, showPfp }: { c: Contact; showPfp: boolean }) => (
  <div className="flex items-end gap-2 self-start">
    {showPfp && <Avatar c={c} size="size-7 text-[10px]" />}
    <div className="bubble flex items-center gap-1 bg-them py-3 text-on-them" aria-label={`${c.displayName} is typing`}>
      <span className="dot" />
      <span className="dot" />
      <span className="dot" />
    </div>
  </div>
)

const PINGS_LABEL: Record<Exclude<Pings, 'unsupported'>, string> = {
  off: 'Turn on pings',
  local: 'Pings on (this tab)',
  push: 'Pings on',
  blocked: 'Pings blocked in browser settings',
}
const IS_IOS = /iPhone|iPad/.test(navigator.userAgent)

// Pull-to-enable pings: a push subscription when the browser supports it, else the in-tab fallback.
function PingsToggle({ pings, cfg, onChange }: { pings: Pings; cfg: Config | null; onChange: (p: Pings) => void }) {
  const label = pings === 'unsupported' ? (IS_IOS ? 'Add gcnb to your Home Screen for pings' : 'No notifications in this browser') : PINGS_LABEL[pings]
  const clickable = pings === 'off' || pings === 'local'
  return (
    <button
      disabled={!clickable}
      onClick={() => enablePings(cfg).then(onChange)}
      className="btn flex items-center gap-2 bg-panel px-3 py-2 text-left text-sm text-ink disabled:opacity-70"
    >
      <Icon d="bell" />
      <span className="min-w-0 flex-1">{label}</span>
    </button>
  )
}

// Reads ?t=<threadId> once (a notification deep link), then strips it from the URL.
function initialDeepLinkThread(): string | null {
  const u = new URL(location.href)
  const t = u.searchParams.get('t')
  if (t) {
    u.searchParams.delete('t')
    history.replaceState(null, '', u)
  }
  return t
}

export default function App() {
  const [cfg, setCfg] = useState<Config | null>(null)
  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then(setCfg)
      .catch(() => {})
  }, [])

  const [pings, setPings] = useState<Pings>('off')
  useEffect(() => {
    currentPings().then(setPings)
  }, [])

  const [themeId, setThemeId] = useTheme()
  const [threadId, setThreadId] = useState<string | null>(initialDeepLinkThread)
  const [view, setView] = useState<'list' | 'chat'>(() => (threadId ? 'chat' : 'list'))
  const [creating, setCreating] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'groups' | 'needs'>('all')
  const [seen, setSeen] = useState<Record<string, number>>(() => load('gcnb.seen', {}))
  const md = useMedia('(min-width: 768px)')
  const pageVisible = usePageVisible()
  const scroller = useRef<HTMLDivElement>(null)

  // Pop-out mini chat (Document Picture-in-Picture): its own view/thread, remembered only in state.
  const pip = usePip()
  const [pipView, setPipView] = useState<'list' | 'chat'>('list')
  const [pipThreadId, setPipThreadId] = useState<string | null>(null)
  const pipScroller = useRef<HTMLDivElement>(null)

  const selectThread = (id: string) => {
    setThreadId(id)
    setView('chat')
    setInfoOpen(false)
  }

  // Local-notification fallback while the tab is hidden: push already covers the rest. Refs keep this
  // callback (handed to useGcnb before `state` exists) reading the latest contacts/threads and pings mode.
  const stateRef = useRef<State>(initial)
  const pingsRef = useRef<Pings>(pings)
  pingsRef.current = pings
  const onEvent = (e: ServerEvent) => {
    if (pingsRef.current !== 'local' || !document.hidden || e.type !== 'message') return
    const nameOf = (id: string) => stateRef.current.contacts.find((c) => c.id === id)?.displayName ?? id
    const th = stateRef.current.threads.find((t) => t.id === e.message.threadId)
    const note = noteFor(e.message, nameOf, th?.kind === 'group' ? th.title : undefined)
    if (note) localNotify(note, selectThread)
  }
  // While the PiP is open it counts as "on screen" even if this tab is hidden, so phone push stays quiet.
  const pipOpenRef = useRef(false)
  const { state, emit } = useGcnb(onEvent, pipOpenRef)
  stateRef.current = state
  useEffect(() => {
    pipOpenRef.current = !!pip.win
    emit({ type: 'visible', on: pipOpenRef.current || !document.hidden })
  }, [pip.win])

  useEffect(() => onOpenThread(selectThread), [])

  const byId = (id?: string | null) => state.contacts.find((c) => c.id === id)
  const membersOf = (t: Thread) => t.contactIds.map(byId).filter((c): c is Contact => !!c)
  const thread = state.threads.find((t) => t.id === threadId) ?? state.threads[0]
  const isGroup = thread?.kind === 'group'
  const members = thread ? membersOf(thread) : []
  const contact = isGroup ? undefined : members[0] // the DM's contact
  const agent = contact && state.agents[contact.id]
  const messages = state.messages.filter((m) => m.threadId === thread?.id)
  const lastUserId = messages.findLast((m) => m.sender === 'user')?.id

  // Typing is per contact, tagged with the thread its turn belongs to.
  const typingIn = (tid: string) => state.typing.filter((t) => t.threadId === tid).map((t) => t.contactId)
  const typers = thread ? membersOf(thread).filter((c) => typingIn(thread.id).includes(c.id)) : []
  // "Needs you": an open approval/question card. Drives the unread dot, status pill and Y/N keys.
  const isOpenCard = (m: Message) => (m.kind === 'approval' || m.kind === 'question') && m.body.status === 'pending'
  const threadNeedsYou = (tid: string) => state.messages.some((m) => m.threadId === tid && isOpenCard(m))
  const waiting = !!thread && threadNeedsYou(thread.id)
  const statusOf = (c: Contact) =>
    messages.some((m) => m.contactId === c.id && isOpenCard(m)) ? 'Needs you' : typers.includes(c) ? 'Typing' : 'Idle'
  const busy = members.filter((c) => statusOf(c) !== 'Idle')
  const answer = (m: Message) => (a: Answer) => emit({ type: 'answer', actionId: m.body.actionId!, ...a })

  // Unread: agent replies newer than the later of "last time this thread was on screen" and first run.
  const unreadCount = (tid: string) =>
    state.messages.filter((m) => m.threadId === tid && m.sender === 'agent' && m.kind === 'text' && m.createdAt > Math.max(seen[tid] ?? 0, SEEN_SINCE)).length

  const chatOnScreen = !!thread && (md || view === 'chat')
  useEffect(() => {
    if (!thread || !chatOnScreen || !pageVisible) return
    setSeen((s) => {
      const next = { ...s, [thread.id]: Date.now() }
      save('gcnb.seen', next)
      return next
    })
  }, [thread?.id, chatOnScreen, pageVisible, messages.length])

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [messages.length, typers.length, waiting])

  // The PiP's own thread (independent of the main window's) — falls back to the main thread once, so
  // Pop out from the chat header opens straight into what you were already looking at.
  const pipThread = state.threads.find((t) => t.id === pipThreadId) ?? (pipThreadId === null ? thread : undefined)
  const pipIsGroup = pipThread?.kind === 'group'
  const pipMembers = pipThread ? membersOf(pipThread) : []
  const pipContact = pipIsGroup ? undefined : pipMembers[0]
  const pipMessages = state.messages.filter((m) => m.threadId === pipThread?.id)
  const pipLastUserId = pipMessages.findLast((m) => m.sender === 'user')?.id
  const pipTypers = pipThread ? membersOf(pipThread).filter((c) => typingIn(pipThread.id).includes(c.id)) : []

  // The PiP's open thread counts as "on screen" for unread purposes whenever the PiP is open and
  // showing it, same idea as `chatOnScreen` above but independent of this tab's own visibility.
  useEffect(() => {
    if (!pip.win || pipView !== 'chat' || !pipThread) return
    setSeen((s) => {
      const next = { ...s, [pipThread.id]: Date.now() }
      save('gcnb.seen', next)
      return next
    })
  }, [pip.win, pipView, pipThread?.id, pipMessages.length])

  useEffect(() => {
    pipScroller.current?.scrollTo({ top: pipScroller.current.scrollHeight })
  }, [pipMessages.length, pipTypers.length])

  // A card newly needing you jumps the PiP to that thread, but only while it was sitting on the list
  // (don't yank someone off a chat they're mid-read of for a *different* thread's card).
  const prevNeedsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const now = new Set(state.threads.filter((t) => threadNeedsYou(t.id)).map((t) => t.id))
    if (pip.win && pipView === 'list') {
      const fresh = [...now].find((id) => !prevNeedsRef.current.has(id))
      if (fresh) {
        setPipThreadId(fresh)
        setPipView('chat')
      }
    }
    prevNeedsRef.current = now
  }, [state.messages.length, pip.win, pipView])

  // Fitts's law: Y allows once, N denies the newest open approval card (not while typing in a field).
  // Listens on the PiP window too, since its keystrokes never reach the opener's `window`.
  const openApproval = messages.findLast((m) => m.kind === 'approval' && m.body.status === 'pending')
  useEffect(() => {
    if (!openApproval) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return
      const decision = e.key.toLowerCase() === 'y' ? 'allow' : e.key.toLowerCase() === 'n' ? 'deny' : null
      if (decision) answer(openApproval)({ decision })
    }
    const targets = pip.win ? [window, pip.win] : [window]
    targets.forEach((w) => w.addEventListener('keydown', onKey))
    return () => targets.forEach((w) => w.removeEventListener('keydown', onKey))
  })

  const openPip = (toCurrentChat: boolean) => {
    if (toCurrentChat && thread) {
      setPipThreadId(thread.id)
      setPipView('chat')
    }
    pip.open()
  }

  const status = !state.connected
    ? 'Reconnecting…'
    : waiting
      ? 'Waiting on you'
      : typers.length
        ? isGroup
          ? `${typers.map((c) => c.displayName).join(', ')} typing…`
          : 'Typing…'
        : isGroup
          ? 'Idle'
          : agent?.live
            ? 'Online'
            : 'Offline'
  const statusTone = waiting ? 'bg-accent text-on-accent' : !state.connected || (!isGroup && !agent?.live) ? 'bg-alert text-on-alert' : 'bg-ok text-on-accent'

  const preview = (t: Thread) => {
    if (threadNeedsYou(t.id)) return <b>Needs you</b>
    const typing = membersOf(t).filter((c) => typingIn(t.id).includes(c.id))
    if (typing.length) return <i>{t.kind === 'group' ? `${typing[0].displayName} is typing…` : 'typing…'}</i>
    const last = state.messages.findLast((m) => m.threadId === t.id)
    if (!last) return 'Say hi'
    return t.kind === 'group' && last.sender === 'agent' ? `${byId(last.contactId)?.displayName}: ${last.body.text}` : last.body.text
  }

  // Sidebar: search by title / member name / agent, pill filters, sorted by latest message.
  const lastTime = (t: Thread) => state.messages.findLast((m) => m.threadId === t.id)?.createdAt ?? t.createdAt
  const matchesQuery = (t: Thread) => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return t.title.toLowerCase().includes(q) || membersOf(t).some((c) => c.displayName.toLowerCase().includes(q) || c.agentName.toLowerCase().includes(q))
  }
  const needsCount = state.threads.filter((t) => threadNeedsYou(t.id)).length
  const visibleThreads = state.threads
    .filter((t) => (filter === 'groups' ? t.kind === 'group' : filter === 'needs' ? threadNeedsYou(t.id) : true))
    .filter(matchesQuery)
    .sort((a, b) => lastTime(b) - lastTime(a))
  const FILTERS = [
    ['all', 'All'],
    ['groups', 'Groups'],
    ['needs', `Needs you · ${needsCount}`],
  ] as const

  const totalSpent = state.contacts.reduce((s, c) => s + c.spentUsd, 0)
  const totalBudget = state.contacts.reduce((s, c) => s + c.budgetUsd, 0)

  // A message row, with the date pill and date-aware grouping stripped out of the big ol' kind switch.
  // Factored so the PiP mini window can render the same rows for whatever thread it's showing,
  // which isn't necessarily this one (hence isGroup/lastUserId as params, not closed-over).
  const renderMessageFor = (grp: boolean, lastUserIdVal: string | undefined) => (m: Message) => {
    const who = byId(m.contactId)
    if (m.body.handoff) return <HandoffPill m={m} from={byId(m.body.handoff.from)} to={byId(m.body.handoff.to)} />
    if (m.kind === 'tool') return <ToolLine m={m} c={grp ? who : undefined} />
    if (m.kind === 'approval') return <ApprovalCard m={m} onAnswer={answer(m)} />
    if (m.kind === 'question') return <QuestionCard m={m} onAnswer={answer(m)} />
    // In a group, agent bubbles carry their pfp and name.
    if (grp && m.sender === 'agent' && who)
      return (
        <div className="flex max-w-[85%] items-end gap-2 self-start">
          <Avatar c={who} size="size-7 text-[10px]" />
          <div className="flex min-w-0 flex-col">
            <div className="mb-1 text-xs font-bold">
              {who.displayName} <span className="font-normal text-muted">· {who.agentName}</span>
            </div>
            <Bubble m={m} showReceipt={false} />
          </div>
        </div>
      )
    return <Bubble m={m} showReceipt={m.id === lastUserIdVal} />
  }
  const renderMessage = renderMessageFor(isGroup, lastUserId)

  return (
    <div className="grid h-dvh grid-cols-1 gap-2 p-2 md:grid-cols-[260px_1fr] md:gap-3 md:p-3 lg:grid-cols-[260px_1fr_280px]">
      <aside className={`panel min-h-0 flex-col gap-3 p-3 md:flex md:gap-4 md:p-4 ${view === 'list' ? 'flex' : 'hidden'}`}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="title-type text-3xl font-bold">gcnb</div>
            <div className="text-xs text-muted">gc, no burger</div>
          </div>
          <div className="flex items-center gap-1.5">
            {pip.supported && (
              <button
                aria-label="Pop out mini chat"
                title="Pop out: an always-on-top mini window"
                onClick={() => openPip(false)}
                className="btn grid size-10 shrink-0 place-items-center bg-panel text-ink"
              >
                <Icon d="popout" />
              </button>
            )}
            <button className="btn bg-accent px-2.5 py-1 text-sm text-on-accent" onClick={() => setCreating(!creating)} aria-expanded={creating}>
              + Group
            </button>
          </div>
        </div>
        {creating && (
          <NewGroup
            contacts={state.contacts}
            onCancel={() => setCreating(false)}
            onCreate={(g) => {
              emit(g)
              setCreating(false)
            }}
          />
        )}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats"
          aria-label="Search chats"
          className="field px-3 py-2 text-sm"
        />
        <div className="flex flex-wrap gap-1.5 text-xs" role="group" aria-label="Filter chats">
          {FILTERS.map(([id, label]) => (
            <button
              key={id}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
              className={`btn px-2.5 py-1 font-bold ${filter === id ? 'bg-accent text-on-accent' : 'bg-panel text-ink'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto" aria-label="Chats">
          {visibleThreads.map((t) => {
            const ms = membersOf(t)
            const c = t.kind === 'dm' ? ms[0] : undefined
            const last = state.messages.findLast((m) => m.threadId === t.id)
            const active = t.id === thread?.id
            const unread = unreadCount(t.id)
            return (
              <button
                key={t.id}
                onClick={() => selectThread(t.id)}
                aria-current={active}
                className={`flex min-h-10 items-center gap-3 rounded-bubble p-2 text-left ${active ? 'btn bg-accent text-on-accent' : ''}`}
              >
                <div className="relative">
                  {c ? <Avatar c={c} /> : <Stack cs={ms} />}
                  {threadNeedsYou(t.id) && <span className="absolute -right-0.5 -bottom-0.5 size-3.5 rounded-full bg-alert b-tag" aria-label="needs you" />}
                  {unread > 0 && (
                    <span className="btn absolute -top-1 -right-1 grid size-5 place-items-center rounded-full bg-alert px-1 text-[10px] text-on-alert" aria-label={`${unread} unread`}>
                      {unread > 9 ? '9+' : unread}
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex justify-between gap-2">
                    <span className="truncate font-bold">
                      {c ? c.displayName : `#${t.title}`}
                      <span className="b-tag ml-1.5 rounded-full px-1.5 text-[10px] font-normal opacity-70">{c ? c.agentName : 'group'}</span>
                    </span>
                    <span className="shrink-0 text-xs opacity-70">{last && time(last.createdAt)}</span>
                  </div>
                  <div className="truncate text-sm opacity-80">{preview(t)}</div>
                </div>
              </button>
            )
          })}
          {visibleThreads.length === 0 && <div className="p-2 text-sm text-muted">No chats match</div>}
        </nav>
        <div className="flex flex-col gap-2">
          <Meter label="Spent so far" used={totalSpent} cap={totalBudget} />
          <PingsToggle pings={pings} cfg={cfg} onChange={setPings} />
          <label className="flex flex-col gap-1 text-xs font-bold">
            Theme
            <select value={themeId} onChange={(e) => setThemeId(e.target.value)} className="field px-3 py-2 text-sm">
              <option value="auto">Auto (light / dark)</option>
              {Object.entries(themes).map(([id, t]) => (
                <option key={id} value={id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </aside>

      <main className={`panel min-h-0 flex-col overflow-hidden md:flex ${view === 'chat' ? 'flex' : 'hidden'}`}>
        {thread && members.length ? (
          <>
            <header className="rule-b flex items-center gap-2 p-3 md:gap-3 md:p-4">
              <button aria-label="Back to chats" onClick={() => setView('list')} className="btn grid size-10 shrink-0 place-items-center bg-panel text-ink md:hidden">
                <Icon d="back" />
              </button>
              {contact ? <Avatar c={contact} /> : <Stack cs={members} size="size-9 text-xs" />}
              <div className="min-w-0 flex-1">
                <div className="title-type truncate text-xl font-bold">{contact ? contact.displayName : `#${thread.title}`}</div>
                <div className="truncate text-xs text-muted">
                  {contact ? (
                    <>
                      working in <span className="font-mono">{contact.cwd}</span>
                    </>
                  ) : (
                    `${members.map((c) => c.displayName).join(', ')} and you · lead: ${byId(thread.leadContactId)?.displayName ?? '—'}`
                  )}
                </div>
              </div>
              <span className={`btn hidden shrink-0 px-3 py-1 text-xs sm:inline-block ${statusTone}`}>{status}</span>
              {contact?.sessionId && <CopyButton text={resumeCommand(contact)} label="Open in terminal" className="hidden sm:block" />}
              {busy.length > 0 && (
                <button className="btn shrink-0 bg-alert px-3 py-1.5 text-sm text-on-alert" onClick={() => busy.forEach((c) => emit({ type: 'interrupt', contactId: c.id }))}>
                  {isGroup ? '❚❚ Pause all' : '■ Stop'}
                </button>
              )}
              {pip.supported && (
                <button
                  aria-label="Pop out mini chat"
                  title="Pop out: an always-on-top mini window"
                  onClick={() => openPip(true)}
                  className="btn grid size-10 shrink-0 place-items-center bg-panel text-ink"
                >
                  <Icon d="popout" />
                </button>
              )}
              <button aria-label="Chat info" onClick={() => setInfoOpen(true)} className="btn grid size-10 shrink-0 place-items-center bg-panel text-ink lg:hidden">
                <Icon d="info" />
              </button>
            </header>
            <div ref={scroller} className="wallpaper flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4" aria-live="polite">
              {messages.map((m, i) => (
                <Fragment key={m.id}>
                  {(i === 0 || m.createdAt - messages[i - 1].createdAt > 1_800_000) && <DatePill ms={m.createdAt} />}
                  {renderMessage(m)}
                </Fragment>
              ))}
              {typers.map((c) => (
                <TypingBubble key={c.id} c={c} showPfp={isGroup} />
              ))}
            </div>
            {agent && !agent.live && <div className="bg-alert px-4 py-2 text-sm font-bold text-on-alert">{agent.reason}</div>}
            <Composer
              name={contact ? contact.displayName : `#${thread.title}`}
              mentions={isGroup ? members.map((c) => c.displayName) : undefined}
              disabled={!state.connected}
              engine={voiceEngine(cfg?.whisper ?? false)}
              onSend={(text) => emit({ type: 'send', threadId: thread.id, text })}
            />
          </>
        ) : (
          <div className="grid flex-1 place-items-center text-muted">{state.connected ? 'No chats yet' : 'Connecting to gcnb server…'}</div>
        )}
      </main>

      {thread && isGroup && <GroupInfo t={thread} members={members} statusOf={statusOf} open={infoOpen} onClose={() => setInfoOpen(false)} />}
      {contact && (
        <ContactCard
          key={contact.id}
          c={contact}
          open={infoOpen}
          onClose={() => setInfoOpen(false)}
          onSave={(patch) => emit({ type: 'updateContact', contactId: contact.id, ...patch })}
        />
      )}

      {pip.win &&
        createPortal(
          <div className="flex h-dvh min-h-0 flex-col bg-app text-ink">
            {pipView === 'chat' && pipThread && pipMembers.length ? (
              <>
                <header className="rule-b flex items-center gap-2 p-2">
                  <button aria-label="Back to chats" onClick={() => setPipView('list')} className="btn grid size-10 shrink-0 place-items-center bg-panel text-ink">
                    <Icon d="back" />
                  </button>
                  {pipContact ? <Avatar c={pipContact} size="size-8" /> : <Stack cs={pipMembers} size="size-6 text-[9px]" />}
                  <div className="min-w-0 flex-1">
                    <div className="title-type truncate text-sm font-bold">{pipContact ? pipContact.displayName : `#${pipThread.title}`}</div>
                    <div className="truncate text-xs text-muted">{threadNeedsYou(pipThread.id) ? 'Waiting on you' : pipTypers.length ? 'Typing…' : (pipContact?.agentName ?? 'group')}</div>
                  </div>
                  <button aria-label="Expand to full window" title="Expand" onClick={() => (window.focus(), pip.close())} className="btn shrink-0 bg-panel px-3 py-1.5 text-sm text-ink">
                    Expand
                  </button>
                </header>
                <div ref={pipScroller} className="wallpaper flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3" aria-live="polite">
                  {pipMessages.map((m, i) => (
                    <Fragment key={m.id}>
                      {(i === 0 || m.createdAt - pipMessages[i - 1].createdAt > 1_800_000) && <DatePill ms={m.createdAt} />}
                      {renderMessageFor(pipIsGroup, pipLastUserId)(m)}
                    </Fragment>
                  ))}
                  {pipTypers.map((c) => (
                    <TypingBubble key={c.id} c={c} showPfp={pipIsGroup} />
                  ))}
                </div>
                <Composer
                  name={pipContact ? pipContact.displayName : `#${pipThread.title}`}
                  mentions={pipIsGroup ? pipMembers.map((c) => c.displayName) : undefined}
                  disabled={!state.connected}
                  engine={voiceEngine(cfg?.whisper ?? false)}
                  targetWindow={pip.win}
                  onSend={(text) => emit({ type: 'send', threadId: pipThread.id, text })}
                />
              </>
            ) : (
              <>
                <header className="rule-b flex items-center justify-between gap-2 p-2">
                  <div className="title-type text-lg font-bold">gcnb</div>
                  <button aria-label="Expand to full window" title="Expand" onClick={() => (window.focus(), pip.close())} className="btn shrink-0 bg-panel px-3 py-1.5 text-sm text-ink">
                    Expand
                  </button>
                </header>
                <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2" aria-label="Chats">
                  {visibleThreads.map((t) => {
                    const ms = membersOf(t)
                    const c = t.kind === 'dm' ? ms[0] : undefined
                    const unread = unreadCount(t.id)
                    return (
                      <button
                        key={t.id}
                        onClick={() => {
                          setPipThreadId(t.id)
                          setPipView('chat')
                        }}
                        className="flex min-h-10 items-center gap-2 rounded-bubble p-2 text-left"
                      >
                        <div className="relative">
                          {c ? <Avatar c={c} size="size-8" /> : <Stack cs={ms} size="size-6 text-[9px]" />}
                          {threadNeedsYou(t.id) && <span className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full bg-alert b-tag" aria-label="needs you" />}
                          {unread > 0 && (
                            <span className="btn absolute -top-1 -right-1 grid size-4 place-items-center rounded-full bg-alert px-1 text-[9px] text-on-alert" aria-label={`${unread} unread`}>
                              {unread > 9 ? '9+' : unread}
                            </span>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-bold">{c ? c.displayName : `#${t.title}`}</div>
                          <div className="truncate text-xs opacity-80">{preview(t)}</div>
                        </div>
                      </button>
                    )
                  })}
                  {visibleThreads.length === 0 && <div className="p-2 text-sm text-muted">No chats match</div>}
                </nav>
              </>
            )}
          </div>,
          pip.win.document.body,
        )}
    </div>
  )
}


import { useEffect, useReducer, useRef, useState } from 'react'
import { PERMISSION_MODES, ServerEvent, type AgentState, type ClientEvent, type Contact, type Decision, type Message, type Question, type Thread } from '@gcnb/shared'
import { applyTheme, themes } from './theme.ts'

type State = {
  connected: boolean
  contacts: Contact[]
  threads: Thread[]
  messages: Message[]
  agents: Record<string, AgentState>
  typing: string[]
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
    case 'typing':
      return { ...s, typing: e.on ? [...new Set([...s.typing, e.contactId])] : s.typing.filter((id) => id !== e.contactId) }
    case 'agent':
      return { ...s, agents: { ...s.agents, [e.agent.contactId]: e.agent } }
    case 'contact':
      return { ...s, contacts: s.contacts.map((c) => (c.id === e.contact.id ? e.contact : c)) }
  }
}

// One socket to the server; reconnects every second and gets a fresh snapshot on open.
function useGcnb() {
  const [state, dispatch] = useReducer(reduce, initial)
  const ws = useRef<WebSocket | null>(null)
  useEffect(() => {
    let stopped = false
    let timer = 0
    const connect = () => {
      const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
      ws.current = sock
      sock.onopen = () => dispatch({ type: 'connected', on: true })
      sock.onmessage = (m) => {
        const parsed = ServerEvent.safeParse(JSON.parse(m.data))
        if (parsed.success) dispatch(parsed.data)
        else console.warn('bad server event', parsed.error)
      }
      sock.onclose = () => {
        dispatch({ type: 'connected', on: false })
        if (!stopped) timer = window.setTimeout(connect, 1000)
      }
    }
    connect()
    return () => {
      stopped = true
      clearTimeout(timer)
      ws.current?.close()
    }
  }, [])
  const emit = (ev: ClientEvent) => ws.current?.send(JSON.stringify(ev))
  return { state, emit }
}

function useTheme() {
  const [id, setId] = useState(() => {
    try {
      const saved = localStorage.getItem('gcnb.theme')
      if (saved && themes[saved]) return saved
    } catch {}
    return 'cartoon'
  })
  useEffect(() => {
    applyTheme(themes[id])
    try {
      localStorage.setItem('gcnb.theme', id)
    } catch {}
  }, [id])
  return [id, setId] as const
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

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
function ToolLine({ m }: { m: Message }) {
  return <div className="b-dashed self-start rounded-button px-3 py-0.5 font-mono text-xs text-muted">{m.body.text}</div>
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
    <div role="group" aria-label={b.text} className="bubble flex w-full max-w-md flex-col gap-2 self-start bg-them text-on-them">
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

function Composer({ name, disabled, onSend }: { name: string; disabled: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('')
  const submit = () => {
    const t = text.trim()
    if (!t || disabled) return
    onSend(t)
    setText('')
  }
  return (
    <form className="rule-t flex gap-2 p-3" onSubmit={(e) => (e.preventDefault(), submit())}>
      <textarea
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder={`Message ${name}…`}
        aria-label={`Message ${name}`}
        className="field max-h-40 flex-1 resize-none px-4 py-2"
      />
      <button type="submit" disabled={disabled || !text.trim()} className="btn bg-me px-5 text-on-me">
        Send
      </button>
    </form>
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

// Plan's contact card: pfp, bio, the three common edits on top, engine settings below.
function ContactCard({ c, onSave }: { c: Contact; onSave: (patch: ContactPatch) => void }) {
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
    <aside className="panel hidden min-h-0 flex-col items-center gap-4 overflow-y-auto p-5 lg:flex">
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

      <div className="w-full text-sm">
        <div className="mb-1 flex justify-between font-bold">
          <span>Spent</span>
          <span>${c.spentUsd.toFixed(2)} / ${c.budgetUsd.toFixed(2)}</span>
        </div>
        <div className="field h-3 overflow-hidden">
          <div className="h-full bg-ok" style={{ width: `${Math.min(100, (c.spentUsd / c.budgetUsd) * 100)}%` }} />
        </div>
      </div>
      {c.sessionId && <CopyButton text={resumeCommand(c)} label="Open in terminal" className="mt-auto w-full" />}
    </aside>
  )
}

export default function App() {
  const { state, emit } = useGcnb()
  const [themeId, setThemeId] = useTheme()
  const [threadId, setThreadId] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)

  const thread = state.threads.find((t) => t.id === threadId) ?? state.threads[0]
  const contactOf = (t: Thread) => state.contacts.find((c) => c.id === t.contactIds[0])
  const contact = thread && contactOf(thread)
  const agent = contact && state.agents[contact.id]
  const typing = !!contact && state.typing.includes(contact.id)
  const messages = state.messages.filter((m) => m.threadId === thread?.id)
  const lastUserId = messages.findLast((m) => m.sender === 'user')?.id
  // "Needs you": an open approval/question card. Drives the unread dot, status pill and Y/N keys.
  const isOpenCard = (m: Message) => (m.kind === 'approval' || m.kind === 'question') && m.body.status === 'pending'
  const needsYou = (contactId: string) => state.messages.some((m) => m.contactId === contactId && isOpenCard(m))
  const waiting = !!contact && needsYou(contact.id)
  const answer = (m: Message) => (a: Answer) => emit({ type: 'answer', actionId: m.body.actionId!, ...a })

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [messages.length, typing, waiting])

  // Fitts's law: Y allows once, N denies the newest open approval card (not while typing in a field).
  const openApproval = messages.findLast((m) => m.kind === 'approval' && m.body.status === 'pending')
  useEffect(() => {
    if (!openApproval) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return
      const decision = e.key.toLowerCase() === 'y' ? 'allow' : e.key.toLowerCase() === 'n' ? 'deny' : null
      if (decision) answer(openApproval)({ decision })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const status = !state.connected ? 'Reconnecting…' : waiting ? 'Waiting on you' : typing ? 'Typing…' : agent?.live ? 'Online' : 'Offline'

  return (
    <div className="grid h-dvh grid-cols-1 gap-3 p-3 md:grid-cols-[260px_1fr] lg:grid-cols-[260px_1fr_280px]">
      <aside className="panel hidden min-h-0 flex-col gap-4 p-4 md:flex">
        <div>
          <div className="title-type text-3xl font-bold">gcnb</div>
          <div className="text-xs text-muted">gc, no burger</div>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto" aria-label="Chats">
          {state.threads.map((t) => {
            const c = contactOf(t)
            const last = state.messages.findLast((m) => m.threadId === t.id)
            const active = t.id === thread?.id
            return (
              <button
                key={t.id}
                onClick={() => setThreadId(t.id)}
                aria-current={active}
                className={`flex items-center gap-3 rounded-bubble p-2 text-left ${active ? 'btn bg-accent text-on-accent' : ''}`}
              >
                {c && (
                  <div className="relative">
                    <Avatar c={c} />
                    {needsYou(c.id) && <span className="absolute -right-0.5 -bottom-0.5 size-3.5 rounded-full bg-alert b-tag" aria-label="needs you" />}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex justify-between gap-2">
                    <span className="truncate font-bold">
                      {c?.displayName ?? t.title}
                      {c && <span className="ml-1.5 rounded-full px-1.5 text-[10px] font-normal opacity-70 b-tag">{c.agentName}</span>}
                    </span>
                    <span className="shrink-0 text-xs opacity-70">{last && time(last.createdAt)}</span>
                  </div>
                  <div className="truncate text-sm opacity-80">
                    {c && needsYou(c.id) ? <b>Needs you</b> : c && state.typing.includes(c.id) ? <i>typing…</i> : (last?.body.text ?? 'Say hi')}
                  </div>
                </div>
              </button>
            )
          })}
        </nav>
        <label className="flex flex-col gap-1 text-xs font-bold">
          Theme
          <select value={themeId} onChange={(e) => setThemeId(e.target.value)} className="field px-3 py-2 text-sm">
            {Object.entries(themes).map(([id, t]) => (
              <option key={id} value={id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </aside>

      <main className="panel flex min-h-0 flex-col overflow-hidden">
        {contact && thread ? (
          <>
            <header className="rule-b flex items-center gap-3 p-4">
              <Avatar c={contact} />
              <div className="min-w-0 flex-1">
                <div className="title-type text-xl font-bold">{contact.displayName}</div>
                <div className="truncate text-xs text-muted">
                  working in <span className="font-mono">{contact.cwd}</span>
                </div>
              </div>
              <span
                className={`btn px-3 py-1 text-xs ${waiting ? 'bg-accent text-on-accent' : agent?.live && state.connected ? 'bg-ok text-on-accent' : 'bg-alert text-on-alert'}`}
              >
                {status}
              </span>
              {contact.sessionId && <CopyButton text={resumeCommand(contact)} label="Open in terminal" className="hidden sm:block" />}
              {(typing || waiting) && (
                <button className="btn bg-alert px-3 py-1.5 text-sm text-on-alert" onClick={() => emit({ type: 'interrupt', contactId: contact.id })}>
                  ■ Stop
                </button>
              )}
            </header>
            <div ref={scroller} className="wallpaper flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4" aria-live="polite">
              {messages.map((m) =>
                m.kind === 'tool' ? (
                  <ToolLine key={m.id} m={m} />
                ) : m.kind === 'approval' ? (
                  <ApprovalCard key={m.id} m={m} onAnswer={answer(m)} />
                ) : m.kind === 'question' ? (
                  <QuestionCard key={m.id} m={m} onAnswer={answer(m)} />
                ) : (
                  <Bubble key={m.id} m={m} showReceipt={m.id === lastUserId} />
                ),
              )}
              {typing && (
                <div className="bubble flex items-center gap-1 self-start bg-them py-3 text-on-them" aria-label={`${contact.displayName} is typing`}>
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                </div>
              )}
            </div>
            {agent && !agent.live && <div className="bg-alert px-4 py-2 text-sm font-bold text-on-alert">{agent.reason}</div>}
            <Composer name={contact.displayName} disabled={!state.connected} onSend={(text) => emit({ type: 'send', threadId: thread.id, text })} />
          </>
        ) : (
          <div className="grid flex-1 place-items-center text-muted">{state.connected ? 'No chats yet' : 'Connecting to gcnb server…'}</div>
        )}
      </main>

      {contact && (
        <ContactCard key={contact.id} c={contact} onSave={(patch) => emit({ type: 'updateContact', contactId: contact.id, ...patch })} />
      )}
    </div>
  )
}

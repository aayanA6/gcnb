import { useEffect, useReducer, useRef, useState } from 'react'
import { HOP_LIMIT, PERMISSION_MODES, ServerEvent, type AgentState, type ClientEvent, type Contact, type Decision, type Message, type Question, type Thread, type Typing } from '@gcnb/shared'
import { applyTheme, themes } from './theme.ts'

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

function Composer({ name, mentions, disabled, onSend }: { name: string; mentions?: string[]; disabled: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('')
  const submit = () => {
    const t = text.trim()
    if (!t || disabled) return
    onSend(t)
    setText('')
  }
  return (
    <div className="rule-t">
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
    <form className="flex gap-2 p-3" onSubmit={(e) => (e.preventDefault(), submit())}>
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

function GroupInfo({ t, members, statusOf }: { t: Thread; members: Contact[]; statusOf: (c: Contact) => 'Needs you' | 'Typing' | 'Idle' }) {
  const spent = t.spentHourUsd ?? 0
  return (
    <aside className="panel hidden min-h-0 flex-col gap-4 overflow-y-auto p-5 lg:flex">
      <div className="title-type text-2xl font-bold">Group info</div>
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
      {t.hourlyCapUsd !== null && (
        <div className="w-full text-sm">
          <div className="mb-1 flex justify-between font-bold">
            <span>Group spend this hour</span>
            <span>
              ${spent.toFixed(2)} / ${t.hourlyCapUsd.toFixed(2)}
            </span>
          </div>
          <div className="field h-3 overflow-hidden">
            <div className="h-full bg-ok" style={{ width: `${Math.min(100, (spent / t.hourlyCapUsd) * 100)}%` }} />
          </div>
        </div>
      )}
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

export default function App() {
  const { state, emit } = useGcnb()
  const [themeId, setThemeId] = useTheme()
  const [threadId, setThreadId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [messages.length, typers.length, waiting])

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

  return (
    <div className="grid h-dvh grid-cols-1 gap-3 p-3 md:grid-cols-[260px_1fr] lg:grid-cols-[260px_1fr_280px]">
      <aside className="panel hidden min-h-0 flex-col gap-4 p-4 md:flex">
        <div className="flex items-start justify-between">
          <div>
            <div className="title-type text-3xl font-bold">gcnb</div>
            <div className="text-xs text-muted">gc, no burger</div>
          </div>
          <button className="btn bg-accent px-2.5 py-1 text-sm text-on-accent" onClick={() => setCreating(!creating)} aria-expanded={creating}>
            + Group
          </button>
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
        <nav className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto" aria-label="Chats">
          {state.threads.map((t) => {
            const ms = membersOf(t)
            const c = t.kind === 'dm' ? ms[0] : undefined
            const last = state.messages.findLast((m) => m.threadId === t.id)
            const active = t.id === thread?.id
            return (
              <button
                key={t.id}
                onClick={() => setThreadId(t.id)}
                aria-current={active}
                className={`flex items-center gap-3 rounded-bubble p-2 text-left ${active ? 'btn bg-accent text-on-accent' : ''}`}
              >
                <div className="relative">
                  {c ? <Avatar c={c} /> : <Stack cs={ms} />}
                  {threadNeedsYou(t.id) && <span className="absolute -right-0.5 -bottom-0.5 size-3.5 rounded-full bg-alert b-tag" aria-label="needs you" />}
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
        {thread && members.length ? (
          <>
            <header className="rule-b flex items-center gap-3 p-4">
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
              <span className={`btn px-3 py-1 text-xs ${statusTone}`}>{status}</span>
              {contact?.sessionId && <CopyButton text={resumeCommand(contact)} label="Open in terminal" className="hidden sm:block" />}
              {busy.length > 0 && (
                <button className="btn bg-alert px-3 py-1.5 text-sm text-on-alert" onClick={() => busy.forEach((c) => emit({ type: 'interrupt', contactId: c.id }))}>
                  {isGroup ? '❚❚ Pause all' : '■ Stop'}
                </button>
              )}
            </header>
            <div ref={scroller} className="wallpaper flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4" aria-live="polite">
              {messages.map((m) => {
                const who = byId(m.contactId)
                if (m.body.handoff) return <HandoffPill key={m.id} m={m} from={byId(m.body.handoff.from)} to={byId(m.body.handoff.to)} />
                if (m.kind === 'tool') return <ToolLine key={m.id} m={m} c={isGroup ? who : undefined} />
                if (m.kind === 'approval') return <ApprovalCard key={m.id} m={m} onAnswer={answer(m)} />
                if (m.kind === 'question') return <QuestionCard key={m.id} m={m} onAnswer={answer(m)} />
                // In a group, agent bubbles carry their pfp and name.
                if (isGroup && m.sender === 'agent' && who)
                  return (
                    <div key={m.id} className="flex max-w-[85%] items-end gap-2 self-start">
                      <Avatar c={who} size="size-7 text-[10px]" />
                      <div className="flex min-w-0 flex-col">
                        <div className="mb-1 text-xs font-bold">
                          {who.displayName} <span className="font-normal text-muted">· {who.agentName}</span>
                        </div>
                        <Bubble m={m} showReceipt={false} />
                      </div>
                    </div>
                  )
                return <Bubble key={m.id} m={m} showReceipt={m.id === lastUserId} />
              })}
              {typers.map((c) => (
                <TypingBubble key={c.id} c={c} showPfp={isGroup} />
              ))}
            </div>
            {agent && !agent.live && <div className="bg-alert px-4 py-2 text-sm font-bold text-on-alert">{agent.reason}</div>}
            <Composer
              name={contact ? contact.displayName : `#${thread.title}`}
              mentions={isGroup ? members.map((c) => c.displayName) : undefined}
              disabled={!state.connected}
              onSend={(text) => emit({ type: 'send', threadId: thread.id, text })}
            />
          </>
        ) : (
          <div className="grid flex-1 place-items-center text-muted">{state.connected ? 'No chats yet' : 'Connecting to gcnb server…'}</div>
        )}
      </main>

      {thread && isGroup && <GroupInfo t={thread} members={members} statusOf={statusOf} />}
      {contact && <ContactCard key={contact.id} c={contact} onSave={(patch) => emit({ type: 'updateContact', contactId: contact.id, ...patch })} />}
    </div>
  )
}


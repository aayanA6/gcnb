import { useEffect, useReducer, useRef, useState } from 'react'
import { ServerEvent, type AgentState, type ClientEvent, type Contact, type Message, type Thread } from '@gcnb/shared'
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
    case 'message':
      return { ...s, messages: [...s.messages, e.message] }
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
  const send = (threadId: string, text: string) =>
    ws.current?.send(JSON.stringify({ type: 'send', threadId, text } satisfies ClientEvent))
  return { state, send }
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

export default function App() {
  const { state, send } = useGcnb()
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

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [messages.length, typing])

  const status = !state.connected ? 'Reconnecting…' : typing ? 'Typing…' : agent?.live ? 'Online' : 'Offline'

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
                {c && <Avatar c={c} />}
                <div className="min-w-0 flex-1">
                  <div className="flex justify-between gap-2">
                    <span className="truncate font-bold">{t.title}</span>
                    <span className="shrink-0 text-xs opacity-70">{last && time(last.createdAt)}</span>
                  </div>
                  <div className="truncate text-sm opacity-80">
                    {c && state.typing.includes(c.id) ? <i>typing…</i> : (last?.body.text ?? 'Say hi')}
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
              <span className={`btn px-3 py-1 text-xs ${agent?.live && state.connected ? 'bg-ok text-on-accent' : 'bg-alert text-on-alert'}`}>
                {status}
              </span>
            </header>
            <div ref={scroller} className="wallpaper flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4" aria-live="polite">
              {messages.map((m) => (
                <Bubble key={m.id} m={m} showReceipt={m.id === lastUserId} />
              ))}
              {typing && (
                <div className="bubble flex items-center gap-1 self-start bg-them py-3 text-on-them" aria-label={`${contact.displayName} is typing`}>
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                </div>
              )}
            </div>
            {agent && !agent.live && <div className="bg-alert px-4 py-2 text-sm font-bold text-on-alert">{agent.reason}</div>}
            <Composer name={contact.displayName} disabled={!state.connected} onSend={(text) => send(thread.id, text)} />
          </>
        ) : (
          <div className="grid flex-1 place-items-center text-muted">{state.connected ? 'No chats yet' : 'Connecting to gcnb server…'}</div>
        )}
      </main>

      {contact && (
        <aside className="panel hidden min-h-0 flex-col items-center gap-4 overflow-y-auto p-5 lg:flex">
          <Avatar c={contact} size="size-24 text-3xl" />
          <div className="text-center">
            <div className="title-type text-2xl font-bold">{contact.displayName}</div>
            <div className="text-sm text-muted">{contact.bio}</div>
          </div>
          <dl className="grid w-full grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="font-bold">Model</dt>
            <dd className="text-right">{contact.model}</dd>
            <dt className="font-bold">Folder</dt>
            <dd className="truncate text-right font-mono" title={contact.cwd}>{contact.cwd}</dd>
            <dt className="font-bold">Permissions</dt>
            <dd className="text-right">{contact.permissionMode === 'default' ? 'Ask first' : contact.permissionMode}</dd>
          </dl>
          <div className="w-full text-sm">
            <div className="mb-1 flex justify-between font-bold">
              <span>Budget</span>
              <span>${contact.spentUsd.toFixed(2)} / ${contact.budgetUsd.toFixed(2)}</span>
            </div>
            <div className="field h-3 overflow-hidden">
              <div className="h-full bg-ok" style={{ width: `${Math.min(100, (contact.spentUsd / contact.budgetUsd) * 100)}%` }} />
            </div>
          </div>
          {contact.sessionId && (
            <button
              className="btn mt-auto w-full bg-panel px-3 py-2 text-sm text-ink"
              onClick={() => navigator.clipboard.writeText(`cd "${contact.cwd}" && claude --resume ${contact.sessionId}`)}
            >
              Copy resume command
            </button>
          )}
        </aside>
      )}
    </div>
  )
}

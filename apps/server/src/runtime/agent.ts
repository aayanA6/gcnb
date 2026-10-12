// All Claude Agent SDK handling lives in this module (plan: "SDK and preview churn" risk).
import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { AgentState, Decision, Message, Question, ServerEvent } from '@gcnb/shared'
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'
import { z } from 'zod'
import type { Db } from '../db.ts'
import type { AgentFile } from '../agents.ts'
import type { Delivery } from '../router.ts'

const PERSONA = [
  'You are chatting with the user through gcnb, an iMessage-style app. Reply like a text message: short, plain, conversational. Use markdown only when sharing code.',
  'Group chat messages arrive prefixed like "[#group · from Name · members: a, b]". Your final reply in that turn posts to the group.',
  'To pass work to another member of that group, call the hand_off tool with their name and a self-contained message; the server delivers it and their reply posts to the group. Only hand off when someone else should act next.',
].join('\n')

export const HAND_OFF = 'mcp__gcnb__hand_off'

// Close a contact's process after this long without a turn; the next message resumes the session.
const IDLE_MS = Number(process.env.GCNB_IDLE_MIN ?? 30) * 60_000

// Async queue that feeds the SDK's streaming input mode; push() never blocks.
function inbox<T>() {
  const items: T[] = []
  let wake: (() => void) | null = null
  let closed = false
  const poke = () => {
    wake?.()
    wake = null
  }
  return {
    push(x: T) {
      items.push(x)
      poke()
    },
    close() {
      closed = true
      poke()
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (items.length) yield items.shift()!
        if (closed) return
        await new Promise<void>((r) => (wake = r))
      }
    },
  }
}

// total_cost_usd is cumulative per query() call, and a resumed session usually continues from the
// total its transcript saved. `lifetime` records which case the first result showed.
// ponytail: guesses the case from the first result; undercounts if a fresh total happens to exceed the stored spend.
export function spendAfterResult(base: number, total: number, lifetime: boolean | null) {
  const isLifetime = lifetime ?? total >= base
  return { spent: isLifetime ? total : base + total, lifetime: isLifetime }
}

const clip = (s: unknown, n = 120) => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/** The grey line for a tool_use block, e.g. "Read src/auth.ts" or "Ran npm test". */
export function describeTool(name: string, input: Record<string, unknown>, cwd: string): string {
  const path = (p: unknown) => {
    if (typeof p !== 'string') return '?'
    const r = relative(cwd, p)
    return (r && !r.startsWith('..') && !isAbsolute(r) ? r : p).replaceAll('\\', '/')
  }
  switch (name) {
    case 'Read': return `Read ${path(input.file_path)}`
    case 'Edit': case 'MultiEdit': return `Edited ${path(input.file_path)}`
    case 'Write': return `Wrote ${path(input.file_path)}`
    case 'NotebookEdit': return `Edited ${path(input.notebook_path)}`
    case 'Bash': return `Ran ${clip(input.command)}`
    case 'Glob': return `Searched for ${clip(input.pattern, 80)}`
    case 'Grep': return `Searched for "${clip(input.pattern, 80)}"`
    case 'WebFetch': return `Fetched ${clip(input.url, 100)}`
    case 'WebSearch': return `Searched the web for "${clip(input.query, 80)}"`
    case 'Task': case 'Agent': return `Started a subagent: ${clip(input.description, 80)}`
    case 'TodoWrite': return 'Updated the todo list'
    default: return `Used ${name}`
  }
}

// What an approval card says and shows.
function describeRequest(name: string, input: Record<string, unknown>, cwd: string) {
  if (name === 'Bash') return { verb: 'run a command', detail: String(input.command ?? '') }
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name))
    return { verb: name === 'Write' ? 'write a file' : 'edit a file', detail: describeTool(name, input, cwd).replace(/^\w+ /, '') }
  if (name === 'WebFetch') return { verb: 'fetch a page', detail: String(input.url ?? '') }
  return { verb: `use ${name}`, detail: clip(JSON.stringify(input), 400) }
}

type Pending = { resolve: (r: PermissionResult) => void; messageId: string; input: Record<string, unknown>; suggestions?: PermissionUpdate[] }

export type RuntimeHooks = {
  /** hand_off tool: route work to another member; returns the tool result text. */
  handOff(fromId: string, from: Delivery, to: string, message: string): string
  /** A group turn finished and cost this much (for the group's hourly cap). */
  groupTurnCost(threadId: string, usd: number): void
  isGroup(threadId: string): boolean
}

/** One long-lived SDK session for one contact. Started on the first message, resumed by session_id. */
export class AgentRuntime {
  private q?: Query
  private box?: ReturnType<typeof inbox<SDKUserMessage>>
  private idleTimer?: NodeJS.Timeout
  private restartAfterTurn = false
  private interrupted = false
  // One active turn per contact: deliveries wait here until the current turn's result.
  private queue: Delivery[] = []
  private current?: Delivery & { startSpent: number }
  private pending = new Map<string, Pending>() // open canUseTool promises by action id
  typing = false

  constructor(
    private db: Db,
    readonly contactId: string,
    private agent: AgentFile,
    private emit: (e: ServerEvent) => void,
    private hooks: RuntimeHooks,
  ) {}

  get running() {
    return !!this.q
  }

  /** The thread this contact's current turn belongs to (its DM when idle). */
  get threadId() {
    return this.current?.threadId ?? `dm-${this.contactId}`
  }

  private get contact() {
    return this.db.contact(this.contactId)!
  }

  state(): AgentState {
    const c = this.contact
    if (!process.env.ANTHROPIC_API_KEY)
      return { contactId: c.id, live: false, reason: 'Set ANTHROPIC_API_KEY to enable live replies' }
    if (c.spentUsd >= c.budgetUsd)
      return { contactId: c.id, live: false, reason: `${c.displayName} used the $${c.budgetUsd.toFixed(2)} budget` }
    return { contactId: c.id, live: true }
  }

  /** Queue a message for this contact's session. Caller checks state().live first. */
  deliver(d: Delivery) {
    this.queue.push(d)
    this.pump()
  }

  private pump() {
    if (this.current || !this.queue.length) return
    const d = this.queue.shift()!
    clearTimeout(this.idleTimer)
    if (!this.q) this.start()
    this.current = { ...d, startSpent: this.contact.spentUsd }
    this.box!.push({ type: 'user', message: { role: 'user', content: d.text }, parent_tool_use_id: null } as SDKUserMessage)
  }

  /** Stop button: Query.interrupt() ends the current turn, open cards are cancelled, queued messages dropped. */
  async interrupt() {
    const dropped = this.queue.length
    this.queue = []
    if (dropped) this.post('system', 'status', `Dropped ${dropped} queued message${dropped > 1 ? 's' : ''}`)
    if (!this.q || !this.current) return
    this.interrupted = true
    for (const id of [...this.pending.keys()]) this.settle(id, 'cancelled', { behavior: 'deny', message: 'The user stopped this turn.', interrupt: true })
    await this.q.interrupt().catch(() => {})
  }

  close() {
    clearTimeout(this.idleTimer)
    for (const id of [...this.pending.keys()]) this.settle(id, 'cancelled', { behavior: 'deny', message: 'Session closed.' })
    this.box?.close()
    this.q?.close()
    // Detach now so a message arriving mid-shutdown starts a fresh process instead of a dead queue.
    this.q = undefined
    this.box = undefined
    this.setTyping(false)
    this.current = undefined
    this.pump() // anything still queued starts a fresh process
  }

  /** Server stop: drop the queue first so close() doesn't start anything new. */
  shutdown() {
    this.queue = []
    this.close()
  }

  /** SDK options are fixed per process: close now (or after the current turn) and resume with new options on the next message. */
  restart() {
    if (this.current) this.restartAfterTurn = true
    else this.close()
  }

  /** A tapback on an approval card, or chip answers on a question card. Returns false if the card isn't open. */
  answer(actionId: string, a: { decision?: Decision; answers?: Record<string, string> }): boolean {
    const p = this.pending.get(actionId)
    const action = this.db.action(actionId)
    if (!p || !action) return false
    if (action.type === 'question') {
      if (!a.answers) return false
      return this.settle(actionId, 'answered', { behavior: 'allow', updatedInput: { ...p.input, answers: a.answers } }, a.answers)
    }
    if (a.decision === 'deny') return this.settle(actionId, 'deny', { behavior: 'deny', message: 'The user denied this. Ask what they want instead.' })
    if (a.decision === 'always')
      return this.settle(actionId, 'always', { behavior: 'allow', updatedInput: p.input, updatedPermissions: p.suggestions })
    if (a.decision === 'allow') return this.settle(actionId, 'allow', { behavior: 'allow', updatedInput: p.input })
    return false
  }

  private settle(actionId: string, status: NonNullable<Message['body']['status']>, result: PermissionResult, answers?: Record<string, string>) {
    const p = this.pending.get(actionId)
    if (!p) return false
    this.pending.delete(actionId)
    this.db.setActionStatus(actionId, status)
    const message = this.db.patchMessageBody(p.messageId, answers ? { status, answers } : { status })
    if (message) this.emit({ type: 'message', message })
    p.resolve(result)
    return true
  }

  // Fires for tools the permission mode doesn't auto-allow, and always for AskUserQuestion.
  private canUseTool: CanUseTool = (toolName, input, opts) => {
    const c = this.contact
    const actionId = randomUUID()
    const isQuestion = toolName === 'AskUserQuestion'
    const req = describeRequest(toolName, input, c.cwd)
    const body: Message['body'] = isQuestion
      ? { text: `${c.displayName} has a question`, actionId, status: 'pending', questions: (input.questions ?? []) as Question[] }
      : {
          text: opts.title ?? `${c.displayName} wants to ${req.verb}`,
          actionId,
          status: 'pending',
          toolName,
          detail: req.detail,
          canAlways: !!opts.suggestions?.length && !opts.suppressAlwaysAllowRule,
        }
    const message = this.db.addMessage({ threadId: this.threadId, sender: 'agent', contactId: this.contactId, kind: isQuestion ? 'question' : 'approval', body })
    this.db.addAction({
      id: actionId,
      contactId: this.contactId,
      threadId: this.threadId,
      type: isQuestion ? 'question' : 'approval',
      payloadJson: JSON.stringify({ messageId: message.id, toolName, input, suggestions: opts.suggestions }),
      status: 'pending',
    })
    this.setTyping(false) // waiting on you, not typing
    this.emit({ type: 'message', message })
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(actionId, { resolve, messageId: message.id, input, suggestions: opts.suggestions })
      opts.signal.addEventListener('abort', () => this.settle(actionId, 'cancelled', { behavior: 'deny', message: 'Cancelled.' }), { once: true })
    })
  }

  private post(sender: Message['sender'], kind: Message['kind'], text: string, extra: Partial<Message['body']> = {}) {
    const message = this.db.addMessage({ threadId: this.threadId, sender, contactId: this.contactId, kind, body: { text, ...extra } })
    this.emit({ type: 'message', message })
  }

  private setTyping(on: boolean) {
    if (this.typing === on) return
    this.typing = on
    this.emit({ type: 'typing', contactId: this.contactId, threadId: this.threadId, on })
  }

  private start() {
    const c = this.contact
    const box = inbox<SDKUserMessage>()
    // In-process MCP server: agents talk to each other only through gcnb (plan: custom tools).
    const gcnb = createSdkMcpServer({
      name: 'gcnb',
      version: '1.0.0',
      tools: [
        tool(
          'hand_off',
          'Pass work to another member of the current group chat. The server delivers your message into their session and their reply posts to the group. Chains pause after a few hand-offs without the user.',
          {
            to: z.string().describe('Name of the group member to hand off to, e.g. "coder"'),
            message: z.string().describe('Self-contained instructions for them: what to do and the context they need'),
          },
          async ({ to, message }) => ({
            content: [{ type: 'text' as const, text: this.current ? this.hooks.handOff(this.contactId, this.current, to, message) : 'No active turn.' }],
          }),
        ),
      ],
    })
    const q = query({
      prompt: box,
      options: {
        resume: c.sessionId ?? undefined,
        model: c.model,
        cwd: c.cwd,
        permissionMode: c.permissionMode as PermissionMode,
        allowDangerouslySkipPermissions: c.permissionMode === 'bypassPermissions',
        includePartialMessages: true,
        maxBudgetUsd: Math.max(0, c.budgetUsd - c.spentUsd),
        disallowedTools: ['SendMessage', 'ListAgents'], // agents talk only through gcnb, where you can see it
        mcpServers: { gcnb },
        allowedTools: [HAND_OFF], // routing is gcnb's own tool; never needs an approval card
        // Run the session as the contact's own .claude/agents definition.
        agents: {
          [this.agent.name]: {
            description: this.agent.description,
            prompt: `${this.agent.prompt}\n\n${PERSONA}`,
            tools: this.agent.tools && [...this.agent.tools, HAND_OFF],
          },
        },
        agent: this.agent.name,
        canUseTool: this.canUseTool,
      },
    })
    this.q = q
    this.box = box
    void this.consume(q, c.spentUsd)
  }

  private async consume(q: Query, base: number) {
    let lifetime: boolean | null = null
    try {
      for await (const m of q) {
        if ('session_id' in m && m.session_id && m.session_id !== this.contact.sessionId) {
          this.db.updateContact(this.contactId, { sessionId: m.session_id })
          this.emit({ type: 'contact', contact: this.contact })
        }
        const group = this.hooks.isGroup(this.threadId)
        switch (m.type) {
          case 'stream_event':
            if (!m.parent_tool_use_id && !this.pending.size) this.setTyping(true)
            break
          case 'assistant': {
            // Subagent chatter stays out of the chat; an API error (billing, auth, ...) shows as the grey status line instead of a bubble.
            if (m.parent_tool_use_id || m.error) break
            for (const b of m.message.content) {
              // In a DM every text block is a bubble; in a group only the turn's final text posts (at result).
              if (b.type === 'text' && b.text.trim() && !group) this.post('agent', 'text', b.text.trim())
              // AskUserQuestion gets a card and hand_off gets a pill instead of a grey line.
              if (b.type === 'tool_use' && b.name !== 'AskUserQuestion' && b.name !== HAND_OFF)
                this.post('agent', 'tool', describeTool(b.name, b.input as Record<string, unknown>, this.contact.cwd), { toolName: b.name })
            }
            break
          }
          case 'result': {
            const s = spendAfterResult(base, m.total_cost_usd, lifetime)
            lifetime = s.lifetime
            this.db.updateContact(this.contactId, { spentUsd: s.spent })
            this.emit({ type: 'contact', contact: this.contact })
            const cost = this.current ? Math.max(0, s.spent - this.current.startSpent) : 0
            if (group && m.subtype === 'success' && !m.is_error && m.result.trim()) this.post('agent', 'text', m.result.trim(), { costUsd: cost })
            if (group) this.hooks.groupTurnCost(this.threadId, cost)
            if (this.interrupted) this.post('system', 'status', 'Stopped')
            else if (m.subtype === 'error_max_budget_usd') this.post('system', 'status', 'Paused: budget used up')
            else if (m.subtype !== 'success') this.post('system', 'status', `Turn stopped (${m.subtype})`)
            else if (m.is_error) this.post('system', 'status', `Error: ${m.result}`)
            this.interrupted = false
            this.setTyping(false)
            this.current = undefined
            this.emit({ type: 'agent', agent: this.state() })
            if (this.restartAfterTurn) {
              this.restartAfterTurn = false
              this.close() // also pumps the queue into a fresh process
            } else if (this.queue.length) {
              // Budget may have run out while these waited.
              if (this.state().live) this.pump()
              else this.dropQueue(this.state().reason ?? 'offline')
            } else {
              this.idleTimer = setTimeout(() => this.close(), IDLE_MS)
            }
            break
          }
        }
      }
    } catch (err) {
      // A process we closed on purpose (idle, restart) has already been detached; stay quiet about it.
      if (this.q === q) this.post('system', 'status', `Agent error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (this.q === q) {
        this.queue = []
        this.close()
      }
    }
  }

  private dropQueue(reason: string) {
    for (const d of this.queue.splice(0))
      this.emit({ type: 'message', message: this.db.addMessage({ threadId: d.threadId, sender: 'system', contactId: this.contactId, kind: 'status', body: { text: `${this.contact.displayName}: not delivered (${reason})` } }) })
  }
}

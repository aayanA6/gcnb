// All Claude CLI subprocess handling lives in this module (plan: "SDK and preview churn" risk).
// Runs the user's own `claude` CLI as one long-lived headless process per contact (stream-json in,
// stream-json out), so replies run on the user's Claude subscription instead of an API key.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'
import type { AgentState, Decision, Message, Question, ServerEvent } from '@gcnb/shared'
import type { Db } from '../db.ts'
import type { AgentFile } from '../agents.ts'
import type { Delivery } from '../router.ts'

const PERSONA = [
  'You are chatting with the user through gcnb, an iMessage-style app. Reply like a text message: short, plain, conversational. Use markdown only when sharing code.',
  'Group chat messages arrive prefixed like "[#group · from Name · members: a, b]". Your final reply in that turn posts to the group.',
  'To pass work to another member of that group, call the hand_off tool with their name and a self-contained message; the server delivers it and their reply posts to the group. Only hand off when someone else should act next.',
].join('\n')

export const HAND_OFF = 'mcp__gcnb__hand_off'
export const PERMISSION_PROMPT = 'mcp__gcnb__permission_prompt'

// Close a contact's process after this long without a turn; the next message resumes the session.
const IDLE_MS = Number(process.env.GCNB_IDLE_MIN ?? 30) * 60_000

const CLAUDE_BIN = process.env.GCNB_CLAUDE_BIN ?? 'claude'

// The subscription login lives in the CLI's own auth, never an API key: strip any API-key env so the
// CLI can't silently fall back to key-based billing.
function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  return env
}

// Boot-time cached check, replacing the old ANTHROPIC_API_KEY gate: the CLI must be on PATH and
// logged into a subscription. Bounded so a hung `claude auth status` can't block startup forever.
// ponytail: cached for the process lifetime; restart gcnb after `claude auth login` to pick it up.
let authOk: boolean | null = null
export function checkClaudeAuth(): boolean {
  if (authOk === null) {
    try {
      authOk = spawnSync(CLAUDE_BIN, ['auth', 'status'], { timeout: 10_000, windowsHide: true, env: cliEnv() }).status === 0
    } catch {
      authOk = false
    }
  }
  return authOk
}

// Async queue that feeds the CLI's streaming stdin; push() never blocks.
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

// total_cost_usd is cumulative per CLI process, and a resumed session usually continues from the
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

// Local stand-ins for the Claude Agent SDK's permission types (plan: drop the SDK dependency
// entirely). The shapes match what the CLI's own permission engine expects back from
// --permission-prompt-tool, confirmed live against claude 2.1.296.
export type PermissionUpdate = {
  type: 'addRules'
  rules: { toolName: string; ruleContent?: string }[]
  behavior: 'allow' | 'deny'
  destination: 'session' | 'userSettings' | 'projectSettings' | 'localSettings' | 'cliArg'
}
export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean }
export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  opts: { signal: AbortSignal; suggestions?: PermissionUpdate[]; title?: string; suppressAlwaysAllowRule?: boolean; toolUseID: string; requestId: string },
) => Promise<PermissionResult>

type Pending = { resolve: (r: PermissionResult) => void; messageId: string; input: Record<string, unknown>; suggestions?: PermissionUpdate[] }

// What a contact's stdin line looks like (stream-json input mode).
type CliUserMessage = { type: 'user'; message: { role: 'user'; content: string } }

export type RuntimeHooks = {
  /** hand_off tool: route work to another member; returns the tool result text. */
  handOff(fromId: string, from: Delivery, to: string, message: string): string
  /** A group turn finished and cost this much (for the group's hourly cap). */
  groupTurnCost(threadId: string, usd: number): void
  isGroup(threadId: string): boolean
  /** gcnb's own MCP endpoint base, e.g. "http://127.0.0.1:8787/mcp" (the contact id is appended). */
  mcpUrl?: string
  /** Bearer token every contact's CLI process must send to that endpoint. */
  mcpToken?: string
}

/** One long-lived `claude` CLI process for one contact. Started on the first message, resumed by session_id. */
export class AgentRuntime {
  private child?: ChildProcess
  private box?: ReturnType<typeof inbox<CliUserMessage>>
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
    return !!this.child
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
    if (!checkClaudeAuth())
      return { contactId: c.id, live: false, reason: 'claude CLI not found or not logged in (run `claude` once to sign in)' }
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
    if (!this.child) this.start()
    this.current = { ...d, startSpent: this.contact.spentUsd }
    this.box!.push({ type: 'user', message: { role: 'user', content: d.text } })
  }

  /** Stop button: an interrupt control_request ends the current turn, open cards are cancelled, queued messages dropped. */
  async interrupt() {
    const dropped = this.queue.length
    this.queue = []
    if (dropped) this.post('system', 'status', `Dropped ${dropped} queued message${dropped > 1 ? 's' : ''}`)
    if (!this.child || !this.current) return
    this.interrupted = true
    for (const id of [...this.pending.keys()]) this.settle(id, 'cancelled', { behavior: 'deny', message: 'The user stopped this turn.', interrupt: true })
    try {
      this.child.stdin!.write(`${JSON.stringify({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })}\n`)
    } catch {}
  }

  close() {
    clearTimeout(this.idleTimer)
    for (const id of [...this.pending.keys()]) this.settle(id, 'cancelled', { behavior: 'deny', message: 'Session closed.' })
    this.box?.close()
    this.child?.kill()
    // Detach now so a message arriving mid-shutdown starts a fresh process instead of a dead queue.
    this.child = undefined
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

  /** CLI args are fixed per process: close now (or after the current turn) and resume with new options on the next message. */
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

  /** The gcnb MCP server's permission_prompt tool: the CLI's --permission-prompt-tool. It never sends
   * permission_suggestions (confirmed live), so "always allow" builds its own session-only rule for the tool. */
  permissionPrompt(toolName: string, input: Record<string, unknown>, toolUseId?: string): Promise<PermissionResult> {
    const suggestions: PermissionUpdate[] = [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }]
    return this.canUseTool(toolName, input, { signal: new AbortController().signal, toolUseID: toolUseId ?? randomUUID(), requestId: randomUUID(), suggestions })
  }

  /** The gcnb MCP server's hand_off tool. */
  handOffTool(to: string, message: string): string {
    return this.current ? this.hooks.handOff(this.contactId, this.current, to, message) : 'No active turn.'
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
    const box = inbox<CliUserMessage>()
    const mcpConfig = {
      mcpServers: {
        // Always loaded (not deferred behind tool search): hand_off must be visible to the model
        // from turn 1, and permission_prompt is dispatched directly by the CLI's own permission engine.
        gcnb: { type: 'http', url: `${this.hooks.mcpUrl}/${this.contactId}`, headers: { Authorization: `Bearer ${this.hooks.mcpToken}` }, alwaysLoad: true },
      },
    }
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', c.model,
      '--permission-mode', c.permissionMode,
      ...(c.permissionMode === 'bypassPermissions' ? ['--allow-dangerously-skip-permissions'] : []),
      ...(c.sessionId ? ['--resume', c.sessionId] : []),
      '--max-budget-usd', String(Math.max(0, c.budgetUsd - c.spentUsd)),
      // Run the session as the contact's own .claude/agents definition, same as `claude --agent`.
      '--agents', JSON.stringify({
        [this.agent.name]: {
          description: this.agent.description,
          prompt: `${this.agent.prompt}\n\n${PERSONA}`,
          tools: this.agent.tools && [...this.agent.tools, HAND_OFF],
        },
      }),
      '--agent', this.agent.name,
      // Agents talk only through gcnb, where you can see it; permission_prompt is internal plumbing, never a callable tool.
      '--disallowedTools', 'SendMessage', 'ListAgents', PERMISSION_PROMPT,
      '--allowedTools', HAND_OFF, // routing is gcnb's own tool; never needs an approval card
      '--mcp-config', JSON.stringify(mcpConfig),
      '--permission-prompt-tool', PERMISSION_PROMPT,
      // Skip ~/.claude settings by default: a global hook could answer tool prompts before gcnb's cards see them.
      '--setting-sources', process.env.GCNB_SETTING_SOURCES ?? 'project,local',
    ]
    const child = spawn(CLAUDE_BIN, args, { cwd: c.cwd, env: cliEnv(), windowsHide: true })
    // Without this, a spawn failure (ENOENT when GCNB_CLAUDE_BIN is wrong, EACCES, ...) is an
    // unhandled 'error' event on the ChildProcess, which Node rethrows and crashes the whole server.
    child.on('error', (err) => {
      if (this.child === child) {
        this.post('system', 'status', `Agent error: ${err.message}`)
        this.queue = []
        this.close()
      }
    })
    this.child = child
    this.box = box
    void this.pumpStdin(child, box)
    void this.consume(child, c.spentUsd)
  }

  private async pumpStdin(child: ChildProcess, box: ReturnType<typeof inbox<CliUserMessage>>) {
    for await (const msg of box) {
      try {
        child.stdin!.write(`${JSON.stringify(msg)}\n`)
      } catch {} // the process already exited; consume()'s exit handling takes it from here
    }
  }

  private async consume(child: ChildProcess, base: number) {
    let lifetime: boolean | null = null
    let errored = false
    let stderr = ''
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()))
    let buf = ''
    try {
      for await (const chunk of child.stdout!) {
        buf += (chunk as Buffer).toString()
        const lines = buf.split('\n')
        buf = lines.pop()! // keep the last, possibly-partial line for the next chunk
        for (const line of lines) {
          if (!line.trim()) continue
          let m: Record<string, unknown>
          try {
            m = JSON.parse(line)
          } catch {
            continue // not JSON: a stray log line, ignore it
          }
          if (typeof m.session_id === 'string' && m.session_id !== this.contact.sessionId) {
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
              const content = (m.message as { content: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> }).content
              for (const b of content) {
                // In a DM every text block is a bubble; in a group only the turn's final text posts (at result).
                if (b.type === 'text' && b.text?.trim() && !group) this.post('agent', 'text', b.text.trim())
                // AskUserQuestion gets a card and hand_off gets a pill instead of a grey line.
                if (b.type === 'tool_use' && b.name !== 'AskUserQuestion' && b.name !== HAND_OFF)
                  this.post('agent', 'tool', describeTool(b.name!, b.input ?? {}, this.contact.cwd), { toolName: b.name })
              }
              break
            }
            case 'result': {
              const s = spendAfterResult(base, m.total_cost_usd as number, lifetime)
              lifetime = s.lifetime
              this.db.updateContact(this.contactId, { spentUsd: s.spent })
              this.emit({ type: 'contact', contact: this.contact })
              const cost = this.current ? Math.max(0, s.spent - this.current.startSpent) : 0
              if (group && m.subtype === 'success' && !m.is_error && (m.result as string).trim()) this.post('agent', 'text', (m.result as string).trim(), { costUsd: cost })
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
            // control_response, rate_limit_event and anything else: no UI effect, ignore.
          }
        }
      }
    } catch (err) {
      // A process we closed on purpose (idle, restart) has already been detached; stay quiet about it.
      if (this.child === child) {
        this.post('system', 'status', `Agent error: ${err instanceof Error ? err.message : String(err)}`)
        errored = true
      }
    } finally {
      if (this.child === child) {
        // The process exited on its own mid-turn (crash, or stdin closed) instead of us closing it on purpose.
        if (!errored && this.current) this.post('system', 'status', `Agent error: process exited${stderr.trim() ? `: ${clip(stderr, 200)}` : ''}`)
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

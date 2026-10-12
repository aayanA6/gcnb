// All Claude Agent SDK handling lives in this module (plan: "SDK and preview churn" risk).
import { query, type PermissionMode, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentState, Message, ServerEvent } from '@gcnb/shared'
import type { Db } from '../db.ts'
import type { AgentFile } from '../agents.ts'

const PERSONA =
  'You are chatting with the user through gcnb, an iMessage-style app. Reply like a text message: short, plain, conversational. Use markdown only when sharing code.'

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

/** One long-lived SDK session for one contact. Started on the first message, resumed by session_id. */
export class AgentRuntime {
  private q?: Query
  private box?: ReturnType<typeof inbox<SDKUserMessage>>
  private idleTimer?: NodeJS.Timeout
  private restartAfterTurn = false
  typing = false

  constructor(
    private db: Db,
    readonly contactId: string,
    private threadId: string,
    private agent: AgentFile,
    private emit: (e: ServerEvent) => void,
  ) {}

  get running() {
    return !!this.q
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

  /** Queues a user message into the session. Caller checks state().live first. */
  send(text: string) {
    clearTimeout(this.idleTimer)
    if (!this.q) this.start()
    this.box!.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } as SDKUserMessage)
  }

  close() {
    clearTimeout(this.idleTimer)
    this.box?.close()
    this.q?.close()
    // Detach now so a message arriving mid-shutdown starts a fresh process instead of a dead queue.
    this.q = undefined
    this.box = undefined
  }

  /** SDK options are fixed per process: close now (or after the current turn) and resume with new options on the next message. */
  restart() {
    if (this.typing) this.restartAfterTurn = true
    else this.close()
  }

  private post(sender: Message['sender'], kind: Message['kind'], text: string) {
    const message = this.db.addMessage({ threadId: this.threadId, sender, contactId: this.contactId, kind, body: { text } })
    this.emit({ type: 'message', message })
  }

  private setTyping(on: boolean) {
    if (this.typing === on) return
    this.typing = on
    this.emit({ type: 'typing', contactId: this.contactId, on })
  }

  private start() {
    const c = this.contact
    const box = inbox<SDKUserMessage>()
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
        disallowedTools: ['SendMessage', 'ListAgents'], // agents talk only through gcnb
        // Run the session as the contact's own .claude/agents definition.
        agents: { [this.agent.name]: { description: this.agent.description, prompt: `${this.agent.prompt}\n\n${PERSONA}`, tools: this.agent.tools } },
        agent: this.agent.name,
        // Approval cards arrive in Phase 3. Until then tools that would prompt are allowed;
        // questions are pushed back to plain text because there's no chip UI to answer them.
        canUseTool: async (toolName, input) =>
          toolName === 'AskUserQuestion'
            ? { behavior: 'deny', message: 'gcnb cannot show question chips yet. Ask your question as a normal text reply.' }
            : { behavior: 'allow', updatedInput: input },
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
        switch (m.type) {
          case 'stream_event':
            if (!m.parent_tool_use_id) this.setTyping(true)
            break
          case 'assistant': {
            if (m.parent_tool_use_id) break // subagent chatter stays out of the DM
            const text = m.message.content
              .flatMap((b) => (b.type === 'text' ? [b.text] : []))
              .join('')
              .trim()
            if (text) this.post('agent', 'text', text)
            break
          }
          case 'result': {
            this.setTyping(false)
            const s = spendAfterResult(base, m.total_cost_usd, lifetime)
            lifetime = s.lifetime
            this.db.updateContact(this.contactId, { spentUsd: s.spent })
            this.emit({ type: 'contact', contact: this.contact })
            if (m.subtype === 'error_max_budget_usd') this.post('system', 'status', 'Paused: budget used up')
            else if (m.subtype !== 'success') this.post('system', 'status', `Turn stopped (${m.subtype})`)
            else if (m.is_error) this.post('system', 'status', `Error: ${m.result}`)
            this.emit({ type: 'agent', agent: this.state() })
            if (this.restartAfterTurn) {
              this.restartAfterTurn = false
              this.close()
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
        this.setTyping(false)
        this.q = undefined
        this.box = undefined
      }
    }
  }
}

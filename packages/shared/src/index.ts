import { z } from 'zod'

// Every WebSocket frame in either direction is one of these. Both ends parse with zod.

export const Contact = z.object({
  id: z.string(),
  agentName: z.string(),
  displayName: z.string(),
  avatarPath: z.string().nullable(),
  color: z.string(),
  bio: z.string(),
  model: z.string(),
  cwd: z.string(),
  permissionMode: z.string(),
  sessionId: z.string().nullable(),
  budgetUsd: z.number(),
  spentUsd: z.number(),
})
export type Contact = z.infer<typeof Contact>

export const Thread = z.object({
  id: z.string(),
  kind: z.enum(['dm', 'group']),
  title: z.string(),
  createdAt: z.number(),
  contactIds: z.array(z.string()), // thread_members
  // Groups only: who gets un-mentioned posts, and the spend cap on top of each contact's own.
  leadContactId: z.string().nullable(),
  hourlyCapUsd: z.number().nullable(),
  spentHourUsd: z.number().optional(), // computed by the server
})
export type Thread = z.infer<typeof Thread>

export const HOP_LIMIT = 4 // agent-to-agent hand-offs in a row before the group pauses for you

// Typing is per contact, tagged with the thread its current turn belongs to.
export const Typing = z.object({ contactId: z.string(), threadId: z.string() })
export type Typing = z.infer<typeof Typing>

// One AskUserQuestion question, rendered as quick-reply chips plus "Other".
export const Question = z.object({
  question: z.string(),
  header: z.string().optional(),
  multiSelect: z.boolean().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
})
export type Question = z.infer<typeof Question>

export const Message = z.object({
  id: z.string(),
  threadId: z.string(),
  sender: z.enum(['user', 'agent', 'system']),
  contactId: z.string().nullable(),
  kind: z.enum(['text', 'tool', 'approval', 'question', 'status']),
  // text/status/tool: { text }; user text adds { delivered }; approval/question cards add the card fields.
  body: z
    .object({
      text: z.string(),
      delivered: z.boolean().optional(),
      actionId: z.string().optional(), // pending_actions row behind an approval/question card
      status: z.enum(['pending', 'allow', 'always', 'deny', 'answered', 'cancelled', 'expired']).optional(),
      toolName: z.string().optional(),
      detail: z.string().optional(), // command, file path or input shown on an approval card
      canAlways: z.boolean().optional(),
      questions: z.array(Question).optional(),
      answers: z.record(z.string(), z.string()).optional(),
      handoff: z.object({ from: z.string(), to: z.string() }).optional(), // hand-off pill (contact ids)
      costUsd: z.number().optional(), // what the turn behind a group bubble cost
      source: z.enum(['terminal']).optional(), // imported from a `claude --resume` turn run outside gcnb
    })
    .passthrough(),
  createdAt: z.number(), // epoch ms
})
export type Message = z.infer<typeof Message>

// A notification banner (push to your phone, or the in-page fallback). `urgent` = something needs you.
export type Note = { title: string; body: string; threadId: string; tag: string; urgent: boolean }

// Which messages ping you: an open card or a paused group (needs you), or an agent's reply (finished).
// Replies share one tag per thread, so a burst of bubbles replaces one banner instead of buzzing each time.
export function noteFor(m: Message, nameOf: (contactId: string) => string, groupTitle?: string): Note | null {
  const where = groupTitle ? ` in #${groupTitle}` : ''
  const card = (m.kind === 'approval' || m.kind === 'question') && m.body.status === 'pending'
  if (card && m.contactId)
    return { title: `${nameOf(m.contactId)} needs you${where}`, body: m.body.detail ? `${m.body.text}: ${m.body.detail}` : m.body.text, threadId: m.threadId, tag: `${m.threadId}:needs`, urgent: true }
  if (m.sender === 'system' && m.body.text.startsWith('Paused'))
    return { title: `#${groupTitle ?? 'group'} paused`, body: m.body.text, threadId: m.threadId, tag: `${m.threadId}:needs`, urgent: true }
  if (m.sender === 'agent' && m.kind === 'text' && m.contactId)
    return { title: `${nameOf(m.contactId)}${where}`, body: m.body.text.slice(0, 300), threadId: m.threadId, tag: m.threadId, urgent: false }
  return null
}

export const PERMISSION_MODES =['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const

// POST /api/contacts: create a new contact (and its agent file) from gcnb itself. name mirrors
// agents.ts's AgentFile name rule (it becomes a contact id, URL segment, agent filename and avatar name).
export const CreateContact = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  displayName: z.string().trim().min(1).max(40),
  description: z.string().min(1).max(2000),
  instructions: z.string().min(1).max(20000),
  model: z.string().regex(/^[\w.:-]{1,64}$/), // same regex as ClientEvent's updateContact
  permissionMode: z.enum(PERMISSION_MODES),
  budgetUsd: z.number().positive().max(10000).optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  cwd: z.string().min(1).max(500).optional(),
})
export type CreateContact = z.infer<typeof CreateContact>

// Answering a card: approvals take a tapback, questions take answers keyed by question text.
export const Decision = z.enum(['allow', 'always', 'deny'])
export type Decision = z.infer<typeof Decision>

// Whether the contact's SDK session can take messages right now.
export const AgentState = z.object({
  contactId: z.string(),
  live: z.boolean(),
  reason: z.string().optional(), // why not live, shown in the UI
})
export type AgentState = z.infer<typeof AgentState>

export const ClientEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('send'), threadId: z.string(), text: z.string().min(1).max(20000) }),
  // Looks apply immediately; engine settings (model, folder, budget) apply from the next message.
  z.object({
    type: z.literal('updateContact'),
    contactId: z.string(),
    displayName: z.string().trim().min(1).max(40).optional(),
    model: z.string().regex(/^[\w.:-]{1,64}$/).optional(),
    cwd: z.string().min(1).max(500).optional(),
    budgetUsd: z.number().positive().max(10000).optional(),
    permissionMode: z.enum(PERMISSION_MODES).optional(),
  }),
  z.object({ type: z.literal('answer'), actionId: z.string(), decision: Decision.optional(), answers: z.record(z.string(), z.string().max(5000)).optional() }),
  z.object({ type: z.literal('interrupt'), contactId: z.string() }), // stop button; also clears that contact's queue
  z.object({ type: z.literal('handToTerminal'), contactId: z.string() }), // "Open in terminal": close so two writers don't run at once
  z.object({ type: z.literal('visible'), on: z.boolean() }), // tab shown/hidden: push only when no tab is looking
  z.object({
    type: z.literal('createGroup'),
    title: z.string().trim().min(1).max(40),
    contactIds: z.array(z.string()).min(2).max(12),
    leadContactId: z.string(),
    hourlyCapUsd: z.number().positive().max(10000).optional(),
  }),
])
export type ClientEvent = z.infer<typeof ClientEvent>

export const ServerEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    contacts: z.array(Contact),
    threads: z.array(Thread),
    messages: z.array(Message),
    agents: z.array(AgentState),
    typing: z.array(Typing),
  }),
  z.object({ type: z.literal('message'), message: Message }),
  z.object({ type: z.literal('typing'), contactId: z.string(), threadId: z.string(), on: z.boolean() }),
  z.object({ type: z.literal('agent'), agent: AgentState }),
  z.object({ type: z.literal('contact'), contact: Contact }),
  z.object({ type: z.literal('thread'), thread: Thread }), // new group, or a group's hourly spend changed
])
export type ServerEvent = z.infer<typeof ServerEvent>

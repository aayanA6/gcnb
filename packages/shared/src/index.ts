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
})
export type Thread = z.infer<typeof Thread>

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
    })
    .passthrough(),
  createdAt: z.number(), // epoch ms
})
export type Message = z.infer<typeof Message>

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const

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
  z.object({ type: z.literal('interrupt'), contactId: z.string() }), // stop button
])
export type ClientEvent = z.infer<typeof ClientEvent>

export const ServerEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    contacts: z.array(Contact),
    threads: z.array(Thread),
    messages: z.array(Message),
    agents: z.array(AgentState),
    typing: z.array(z.string()), // contact ids currently typing
  }),
  z.object({ type: z.literal('message'), message: Message }),
  z.object({ type: z.literal('typing'), contactId: z.string(), on: z.boolean() }),
  z.object({ type: z.literal('agent'), agent: AgentState }),
  z.object({ type: z.literal('contact'), contact: Contact }),
])
export type ServerEvent = z.infer<typeof ServerEvent>

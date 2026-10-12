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

export const Message = z.object({
  id: z.string(),
  threadId: z.string(),
  sender: z.enum(['user', 'agent', 'system']),
  contactId: z.string().nullable(),
  kind: z.enum(['text', 'tool', 'approval', 'question', 'status']),
  // text/status: { text }; user text also carries { delivered }
  body: z.object({ text: z.string(), delivered: z.boolean().optional() }).passthrough(),
  createdAt: z.number(), // epoch ms
})
export type Message = z.infer<typeof Message>

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
    typing: z.array(z.string()), // contact ids currently typing
  }),
  z.object({ type: z.literal('message'), message: Message }),
  z.object({ type: z.literal('typing'), contactId: z.string(), on: z.boolean() }),
  z.object({ type: z.literal('agent'), agent: AgentState }),
  z.object({ type: z.literal('contact'), contact: Contact }),
])
export type ServerEvent = z.infer<typeof ServerEvent>

import Fastify from 'fastify'
import { WebSocketServer, WebSocket } from 'ws'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClientEvent, type ServerEvent } from '@gcnb/shared'
import { openDb } from './db.ts'
import { AgentRuntime } from './runtime/agent.ts'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const port = Number(process.env.GCNB_PORT ?? 8787)
const dataDir = process.env.GCNB_DATA_DIR ?? join(root, '.gcnb')
mkdirSync(dataDir, { recursive: true })
const db = openDb(join(dataDir, 'gcnb.db'))

// Phase 1: one hardcoded contact. Phase 2 loads contacts from .claude/agents/*.md.
db.seedContact(
  {
    id: 'bolt',
    agentName: 'bolt',
    displayName: 'Bolt',
    avatarPath: null,
    color: '#3ddc97',
    bio: 'Writes and fixes code. Asks before running anything.',
    model: process.env.GCNB_MODEL ?? 'sonnet',
    cwd: process.env.GCNB_CWD ?? root,
    permissionMode: 'default', // risky tools ask first (plan: Security)
    budgetUsd: Number(process.env.GCNB_BUDGET_USD ?? 2),
  },
  'dm-bolt',
)

const app = Fastify({ logger: { level: 'info' } })
// Agents can run commands on this machine, so only browsers on our own origins may connect
// (blocks other websites from opening a socket to 127.0.0.1).
const allowedOrigins = new Set([
  `http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://127.0.0.1:5173', 'http://localhost:5173',
  ...(process.env.GCNB_ALLOWED_ORIGINS?.split(',') ?? []),
])
const wss = new WebSocketServer({
  server: app.server,
  path: '/ws',
  verifyClient: ({ origin }: { origin: string }) => allowedOrigins.has(origin),
})

const broadcast = (e: ServerEvent) => {
  const s = JSON.stringify(e)
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(s)
}

const runtimes = new Map(db.contacts().map((c) => [c.id, new AgentRuntime(db, c.id, `dm-${c.id}`, broadcast)]))

const snapshot = (): ServerEvent => ({
  type: 'snapshot',
  contacts: db.contacts(),
  threads: db.threads(),
  messages: db.recentMessages(),
  agents: [...runtimes.values()].map((r) => r.state()),
  typing: [...runtimes.values()].filter((r) => r.typing).map((r) => r.contactId),
})

wss.on('connection', (ws) => {
  ws.send(JSON.stringify(snapshot()))
  ws.on('message', (raw) => {
    let json: unknown
    try {
      json = JSON.parse(String(raw))
    } catch {
      return
    }
    const parsed = ClientEvent.safeParse(json)
    if (!parsed.success) return app.log.warn({ issues: parsed.error.issues }, 'bad client event')
    const ev = parsed.data
    // Phase 1 threads are DMs: exactly one member.
    const rt = runtimes.get(db.threadContactIds(ev.threadId)[0] ?? '')
    if (!rt) return
    const state = rt.state()
    const message = db.addMessage({ threadId: ev.threadId, sender: 'user', contactId: null, kind: 'text', body: { text: ev.text, delivered: state.live } })
    broadcast({ type: 'message', message })
    if (state.live) rt.send(ev.text)
    else broadcast({ type: 'message', message: db.addMessage({ threadId: ev.threadId, sender: 'system', contactId: rt.contactId, kind: 'status', body: { text: `Not delivered: ${state.reason}` } }) })
  })
})

app.get('/api/health', async () => ({ ok: true, agents: [...runtimes.values()].map((r) => r.state()) }))

const shutdown = async () => {
  for (const r of runtimes.values()) r.close()
  await app.close()
  db.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await app.listen({ host: '127.0.0.1', port }) // never 0.0.0.0; use `tailscale serve` for the phone
if (!process.env.ANTHROPIC_API_KEY) app.log.warn('ANTHROPIC_API_KEY is not set: chat works, but agents will not reply')

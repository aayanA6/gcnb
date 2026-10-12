import Fastify from 'fastify'
import { WebSocketServer, WebSocket } from 'ws'
import { mkdirSync, readFileSync, statSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClientEvent, PERMISSION_MODES, type ServerEvent } from '@gcnb/shared'
import { openDb } from './db.ts'
import { loadAgents, setAgentModel } from './agents.ts'
import { AgentRuntime } from './runtime/agent.ts'
import { Router } from './router.ts'

const GROUP_CAP = Number(process.env.GCNB_GROUP_HOURLY_CAP_USD ?? 5)

const root = fileURLToPath(new URL('../../..', import.meta.url))
const port = Number(process.env.GCNB_PORT ?? 8787)
const dataDir = process.env.GCNB_DATA_DIR ?? join(root, '.gcnb')
const avatarDir = join(dataDir, 'avatars')
mkdirSync(avatarDir, { recursive: true })
const db = openDb(join(dataDir, 'gcnb.db'))

// Contacts = the agent files. New ones are seeded once; after that the DB owns looks, folder, budget, session.
const COLORS = ['#ffd23f', '#3ddc97', '#ff6b4a', '#b9a5ff', '#5ce1ff']
const agentFiles = loadAgents(process.env.GCNB_AGENTS_DIR ?? join(root, '.claude', 'agents'))
agentFiles.forEach((a, i) =>
  db.seedContact(
    {
      id: a.name,
      agentName: a.name,
      displayName: a.name[0].toUpperCase() + a.name.slice(1),
      avatarPath: null,
      color: COLORS[i % COLORS.length],
      bio: a.description,
      model: a.model ?? process.env.GCNB_MODEL ?? 'sonnet',
      cwd: resolve(process.env.GCNB_CWD ?? root),
      // "allow everything": tools run without asking until Phase 3 approval cards. The server stays on 127.0.0.1.
      permissionMode: [a.permissionMode, process.env.GCNB_PERMISSION_MODE].find((m) => PERMISSION_MODES.includes(m as never)) ?? 'bypassPermissions',
      budgetUsd: Number(process.env.GCNB_BUDGET_USD ?? 2),
    },
    `dm-${a.name}`,
  ),
)

const app = Fastify({ logger: { level: 'info' }, bodyLimit: 2 * 1024 * 1024 })
// Agents can run commands on this machine, so only browsers on our own origins may talk to the server
// (blocks other websites from reaching 127.0.0.1).
const allowedOrigins = new Set([
  `http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://127.0.0.1:5173', 'http://localhost:5173',
  ...(process.env.GCNB_ALLOWED_ORIGINS?.split(',') ?? []),
])
app.addHook('onRequest', async (req, reply) => {
  const origin = req.headers.origin
  if (req.method !== 'GET' && origin && !allowedOrigins.has(origin)) return reply.code(403).send({ error: 'origin not allowed' })
})
const wss = new WebSocketServer({
  server: app.server,
  path: '/ws',
  verifyClient: ({ origin }: { origin: string }) => allowedOrigins.has(origin),
})

const broadcast = (e: ServerEvent) => {
  const s = JSON.stringify(e)
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(s)
}

// Cards left open by a previous run can't be answered: their canUseTool promise died with that process.
for (const a of db.pendingActions()) {
  db.setActionStatus(a.id, 'expired')
  db.patchMessageBody(JSON.parse(a.payloadJson).messageId, { status: 'expired' })
}

const runtimes = new Map<string, AgentRuntime>()
const router = new Router(db, runtimes, broadcast)
for (const a of agentFiles)
  runtimes.set(
    a.name,
    new AgentRuntime(db, a.name, a, broadcast, {
      handOff: (from, d, to, message) => router.handOff(from, d, to, message),
      groupTurnCost: (threadId, usd) => router.recordSpend(threadId, usd),
      isGroup: (threadId) => threadId.startsWith('g-'),
    }),
  )

// Starter group for the trio, so the planner -> coder -> reviewer hand-off chain works out of the box.
const trio = ['planner', 'coder', 'reviewer']
if (trio.every((id) => runtimes.has(id)) && !db.threads().some((t) => t.kind === 'group'))
  db.createGroup({ title: 'launch crew', contactIds: trio, leadContactId: 'planner', hourlyCapUsd: GROUP_CAP })

// Only threads whose members all still have agent files show up; a deleted file hides them but keeps history.
const visibleThreads = () => db.threads().filter((t) => t.contactIds.every((id) => runtimes.has(id)))

const snapshot = (): ServerEvent => {
  const threads = visibleThreads()
  return {
    type: 'snapshot',
    contacts: db.contacts().filter((c) => runtimes.has(c.id)),
    threads: threads.map(router.withSpend),
    messages: threads.flatMap((t) => db.recentMessages(t.id)),
    agents: [...runtimes.values()].map((r) => r.state()),
    typing: [...runtimes.values()].filter((r) => r.typing).map((r) => ({ contactId: r.contactId, threadId: r.threadId })),
  }
}

const systemLine = (contactId: string, text: string) =>
  broadcast({ type: 'message', message: db.addMessage({ threadId: `dm-${contactId}`, sender: 'system', contactId, kind: 'status', body: { text } }) })

function handle(ev: ClientEvent) {
  if (ev.type === 'send') return router.post(ev.threadId, ev.text)

  if (ev.type === 'createGroup') {
    const ids = [...new Set(ev.contactIds)].filter((id) => runtimes.has(id))
    if (ids.length < 2 || !ids.includes(ev.leadContactId)) return app.log.warn('createGroup needs 2+ contacts and a lead among them')
    const thread = db.createGroup({ title: ev.title.replace(/^#/, ''), contactIds: ids, leadContactId: ev.leadContactId, hourlyCapUsd: ev.hourlyCapUsd ?? GROUP_CAP })
    return broadcast({ type: 'thread', thread: router.withSpend(thread) })
  }

  if (ev.type === 'answer') {
    const action = db.action(ev.actionId)
    const rt = action && runtimes.get(action.contactId)
    if (!rt?.answer(ev.actionId, ev)) app.log.warn({ actionId: ev.actionId }, 'answer for a card that is not open')
    return
  }
  if (ev.type === 'interrupt') return void runtimes.get(ev.contactId)?.interrupt()

  // updateContact
  const rt = runtimes.get(ev.contactId)
  const c = db.contact(ev.contactId)
  if (!rt || !c) return
  const patch: Parameters<typeof db.updateContact>[1] = {}
  if (ev.displayName) patch.displayName = ev.displayName
  if (ev.budgetUsd !== undefined) patch.budgetUsd = ev.budgetUsd
  if (ev.permissionMode && ev.permissionMode !== c.permissionMode) patch.permissionMode = ev.permissionMode
  if (ev.model && ev.model !== c.model) {
    patch.model = ev.model
    setAgentModel(agentFiles.find((a) => a.name === c.agentName)!.path, ev.model)
  }
  if (ev.cwd && resolve(ev.cwd) !== c.cwd) {
    const cwd = resolve(ev.cwd)
    let isDir = false
    try {
      isDir = statSync(cwd).isDirectory()
    } catch {}
    if (!isDir) return systemLine(c.id, `Folder not found: ${cwd}`)
    patch.cwd = cwd
    patch.sessionId = null // SDK sessions are stored per folder, so the old one can't be resumed from here
  }
  db.updateContact(c.id, patch)
  if (patch.model || patch.cwd || patch.permissionMode || patch.budgetUsd !== undefined) {
    rt.restart() // new options take effect on the next message
    if (patch.cwd) systemLine(c.id, `Now working in ${patch.cwd}. Sessions are stored per folder, so the next message starts a fresh one.`)
  }
  broadcast({ type: 'contact', contact: db.contact(c.id)! })
  broadcast({ type: 'agent', agent: rt.state() })
}

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
    handle(parsed.data)
  })
})

// Pfps. SVG is excluded on purpose: it can carry script.
const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
app.addContentTypeParser(Object.keys(IMAGE_TYPES), { parseAs: 'buffer' }, (_req, body, done) => done(null, body))

app.post<{ Params: { id: string } }>('/api/contacts/:id/avatar', async (req, reply) => {
  const c = db.contact(req.params.id)
  const ext = IMAGE_TYPES[req.headers['content-type'] ?? '']
  if (!c || !runtimes.has(c.id)) return reply.code(404).send({ error: 'no such contact' })
  if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) return reply.code(415).send({ error: 'send a png, jpeg, webp or gif' })
  for (const f of readdirSync(avatarDir)) if (f.startsWith(`${c.id}.`)) rmSync(join(avatarDir, f))
  writeFileSync(join(avatarDir, `${c.id}.${ext}`), req.body)
  db.updateContact(c.id, { avatarPath: `/api/avatars/${c.id}.${ext}?v=${Date.now()}` })
  const contact = db.contact(c.id)!
  broadcast({ type: 'contact', contact })
  return contact
})

app.get<{ Params: { file: string } }>('/api/avatars/:file', async (req, reply) => {
  const m = /^([a-z0-9][a-z0-9_-]*)\.(png|jpg|webp|gif)$/i.exec(req.params.file)
  if (!m) return reply.code(404).send()
  try {
    const body = readFileSync(join(avatarDir, req.params.file))
    const type = Object.entries(IMAGE_TYPES).find(([, e]) => e === m[2].toLowerCase())![0]
    return reply.type(type).header('x-content-type-options', 'nosniff').send(body)
  } catch {
    return reply.code(404).send()
  }
})

app.get('/api/health', async () => ({ ok: true, agents: [...runtimes.values()].map((r) => ({ ...r.state(), running: r.running })) }))

const shutdown = async () => {
  for (const r of runtimes.values()) r.shutdown()
  await app.close()
  db.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await app.listen({ host: '127.0.0.1', port }) // never 0.0.0.0; use `tailscale serve` for the phone
if (!agentFiles.length) app.log.warn('no contacts: add agent files to .claude/agents/')
if (!process.env.ANTHROPIC_API_KEY) app.log.warn('ANTHROPIC_API_KEY is not set: chat works, but agents will not reply')

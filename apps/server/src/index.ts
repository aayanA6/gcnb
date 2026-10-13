import Fastify from 'fastify'
import { WebSocketServer, WebSocket } from 'ws'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClientEvent, PERMISSION_MODES, noteFor, type ServerEvent } from '@gcnb/shared'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { openDb } from './db.ts'
import { loadAgents, setAgentModel } from './agents.ts'
import { AgentRuntime, checkClaudeAuth } from './runtime/agent.ts'
import { registerMcp } from './mcp.ts'
import { Router } from './router.ts'
import { originAllowed, serveWeb } from './http.ts'
import { Push } from './push.ts'

const GROUP_CAP = Number(process.env.GCNB_GROUP_HOURLY_CAP_USD ?? 5)

const root = fileURLToPath(new URL('../../..', import.meta.url))
const port = Number(process.env.GCNB_PORT ?? 8787)
const dataDir = process.env.GCNB_DATA_DIR ?? join(root, '.gcnb')
const avatarDir = join(dataDir, 'avatars')
mkdirSync(avatarDir, { recursive: true })
const db = openDb(join(dataDir, 'gcnb.db'))
const webDir = process.env.GCNB_WEB_DIR ?? join(root, 'apps', 'web', 'dist')
const WHISPER_URL = process.env.GCNB_WHISPER_URL // a local Whisper server, e.g. whisper.cpp's /inference
const STOP_AFTER_MIN = Number(process.env.GCNB_STOP_AFTER_MIN ?? 0) // 0 = keep running with no tabs open

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
// Only gcnb's own pages may talk to the server (see originAllowed); GCNB_ALLOWED_ORIGINS adds more.
const extraOrigins = new Set(process.env.GCNB_ALLOWED_ORIGINS?.split(',').filter(Boolean) ?? [])
const hostOf = (h: Record<string, string | string[] | undefined>) => String(h['x-forwarded-host'] ?? h.host ?? '').split(',')[0].trim()
app.addHook('onRequest', async (req, reply) => {
  const origin = req.headers.origin
  if (req.method !== 'GET' && origin && !originAllowed(origin, hostOf(req.headers), extraOrigins)) return reply.code(403).send({ error: 'origin not allowed' })
})
const wss = new WebSocketServer({
  server: app.server,
  path: '/ws',
  verifyClient: ({ origin, req }: { origin: string; req: { headers: Record<string, string | string[] | undefined> } }) => originAllowed(origin, hostOf(req.headers), extraOrigins),
})

// Notifications: push to every subscribed browser, but only while no open tab is looking at gcnb.
const push = new Push(dataDir)
const visible = new Set<WebSocket>()
const notify = (e: ServerEvent) => {
  if (e.type !== 'message' || visible.size || !push.count) return
  const t = e.message.threadId.startsWith('g-') ? db.threads().find((t) => t.id === e.message.threadId) : undefined
  const note = noteFor(e.message, (id) => db.contact(id)?.displayName ?? id, t?.title)
  if (note) push.send(note)
}

const broadcast = (e: ServerEvent) => {
  const s = JSON.stringify(e)
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(s)
  notify(e)
}

// Cards left open by a previous run can't be answered: their canUseTool promise died with that process.
for (const a of db.pendingActions()) {
  db.setActionStatus(a.id, 'expired')
  db.patchMessageBody(JSON.parse(a.payloadJson).messageId, { status: 'expired' })
}

// Guards the MCP endpoint every contact's `claude` CLI process calls (hand_off, permission_prompt):
// one random boot token, since the origin hook above only checks requests that carry an Origin header.
const mcpToken = randomUUID()
const mcpUrl = `http://127.0.0.1:${port}/mcp`

const runtimes = new Map<string, AgentRuntime>()
const router = new Router(db, runtimes, broadcast)
for (const a of agentFiles)
  runtimes.set(
    a.name,
    new AgentRuntime(db, a.name, a, broadcast, {
      handOff: (from, d, to, message) => router.handOff(from, d, to, message),
      groupTurnCost: (threadId, usd) => router.recordSpend(threadId, usd),
      isGroup: (threadId) => threadId.startsWith('g-'),
      mcpUrl,
      mcpToken,
    }),
  )
registerMcp(app, runtimes, mcpToken)

// Starter group for the trio, so the planner -> coder -> reviewer hand-off chain works out of the box.
const trio = ['planner', 'coder', 'reviewer']
if (trio.every((id) => runtimes.has(id)) && !db.threads().some((t) => t.kind === 'group'))
  db.createGroup({ title: 'launch crew', contactIds: trio, leadContactId: 'planner', hourlyCapUsd: GROUP_CAP })

// The manager (if there is one) leads #hq, a group of every contact; agents added later join it on the next boot.
if (runtimes.has('manager')) {
  const hq = db.threads().find((t) => t.kind === 'group' && t.title === 'hq')
  if (hq) db.addMembers(hq.id, [...runtimes.keys()])
  else db.createGroup({ title: 'hq', contactIds: [...runtimes.keys()], leadContactId: 'manager', hourlyCapUsd: GROUP_CAP })
}

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

function handle(ev: ClientEvent, ws: WebSocket) {
  if (ev.type === 'send') return router.post(ev.threadId, ev.text)
  if (ev.type === 'visible') return void (ev.on ? visible.add(ws) : visible.delete(ws))

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

// Optional "stop a few minutes after the last tab closes" (GCNB_STOP_AFTER_MIN). Off by default,
// because phone pings need the server running while no tab is open.
let idleStop: NodeJS.Timeout | undefined
const armIdleStop = () => {
  if (STOP_AFTER_MIN > 0 && !wss.clients.size) idleStop = setTimeout(() => void shutdown(), STOP_AFTER_MIN * 60_000)
}

wss.on('connection', (ws) => {
  clearTimeout(idleStop)
  ws.on('close', () => {
    visible.delete(ws)
    armIdleStop()
  })
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
    handle(parsed.data, ws)
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

// What the web app needs to know at boot: the push key and whether local Whisper is set up.
app.get('/api/config', async () => ({ vapidPublicKey: push.publicKey, whisper: !!WHISPER_URL }))

const Subscription = z.object({ endpoint: z.string().url().startsWith('https://'), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) })
app.post('/api/push/subscribe', async (req, reply) => {
  const sub = Subscription.safeParse(req.body)
  if (!sub.success) return reply.code(400).send({ error: 'bad subscription' })
  push.subscribe(sub.data)
  return { ok: true }
})

// Voice: the browser records, we hand the audio to your local Whisper server, so it never leaves the machine.
app.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: 25 * 1024 * 1024 }, (_req, body, done) => done(null, body))
app.post('/api/transcribe', async (req, reply) => {
  if (!WHISPER_URL) return reply.code(404).send({ error: 'set GCNB_WHISPER_URL to use local Whisper' })
  if (!Buffer.isBuffer(req.body) || !req.body.length) return reply.code(415).send({ error: 'send recorded audio' })
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(req.body)], { type: req.headers['content-type'] }), 'speech.webm')
  form.append('response_format', 'json')
  if (process.env.GCNB_WHISPER_MODEL) form.append('model', process.env.GCNB_WHISPER_MODEL) // OpenAI-style servers need one
  try {
    const res = await fetch(WHISPER_URL, { method: 'POST', body: form })
    if (!res.ok) return reply.code(502).send({ error: `Whisper answered ${res.status}` })
    const { text } = (await res.json()) as { text?: string }
    return { text: String(text ?? '').trim() }
  } catch (err) {
    return reply.code(502).send({ error: `Whisper unreachable: ${(err as Error).message}` })
  }
})

app.get('/api/health', async () => ({ ok: true, agents: [...runtimes.values()].map((r) => ({ ...r.state(), running: r.running })) }))

if (existsSync(join(webDir, 'index.html'))) serveWeb(app, webDir)

async function shutdown() {
  for (const r of runtimes.values()) r.shutdown()
  await app.close()
  db.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await app.listen({ host: '127.0.0.1', port }) // never 0.0.0.0; use `tailscale serve` for the phone
armIdleStop()
if (!agentFiles.length) app.log.warn('no contacts: add agent files to .claude/agents/')
if (!checkClaudeAuth()) app.log.warn('claude CLI not found or not logged in (run `claude` once to sign in): chat works, but agents will not reply')

// Phase 2 "done when", storage half: three contacts keep separate sessions and history across a restart.
// Run: pnpm test
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync, existsSync } from 'node:fs'
import { openDb } from './db.ts'
import { parseAgentFile, withModel, agentFileText, agentFilePath } from './agents.ts'
import { AgentRuntime, describeTool, spendAfterResult, type CanUseTool } from './runtime/agent.ts'
import { Router, type Deliverable, type Delivery } from './router.ts'
import { originAllowed } from './http.ts'
import { lastUuid, readSince } from './transcript.ts'
import { noteFor, type Message } from '@gcnb/shared'

const dir = mkdtempSync(join(tmpdir(), 'gcnb-'))
const file = join(dir, 'test.db')
const names = ['planner', 'coder', 'reviewer']
const seed = (id: string) => ({ id, agentName: id, displayName: id, avatarPath: null, color: '#000', bio: '', model: 'sonnet', cwd: dir, permissionMode: 'bypassPermissions', budgetUsd: 2 })

let db = openDb(file)
for (const id of names) {
  db.seedContact(seed(id), `dm-${id}`)
  db.updateContact(id, { sessionId: `sess-${id}` })
  db.addMessage({ threadId: `dm-${id}`, sender: 'user', contactId: null, kind: 'text', body: { text: `hi ${id}`, delivered: true } })
  db.addMessage({ threadId: `dm-${id}`, sender: 'agent', contactId: id, kind: 'text', body: { text: `hey from ${id}` } })
}
db.updateContact('coder', { spentUsd: 0.5, model: 'opus', displayName: 'Bolt' })
db.close()

db = openDb(file) // "restart"
for (const id of names) db.seedContact(seed(id), `dm-${id}`) // re-seeding must not wipe anything
for (const id of names) {
  assert.equal(db.contact(id)?.sessionId, `sess-${id}`)
  assert.deepEqual(db.recentMessages(`dm-${id}`).map((m) => m.body.text), [`hi ${id}`, `hey from ${id}`])
}
assert.equal(db.contact('coder')?.spentUsd, 0.5)
assert.equal(db.contact('coder')?.model, 'opus')
assert.equal(db.contact('coder')?.displayName, 'Bolt')
assert.deepEqual(db.threads().map((t) => t.contactIds), [['planner'], ['coder'], ['reviewer']])
db.close()
rmSync(dir, { recursive: true, force: true })

// Agent files
const md = '---\r\nname: coder\r\ndescription: "Writes code"\r\nmodel: inherit\r\ntools: Read, Edit\r\n---\r\nBe careful.\r\n'
const a = parseAgentFile(md, 'x.md')!
assert.equal(a.name, 'coder')
assert.equal(a.description, 'Writes code')
assert.equal(a.model, undefined) // inherit -> gcnb default
assert.deepEqual(a.tools, ['Read', 'Edit'])
assert.equal(a.prompt, 'Be careful.')
assert.equal(parseAgentFile('---\nname: ../evil\n---\n', 'y.md'), null) // names become ids and filenames
assert.equal(parseAgentFile('no frontmatter', 'z.md'), null)
assert.equal(parseAgentFile(withModel(md, 'opus'), 'x.md')!.model, 'opus')
assert.equal(parseAgentFile(withModel('---\nname: p\n---\nbody', 'haiku'), 'p.md')!.model, 'haiku')
assert.equal(parseAgentFile(withModel(md, 'opus'), 'x.md')!.prompt, 'Be careful.')

// Create a contact from gcnb: the written file round-trips through parseAgentFile, and the path
// resolver rejects a traversal attempt and reports an existing file by returning null/the same path.
{
  const dir5 = mkdtempSync(join(tmpdir(), 'gcnb-'))
  const text = agentFileText({ name: 'newbie', description: 'Tests things: thoroughly', model: 'sonnet', permissionMode: 'default', prompt: 'Be thorough.\nReport back.' })
  const p = agentFilePath(dir5, 'newbie')!
  writeFileSync(p, text)
  const back = parseAgentFile(text, p)!
  assert.equal(back.name, 'newbie')
  assert.equal(back.description, 'Tests things: thoroughly')
  assert.equal(back.model, 'sonnet')
  assert.equal(back.permissionMode, 'default')
  assert.equal(back.prompt, 'Be thorough.\nReport back.')
  // A description with embedded newlines still round-trips (frontmatter is line-based).
  const text2 = agentFileText({ name: 'x', description: 'line one\nline two', prompt: 'body' })
  assert.equal(parseAgentFile(text2, 'x.md')!.description, 'line one line two')

  assert.equal(agentFilePath(dir5, '../evil'), null) // escapes the agents dir
  assert.ok(existsSync(p)) // duplicate check is the caller's job (existsSync(path)); the path itself is still valid
  assert.equal(agentFilePath(dir5, 'newbie'), p)
  rmSync(dir5, { recursive: true, force: true })
}

// Spend: resumed session reports a lifetime total vs. a fresh per-process total.
assert.deepEqual(spendAfterResult(0.5, 0.7, null), { spent: 0.7, lifetime: true })
assert.deepEqual(spendAfterResult(0.5, 0.1, null), { spent: 0.6, lifetime: false })
assert.deepEqual(spendAfterResult(0.5, 0.9, false), { spent: 1.4, lifetime: false })

// Phase 3 "done when", minus the live model: canUseTool raises an approval card backed by pending_actions,
// a tapback answers it, and the SDK gets the matching PermissionResult.
{
  const dir2 = mkdtempSync(join(tmpdir(), 'gcnb-'))
  const db2 = openDb(join(dir2, 'cards.db'))
  db2.seedContact({ ...seed('reviewer'), cwd: dir2, permissionMode: 'default' }, 'dm-reviewer')
  const noHooks = { handOff: () => '', groupTurnCost: () => {}, isGroup: () => false }
  const rt = new AgentRuntime(db2, 'reviewer', { name: 'reviewer', description: '', prompt: '', path: '' }, () => {}, noHooks)
  const canUseTool = (rt as unknown as { canUseTool: CanUseTool }).canUseTool
  const opts = (signal = new AbortController().signal) => ({ signal, toolUseID: 't', requestId: 'r', suggestions: [{ type: 'addRules' as const, rules: [{ toolName: 'Bash', ruleContent: 'pnpm test' }], behavior: 'allow' as const, destination: 'session' as const }] })
  const lastCard = () => db2.recentMessages('dm-reviewer').at(-1)!

  // thumbs-up-twice ("always"): allow + the SDK's suggested rules
  const approval = canUseTool('Bash', { command: 'pnpm test' }, opts())
  const card = lastCard()
  assert.equal(card.kind, 'approval')
  assert.equal(card.body.detail, 'pnpm test')
  assert.equal(card.body.status, 'pending')
  assert.equal(card.body.canAlways, true)
  assert.equal(db2.pendingActions().length, 1) // survives a page refresh: it's in SQLite
  assert.ok(rt.answer(card.body.actionId!, { decision: 'always' }))
  const r1 = (await approval)!
  assert.equal(r1.behavior, 'allow')
  assert.ok(r1.behavior === 'allow' && r1.updatedPermissions?.length)
  assert.equal(db2.message(card.id)!.body.status, 'always')
  assert.equal(db2.pendingActions().length, 0)
  assert.equal(rt.answer(card.body.actionId!, { decision: 'deny' }), false) // already answered

  // thumbs-down
  const denied = canUseTool('Bash', { command: 'rm -rf dist' }, opts())
  rt.answer(lastCard().body.actionId!, { decision: 'deny' })
  assert.equal((await denied)!.behavior, 'deny')

  // question chips: answers keyed by question text go back as updatedInput.answers
  const questions = [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }]
  const asked = canUseTool('AskUserQuestion', { questions }, opts())
  const qCard = lastCard()
  assert.equal(qCard.kind, 'question')
  assert.equal(rt.answer(qCard.body.actionId!, { decision: 'allow' }), false) // questions need answers
  assert.ok(rt.answer(qCard.body.actionId!, { answers: { 'Which?': 'B' } }))
  const r3 = (await asked)!
  assert.ok(r3.behavior === 'allow' && (r3.updatedInput as { answers: Record<string, string> }).answers['Which?'] === 'B')
  assert.deepEqual(db2.message(qCard.id)!.body.answers, { 'Which?': 'B' })

  // stop / abort cancels an open card
  const ac = new AbortController()
  const aborted = canUseTool('Bash', { command: 'sleep 100' }, opts(ac.signal))
  ac.abort()
  assert.equal((await aborted)!.behavior, 'deny')
  assert.equal(lastCard().body.status, 'cancelled')
  db2.close()
  rmSync(dir2, { recursive: true, force: true })
}

// Phase 4 "done when", minus the live model: the server routes group posts and hand-offs, and a
// forced loop pauses after HOP_LIMIT (4) agent-to-agent hops.
{
  const dir3 = mkdtempSync(join(tmpdir(), 'gcnb-'))
  const db3 = openDb(join(dir3, 'group.db'))
  for (const id of names) db3.seedContact({ ...seed(id), displayName: id[0].toUpperCase() + id.slice(1) }, `dm-${id}`)
  const g = db3.createGroup({ title: 'launch crew', contactIds: names, leadContactId: 'planner', hourlyCapUsd: 1 })
  assert.deepEqual([g.kind, g.leadContactId, g.contactIds], ['group', 'planner', names])

  const got: Record<string, Delivery[]> = { planner: [], coder: [], reviewer: [] }
  const fakes = new Map<string, Deliverable>(names.map((id) => [id, { state: () => ({ live: true }), deliver: (d: Delivery) => got[id].push(d) }]))
  const router = new Router(db3, fakes, () => {}, 'Aayan')
  const last = (id: string) => got[id].at(-1)!
  const lines = () => db3.recentMessages(g.id).map((m) => m.body.text)

  // No mention -> the lead; delivery is a prefixed user message into that member's own session.
  router.post(g.id, 'plan the websocket hub')
  assert.equal(last('planner').text, '[#launch crew · from Aayan · lead: planner · members: planner, coder, reviewer] plan the websocket hub')
  assert.equal(last('planner').hops, 0)
  assert.equal(db3.recentMessages(g.id).at(-1)!.body.delivered, true)
  // @mentions by agent or display name, any case; @everyone hits all.
  assert.deepEqual(router.recipients(g, '@coder and @Reviewer please look'), ['coder', 'reviewer'])
  assert.deepEqual(router.recipients(g, '@everyone standup'), names)
  assert.deepEqual(router.recipients(g, 'email me@coder.dev'), ['planner']) // an email address isn't a mention

  // planner -> coder -> reviewer -> planner reports back
  assert.match(router.handOff('planner', last('planner'), 'coder', 'build it'), /Handed off to Coder \(hand-off 1 of 4\)/)
  assert.equal(last('coder').hops, 1)
  assert.match(last('coder').text, /from Planner .*\] build it$/)
  router.handOff('coder', last('coder'), '@reviewer', 'review it')
  router.handOff('reviewer', last('reviewer'), 'Planner', 'looks good, one gap')
  assert.equal(last('planner').hops, 3)
  assert.ok(lines().includes('Planner handed off to Coder') && lines().includes('Reviewer handed off to Planner'))

  // Forced loop: hop 4 still goes through, hop 5 pauses for the user.
  router.handOff('planner', last('planner'), 'coder', 'again')
  assert.equal(last('coder').hops, 4)
  const before = got.reviewer.length
  assert.match(router.handOff('coder', last('coder'), 'reviewer', 'and again'), /^Paused: 4 hand-offs/)
  assert.equal(got.reviewer.length, before) // not delivered
  assert.equal(lines().at(-1), 'Paused after 4 hand-offs, waiting for you')
  // A user post restarts the count.
  router.post(g.id, '@coder keep going')
  assert.equal(last('coder').hops, 0)

  // Bad targets
  assert.match(router.handOff('coder', last('coder'), 'coder', 'me'), /No other member/)
  assert.match(router.handOff('coder', last('coder'), 'ghost', 'x'), /No other member called "ghost"/)
  assert.match(router.handOff('coder', { threadId: 'dm-coder', text: '', hops: 0 }, 'reviewer', 'x'), /only works inside a group/)

  // Group hourly spend cap on top of each contact's cap.
  router.recordSpend(g.id, 1.25)
  assert.equal(router.withSpend(db3.thread(g.id)!).spentHourUsd, 1.25)
  const n = got.planner.length
  router.post(g.id, 'one more thing')
  assert.equal(got.planner.length, n)
  assert.equal(lines().at(-1), 'Paused: #launch crew hit its $1.00/hour spend cap')
  db3.close()
  rmSync(dir3, { recursive: true, force: true })
}

// Migration: a Phase 1-3 database (threads without the group columns) opens and gains them.
{
  const dir4 = mkdtempSync(join(tmpdir(), 'gcnb-'))
  const raw = new Database(join(dir4, 'old.db'))
  raw.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL); INSERT INTO threads VALUES ('dm-x', 'dm', 'X', 1)")
  raw.close()
  const migrated = openDb(join(dir4, 'old.db'))
  assert.deepEqual(migrated.threads().map((t) => [t.id, t.leadContactId, t.hourlyCapUsd]), [['dm-x', null, null]])
  migrated.close()
  rmSync(dir4, { recursive: true, force: true })
}

// Migration: a pre-"subscription runtime" database (contacts without transcript_uuid) opens and gains it.
{
  const dir5m = mkdtempSync(join(tmpdir(), 'gcnb-'))
  const raw = new Database(join(dir5m, 'old.db'))
  raw.exec(`CREATE TABLE contacts (
    id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, display_name TEXT NOT NULL, avatar_path TEXT,
    color TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, cwd TEXT NOT NULL,
    permission_mode TEXT NOT NULL DEFAULT 'default', session_id TEXT,
    budget_usd REAL NOT NULL, spent_usd REAL NOT NULL DEFAULT 0
  );
  INSERT INTO contacts (id, agent_name, display_name, color, model, cwd, budget_usd) VALUES ('x', 'x', 'X', '#000', 'sonnet', '/tmp', 2)`)
  raw.close()
  const migrated = openDb(join(dir5m, 'old.db'))
  assert.equal(migrated.transcriptUuid('x'), null)
  migrated.setTranscriptUuid('x', 'line-9')
  assert.equal(migrated.transcriptUuid('x'), 'line-9')
  migrated.close()
  rmSync(dir5m, { recursive: true, force: true })
}

// Transcript parsing: a synthetic JSONL with a user string-content line, an assistant line mixing
// text and tool_use blocks, a meta line, a text-less tool_result line and a garbage line; the parser
// never throws, skips what it should, and an afterUuid cursor returns only what comes after it.
{
  const dir6 = mkdtempSync(join(tmpdir(), 'gcnb-'))
  const path = join(dir6, 't.jsonl')
  const lines = [
    JSON.stringify({ uuid: 'u1', type: 'user', timestamp: 't1', message: { role: 'user', content: 'hello from the terminal' } }),
    JSON.stringify({ uuid: 'u2', type: 'assistant', timestamp: 't2', message: { content: [{ type: 'text', text: 'sure, doing it' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
    JSON.stringify({ uuid: 'u3', type: 'user', isMeta: true, message: { content: 'meta bookkeeping' } }), // skipped: isMeta
    JSON.stringify({ uuid: 'u4', type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }), // skipped: no text block
    'not valid json at all', // skipped: parser never throws
    JSON.stringify({ uuid: 'u5', type: 'assistant', timestamp: 't5', message: { content: [{ type: 'text', text: 'done' }] } }),
  ]
  writeFileSync(path, `${lines.join('\n')}\n`)
  assert.deepEqual(readSince(path, null).map((l) => [l.uuid, l.type, l.text]), [
    ['u1', 'user', 'hello from the terminal'],
    ['u2', 'assistant', 'sure, doing it'],
    ['u5', 'assistant', 'done'],
  ])
  assert.deepEqual(readSince(path, 'u2').map((l) => l.uuid), ['u5']) // the cursor line itself doesn't come back
  assert.equal(lastUuid(path), 'u5')
  assert.equal(lastUuid(join(dir6, 'missing.jsonl')), null) // never throws on a missing file
  rmSync(dir6, { recursive: true, force: true })
}

// originAllowed: same-origin loopback (including the vite dev proxy, which keeps the browser's Host
// header), tailscale's https *.ts.net, and the extra-origins allowlist; denies everything else,
// including a DNS-rebinding attempt where Origin and Host are made to match on a non-loopback host.
{
  const noExtra = new Set<string>()
  assert.equal(originAllowed('http://127.0.0.1:8787', '127.0.0.1:8787', noExtra), true)
  assert.equal(originAllowed('http://127.0.0.1:5173', '127.0.0.1:5173', noExtra), true) // vite proxy keeps Host
  assert.equal(originAllowed('https://box.tail1234.ts.net', 'box.tail1234.ts.net', noExtra), true)
  assert.equal(originAllowed('http://box.tail1234.ts.net', 'box.tail1234.ts.net', noExtra), false) // tailscale needs https
  assert.equal(originAllowed('http://evil.com', '127.0.0.1:8787', noExtra), false) // foreign origin, loopback host
  assert.equal(originAllowed('http://evil.com:8787', 'evil.com:8787', noExtra), false) // rebinding: Host matches Origin, but neither is loopback/ts.net
  assert.equal(originAllowed(undefined, '127.0.0.1:8787', noExtra), false)
  assert.equal(originAllowed('https://extra.example', 'anything', new Set(['https://extra.example'])), true)
}

// noteFor: what pings your phone (an open card, or a paused group) vs. a finished reply vs. nothing.
{
  const msg = (over: Partial<Message> & { body: Message['body'] }): Message => ({ id: 'm1', threadId: 'dm-coder', sender: 'agent', contactId: 'coder', kind: 'text', createdAt: 0, ...over })
  const nameOf = () => 'Coder'

  const card = msg({ kind: 'approval', body: { text: 'Run tests', detail: 'pnpm test', status: 'pending' } })
  assert.deepEqual(noteFor(card, nameOf), { title: 'Coder needs you', body: 'Run tests: pnpm test', threadId: 'dm-coder', tag: 'dm-coder:needs', urgent: true })
  assert.equal(noteFor(card, nameOf, 'launch crew')!.title, 'Coder needs you in #launch crew')

  const paused = msg({ sender: 'system', contactId: null, kind: 'status', body: { text: 'Paused after 4 hand-offs, waiting for you' } })
  assert.deepEqual(noteFor(paused, nameOf, 'launch crew'), { title: '#launch crew paused', body: 'Paused after 4 hand-offs, waiting for you', threadId: 'dm-coder', tag: 'dm-coder:needs', urgent: true })

  const reply = msg({ sender: 'agent', kind: 'text', body: { text: 'done' } })
  assert.deepEqual(noteFor(reply, nameOf), { title: 'Coder', body: 'done', threadId: 'dm-coder', tag: 'dm-coder', urgent: false })

  assert.equal(noteFor(msg({ sender: 'user', kind: 'text', body: { text: 'hi' } }), nameOf), null)
  assert.equal(noteFor(msg({ kind: 'tool', body: { text: 'Ran npm test' } }), nameOf), null)
  assert.equal(noteFor(msg({ kind: 'approval', body: { text: 'x', status: 'answered' } }), nameOf), null)
}

// Grey tool lines
assert.equal(describeTool('Read', { file_path: join(dir, 'src', 'auth.ts') }, dir), 'Read src/auth.ts')
assert.equal(describeTool('Bash', { command: 'npm   test\n--watch=false' }, dir), 'Ran npm test --watch=false')
assert.equal(describeTool('Edit', { file_path: '/elsewhere/x.ts' }, dir), 'Edited /elsewhere/x.ts')
assert.equal(describeTool('Mystery', {}, dir), 'Used Mystery')

console.log('db.test: ok')

// Phase 2 "done when", storage half: three contacts keep separate sessions and history across a restart.
// Run: pnpm test
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.ts'
import { parseAgentFile, withModel } from './agents.ts'
import { AgentRuntime, describeTool, spendAfterResult } from './runtime/agent.ts'
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import { Router, type Deliverable, type Delivery } from './router.ts'

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
  assert.equal(last('planner').text, '[#launch crew · from Aayan · members: planner, coder, reviewer] plan the websocket hub')
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

// Grey tool lines
assert.equal(describeTool('Read', { file_path: join(dir, 'src', 'auth.ts') }, dir), 'Read src/auth.ts')
assert.equal(describeTool('Bash', { command: 'npm   test\n--watch=false' }, dir), 'Ran npm test --watch=false')
assert.equal(describeTool('Edit', { file_path: '/elsewhere/x.ts' }, dir), 'Edited /elsewhere/x.ts')
assert.equal(describeTool('Mystery', {}, dir), 'Used Mystery')

console.log('db.test: ok')

// Phase 2 "done when", storage half: three contacts keep separate sessions and history across a restart.
// Run: pnpm test
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.ts'
import { parseAgentFile, withModel } from './agents.ts'
import { AgentRuntime, describeTool, spendAfterResult } from './runtime/agent.ts'
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'

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
  const rt = new AgentRuntime(db2, 'reviewer', 'dm-reviewer', { name: 'reviewer', description: '', prompt: '', path: '' }, () => {})
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

// Grey tool lines
assert.equal(describeTool('Read', { file_path: join(dir, 'src', 'auth.ts') }, dir), 'Read src/auth.ts')
assert.equal(describeTool('Bash', { command: 'npm   test\n--watch=false' }, dir), 'Ran npm test --watch=false')
assert.equal(describeTool('Edit', { file_path: '/elsewhere/x.ts' }, dir), 'Edited /elsewhere/x.ts')
assert.equal(describeTool('Mystery', {}, dir), 'Used Mystery')

console.log('db.test: ok')

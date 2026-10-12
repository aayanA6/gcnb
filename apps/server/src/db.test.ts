// Phase 2 "done when", storage half: three contacts keep separate sessions and history across a restart.
// Run: pnpm test
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.ts'
import { parseAgentFile, withModel } from './agents.ts'
import { spendAfterResult } from './runtime/agent.ts'

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

console.log('db.test: ok')

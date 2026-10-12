// Phase 1 "done when", storage half: history and session_id survive a restart. Run: pnpm test
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.ts'
import { spendAfterResult } from './runtime/agent.ts'

const dir = mkdtempSync(join(tmpdir(), 'gcnb-'))
const file = join(dir, 'test.db')
const seed = { id: 'bolt', agentName: 'bolt', displayName: 'Bolt', avatarPath: null, color: '#000', bio: '', model: 'sonnet', cwd: dir, permissionMode: 'default', budgetUsd: 2 }

let db = openDb(file)
db.seedContact(seed, 'dm-bolt')
db.updateContact('bolt', { sessionId: 'sess-123', spentUsd: 0.5 })
db.addMessage({ threadId: 'dm-bolt', sender: 'user', contactId: null, kind: 'text', body: { text: 'hi', delivered: true } })
db.addMessage({ threadId: 'dm-bolt', sender: 'agent', contactId: 'bolt', kind: 'text', body: { text: 'hey' } })
db.close()

db = openDb(file) // "restart"
db.seedContact(seed, 'dm-bolt') // re-seeding must not wipe the session
assert.equal(db.contact('bolt')?.sessionId, 'sess-123')
assert.equal(db.contact('bolt')?.spentUsd, 0.5)
assert.deepEqual(db.recentMessages().map((m) => m.body.text), ['hi', 'hey'])
assert.equal(db.threadContactIds('dm-bolt')[0], 'bolt')
db.close()
rmSync(dir, { recursive: true, force: true })

// Spend: resumed session reports a lifetime total vs. a fresh per-process total.
assert.deepEqual(spendAfterResult(0.5, 0.7, null), { spent: 0.7, lifetime: true })
assert.deepEqual(spendAfterResult(0.5, 0.1, null), { spent: 0.6, lifetime: false })
assert.deepEqual(spendAfterResult(0.5, 0.9, false), { spent: 1.4, lifetime: false })

console.log('db.test: ok')

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { sqliteTable, text, real, integer, primaryKey } from 'drizzle-orm/sqlite-core'
import { eq, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Contact, Message, Thread } from '@gcnb/shared'

export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),
  agentName: text('agent_name').notNull(),
  displayName: text('display_name').notNull(),
  avatarPath: text('avatar_path'),
  color: text('color').notNull(),
  bio: text('bio').notNull(),
  model: text('model').notNull(),
  cwd: text('cwd').notNull(),
  permissionMode: text('permission_mode').notNull(),
  sessionId: text('session_id'),
  budgetUsd: real('budget_usd').notNull(),
  spentUsd: real('spent_usd').notNull(),
})

export const threads = sqliteTable('threads', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['dm', 'group'] }).notNull(),
  title: text('title').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const threadMembers = sqliteTable(
  'thread_members',
  { threadId: text('thread_id').notNull(), contactId: text('contact_id').notNull() },
  (t) => [primaryKey({ columns: [t.threadId, t.contactId] })],
)

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  threadId: text('thread_id').notNull(),
  sender: text('sender', { enum: ['user', 'agent', 'system'] }).notNull(),
  contactId: text('contact_id'),
  kind: text('kind', { enum: ['text', 'tool', 'approval', 'question', 'status'] }).notNull(),
  bodyJson: text('body_json').notNull(),
  createdAt: integer('created_at').notNull(),
})

// Used from Phase 3 (approval cards that survive a refresh); created now so the schema is complete.
export const pendingActions = sqliteTable('pending_actions', {
  id: text('id').primaryKey(),
  contactId: text('contact_id').notNull(),
  threadId: text('thread_id').notNull(),
  type: text('type', { enum: ['approval', 'question'] }).notNull(),
  payloadJson: text('payload_json').notNull(),
  status: text('status').notNull(),
})

// ponytail: hand-written DDL instead of drizzle-kit migrations; add drizzle-kit when the schema starts changing.
const DDL = `
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, display_name TEXT NOT NULL, avatar_path TEXT,
  color TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, cwd TEXT NOT NULL,
  permission_mode TEXT NOT NULL DEFAULT 'default', session_id TEXT,
  budget_usd REAL NOT NULL, spent_usd REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('dm','group')), title TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS thread_members (
  thread_id TEXT NOT NULL REFERENCES threads(id), contact_id TEXT NOT NULL REFERENCES contacts(id),
  PRIMARY KEY (thread_id, contact_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id),
  sender TEXT NOT NULL CHECK (sender IN ('user','agent','system')), contact_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('text','tool','approval','question','status')),
  body_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, created_at);
CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('approval','question')), payload_json TEXT NOT NULL,
  status TEXT NOT NULL
);
`

export function openDb(file: string) {
  const sqlite = new Database(file)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(DDL)
  const db = drizzle(sqlite)

  const toMessage = (r: typeof messages.$inferSelect): Message => ({
    id: r.id,
    threadId: r.threadId,
    sender: r.sender,
    contactId: r.contactId,
    kind: r.kind,
    body: JSON.parse(r.bodyJson),
    createdAt: r.createdAt,
  })

  return {
    close: () => sqlite.close(),

    // Inserts the contact and its DM thread once; later runs keep session_id and spend.
    seedContact(c: Omit<Contact, 'sessionId' | 'spentUsd'>, threadId: string) {
      db.transaction((tx) => {
        tx.insert(contacts).values({ ...c, sessionId: null, spentUsd: 0 }).onConflictDoNothing().run()
        tx.insert(threads).values({ id: threadId, kind: 'dm', title: c.displayName, createdAt: Date.now() }).onConflictDoNothing().run()
        tx.insert(threadMembers).values({ threadId, contactId: c.id }).onConflictDoNothing().run()
      })
    },

    contacts: (): Contact[] => db.select().from(contacts).all(),
    contact: (id: string): Contact | undefined => db.select().from(contacts).where(eq(contacts.id, id)).get(),
    updateContact: (id: string, patch: Partial<Omit<Contact, 'id' | 'agentName'>>) =>
      db.update(contacts).set(patch).where(eq(contacts.id, id)).run(),

    threads(): Thread[] {
      const members = db.select().from(threadMembers).all()
      return db.select().from(threads).all().map((t) => ({
        ...t,
        contactIds: members.filter((m) => m.threadId === t.id).map((m) => m.contactId),
      }))
    },
    threadContactIds: (threadId: string) =>
      db.select().from(threadMembers).where(eq(threadMembers.threadId, threadId)).all().map((m) => m.contactId),

    addMessage(m: Omit<Message, 'id' | 'createdAt'>): Message {
      const row = { id: randomUUID(), threadId: m.threadId, sender: m.sender, contactId: m.contactId, kind: m.kind, bodyJson: JSON.stringify(m.body), createdAt: Date.now() }
      db.insert(messages).values(row).run()
      return toMessage(row)
    },

    message(id: string): Message | undefined {
      const r = db.select().from(messages).where(eq(messages.id, id)).get()
      return r && toMessage(r)
    },
    // Cards change state (pending -> allowed, answered, ...) by merging into their body.
    patchMessageBody(id: string, patch: Partial<Message['body']>): Message | undefined {
      const m = this.message(id)
      if (!m) return
      db.update(messages).set({ bodyJson: JSON.stringify({ ...m.body, ...patch }) }).where(eq(messages.id, id)).run()
      return this.message(id)
    },

    // pending_actions backs an open canUseTool promise so its card survives a page refresh.
    addAction: (a: typeof pendingActions.$inferInsert) => db.insert(pendingActions).values(a).run(),
    action: (id: string) => db.select().from(pendingActions).where(eq(pendingActions.id, id)).get(),
    setActionStatus: (id: string, status: string) => db.update(pendingActions).set({ status }).where(eq(pendingActions.id, id)).run(),
    pendingActions: () => db.select().from(pendingActions).where(eq(pendingActions.status, 'pending')).all(),

    // A thread's latest `limit` messages, oldest first. rowid breaks same-millisecond ties.
    recentMessages: (threadId: string, limit = 300): Message[] =>
      db.select().from(messages).where(eq(messages.threadId, threadId)).orderBy(sql`rowid DESC`).limit(limit).all().reverse().map(toMessage),
  }
}

export type Db = ReturnType<typeof openDb>

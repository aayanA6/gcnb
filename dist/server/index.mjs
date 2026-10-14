// src/index.ts
import Fastify from "fastify";
import { WebSocketServer, WebSocket } from "ws";
import { existsSync as existsSync3, mkdirSync, readFileSync as readFileSync6, statSync as statSync3, writeFileSync as writeFileSync3, rmSync, readdirSync as readdirSync3 } from "node:fs";
import { join as join6, resolve as resolve3 } from "node:path";
import { fileURLToPath } from "node:url";

// ../../packages/shared/src/index.ts
import { z } from "zod";
var Contact = z.object({
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
  spentUsd: z.number()
});
var Thread = z.object({
  id: z.string(),
  kind: z.enum(["dm", "group"]),
  title: z.string(),
  createdAt: z.number(),
  contactIds: z.array(z.string()),
  // thread_members
  // Groups only: who gets un-mentioned posts, and the spend cap on top of each contact's own.
  leadContactId: z.string().nullable(),
  hourlyCapUsd: z.number().nullable(),
  spentHourUsd: z.number().optional()
  // computed by the server
});
var HOP_LIMIT = 4;
var Typing = z.object({ contactId: z.string(), threadId: z.string() });
var Question = z.object({
  question: z.string(),
  header: z.string().optional(),
  multiSelect: z.boolean().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() }))
});
var Message = z.object({
  id: z.string(),
  threadId: z.string(),
  sender: z.enum(["user", "agent", "system"]),
  contactId: z.string().nullable(),
  kind: z.enum(["text", "tool", "approval", "question", "status"]),
  // text/status/tool: { text }; user text adds { delivered }; approval/question cards add the card fields.
  body: z.object({
    text: z.string(),
    delivered: z.boolean().optional(),
    actionId: z.string().optional(),
    // pending_actions row behind an approval/question card
    status: z.enum(["pending", "allow", "always", "deny", "answered", "cancelled", "expired"]).optional(),
    toolName: z.string().optional(),
    detail: z.string().optional(),
    // command, file path or input shown on an approval card
    canAlways: z.boolean().optional(),
    questions: z.array(Question).optional(),
    answers: z.record(z.string(), z.string()).optional(),
    handoff: z.object({ from: z.string(), to: z.string() }).optional(),
    // hand-off pill (contact ids)
    costUsd: z.number().optional(),
    // what the turn behind a group bubble cost
    source: z.enum(["terminal"]).optional()
    // imported from a `claude --resume` turn run outside gcnb
  }).passthrough(),
  createdAt: z.number()
  // epoch ms
});
function noteFor(m, nameOf, groupTitle) {
  const where = groupTitle ? ` in #${groupTitle}` : "";
  const card = (m.kind === "approval" || m.kind === "question") && m.body.status === "pending";
  if (card && m.contactId)
    return { title: `${nameOf(m.contactId)} needs you${where}`, body: m.body.detail ? `${m.body.text}: ${m.body.detail}` : m.body.text, threadId: m.threadId, tag: `${m.threadId}:needs`, urgent: true };
  if (m.sender === "system" && m.body.text.startsWith("Paused"))
    return { title: `#${groupTitle ?? "group"} paused`, body: m.body.text, threadId: m.threadId, tag: `${m.threadId}:needs`, urgent: true };
  if (m.sender === "agent" && m.kind === "text" && m.contactId)
    return { title: `${nameOf(m.contactId)}${where}`, body: m.body.text.slice(0, 300), threadId: m.threadId, tag: m.threadId, urgent: false };
  return null;
}
var PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"];
var CreateContact = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  displayName: z.string().trim().min(1).max(40),
  description: z.string().min(1).max(2e3),
  instructions: z.string().min(1).max(2e4),
  model: z.string().regex(/^[\w.:-]{1,64}$/),
  // same regex as ClientEvent's updateContact
  permissionMode: z.enum(PERMISSION_MODES),
  budgetUsd: z.number().positive().max(1e4).optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  cwd: z.string().min(1).max(500).optional()
});
var Decision = z.enum(["allow", "always", "deny"]);
var AgentState = z.object({
  contactId: z.string(),
  live: z.boolean(),
  reason: z.string().optional()
  // why not live, shown in the UI
});
var ClientEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("send"), threadId: z.string(), text: z.string().min(1).max(2e4) }),
  // Looks apply immediately; engine settings (model, folder, budget) apply from the next message.
  z.object({
    type: z.literal("updateContact"),
    contactId: z.string(),
    displayName: z.string().trim().min(1).max(40).optional(),
    model: z.string().regex(/^[\w.:-]{1,64}$/).optional(),
    cwd: z.string().min(1).max(500).optional(),
    budgetUsd: z.number().positive().max(1e4).optional(),
    permissionMode: z.enum(PERMISSION_MODES).optional()
  }),
  z.object({ type: z.literal("answer"), actionId: z.string(), decision: Decision.optional(), answers: z.record(z.string(), z.string().max(5e3)).optional() }),
  z.object({ type: z.literal("interrupt"), contactId: z.string() }),
  // stop button; also clears that contact's queue
  z.object({ type: z.literal("handToTerminal"), contactId: z.string() }),
  // "Open in terminal": close so two writers don't run at once
  z.object({ type: z.literal("visible"), on: z.boolean() }),
  // tab shown/hidden: push only when no tab is looking
  z.object({
    type: z.literal("createGroup"),
    title: z.string().trim().min(1).max(40),
    contactIds: z.array(z.string()).min(2).max(12),
    leadContactId: z.string(),
    hourlyCapUsd: z.number().positive().max(1e4).optional()
  })
]);
var ServerEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    contacts: z.array(Contact),
    threads: z.array(Thread),
    messages: z.array(Message),
    agents: z.array(AgentState),
    typing: z.array(Typing)
  }),
  z.object({ type: z.literal("message"), message: Message }),
  z.object({ type: z.literal("typing"), contactId: z.string(), threadId: z.string(), on: z.boolean() }),
  z.object({ type: z.literal("agent"), agent: AgentState }),
  z.object({ type: z.literal("contact"), contact: Contact }),
  z.object({ type: z.literal("thread"), thread: Thread })
  // new group, or a group's hourly spend changed
]);

// src/index.ts
import { z as z3 } from "zod";
import { randomUUID as randomUUID3 } from "node:crypto";

// src/db.ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, text, real, integer, primaryKey } from "drizzle-orm/sqlite-core";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
var contacts = sqliteTable("contacts", {
  id: text("id").primaryKey(),
  agentName: text("agent_name").notNull(),
  displayName: text("display_name").notNull(),
  avatarPath: text("avatar_path"),
  color: text("color").notNull(),
  bio: text("bio").notNull(),
  model: text("model").notNull(),
  cwd: text("cwd").notNull(),
  permissionMode: text("permission_mode").notNull(),
  sessionId: text("session_id"),
  budgetUsd: real("budget_usd").notNull(),
  spentUsd: real("spent_usd").notNull(),
  transcriptUuid: text("transcript_uuid")
  // terminal continuity cursor: past this, gcnb hasn't shown it yet
});
var threads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["dm", "group"] }).notNull(),
  title: text("title").notNull(),
  createdAt: integer("created_at").notNull(),
  leadContactId: text("lead_contact_id"),
  hourlyCapUsd: real("hourly_cap_usd")
});
var threadMembers = sqliteTable(
  "thread_members",
  { threadId: text("thread_id").notNull(), contactId: text("contact_id").notNull() },
  (t) => [primaryKey({ columns: [t.threadId, t.contactId] })]
);
var messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  sender: text("sender", { enum: ["user", "agent", "system"] }).notNull(),
  contactId: text("contact_id"),
  kind: text("kind", { enum: ["text", "tool", "approval", "question", "status"] }).notNull(),
  bodyJson: text("body_json").notNull(),
  createdAt: integer("created_at").notNull()
});
var pendingActions = sqliteTable("pending_actions", {
  id: text("id").primaryKey(),
  contactId: text("contact_id").notNull(),
  threadId: text("thread_id").notNull(),
  type: text("type", { enum: ["approval", "question"] }).notNull(),
  payloadJson: text("payload_json").notNull(),
  status: text("status").notNull()
});
var DDL = `
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, display_name TEXT NOT NULL, avatar_path TEXT,
  color TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, cwd TEXT NOT NULL,
  permission_mode TEXT NOT NULL DEFAULT 'default', session_id TEXT,
  budget_usd REAL NOT NULL, spent_usd REAL NOT NULL DEFAULT 0, transcript_uuid TEXT
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('dm','group')), title TEXT NOT NULL,
  created_at INTEGER NOT NULL, lead_contact_id TEXT, hourly_cap_usd REAL
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
`;
function openDb(file) {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(DDL);
  const threadCols = sqlite.prepare("PRAGMA table_info(threads)").all().map((c) => c.name);
  if (!threadCols.includes("lead_contact_id")) sqlite.exec("ALTER TABLE threads ADD COLUMN lead_contact_id TEXT");
  if (!threadCols.includes("hourly_cap_usd")) sqlite.exec("ALTER TABLE threads ADD COLUMN hourly_cap_usd REAL");
  const contactCols = sqlite.prepare("PRAGMA table_info(contacts)").all().map((c) => c.name);
  if (!contactCols.includes("transcript_uuid")) sqlite.exec("ALTER TABLE contacts ADD COLUMN transcript_uuid TEXT");
  const db2 = drizzle(sqlite);
  const toMessage = (r) => ({
    id: r.id,
    threadId: r.threadId,
    sender: r.sender,
    contactId: r.contactId,
    kind: r.kind,
    body: JSON.parse(r.bodyJson),
    createdAt: r.createdAt
  });
  return {
    close: () => sqlite.close(),
    // Inserts the contact and its DM thread once; later runs keep session_id and spend.
    seedContact(c, threadId) {
      db2.transaction((tx) => {
        tx.insert(contacts).values({ ...c, sessionId: null, spentUsd: 0, transcriptUuid: null }).onConflictDoNothing().run();
        tx.insert(threads).values({ id: threadId, kind: "dm", title: c.displayName, createdAt: Date.now() }).onConflictDoNothing().run();
        tx.insert(threadMembers).values({ threadId, contactId: c.id }).onConflictDoNothing().run();
      });
    },
    contacts: () => db2.select().from(contacts).all(),
    contact: (id) => db2.select().from(contacts).where(eq(contacts.id, id)).get(),
    updateContact: (id, patch) => db2.update(contacts).set(patch).where(eq(contacts.id, id)).run(),
    // Terminal continuity cursor: kept off the shared Contact type (the web doesn't need it).
    transcriptUuid: (id) => db2.select({ v: contacts.transcriptUuid }).from(contacts).where(eq(contacts.id, id)).get()?.v ?? null,
    setTranscriptUuid: (id, uuid) => db2.update(contacts).set({ transcriptUuid: uuid }).where(eq(contacts.id, id)).run(),
    threads() {
      const members = db2.select().from(threadMembers).all();
      return db2.select().from(threads).all().map((t) => ({
        ...t,
        contactIds: members.filter((m) => m.threadId === t.id).map((m) => m.contactId)
      }));
    },
    thread(id) {
      return this.threads().find((t) => t.id === id);
    },
    createGroup(g) {
      const id = `g-${randomUUID()}`;
      db2.transaction((tx) => {
        tx.insert(threads).values({ id, kind: "group", title: g.title, createdAt: Date.now(), leadContactId: g.leadContactId, hourlyCapUsd: g.hourlyCapUsd }).run();
        for (const contactId of g.contactIds) tx.insert(threadMembers).values({ threadId: id, contactId }).run();
      });
      return this.thread(id);
    },
    addMembers(threadId, contactIds) {
      for (const contactId of contactIds) db2.insert(threadMembers).values({ threadId, contactId }).onConflictDoNothing().run();
    },
    threadContactIds: (threadId) => db2.select().from(threadMembers).where(eq(threadMembers.threadId, threadId)).all().map((m) => m.contactId),
    addMessage(m) {
      const row = { id: randomUUID(), threadId: m.threadId, sender: m.sender, contactId: m.contactId, kind: m.kind, bodyJson: JSON.stringify(m.body), createdAt: Date.now() };
      db2.insert(messages).values(row).run();
      return toMessage(row);
    },
    message(id) {
      const r = db2.select().from(messages).where(eq(messages.id, id)).get();
      return r && toMessage(r);
    },
    // Cards change state (pending -> allowed, answered, ...) by merging into their body.
    patchMessageBody(id, patch) {
      const m = this.message(id);
      if (!m) return;
      db2.update(messages).set({ bodyJson: JSON.stringify({ ...m.body, ...patch }) }).where(eq(messages.id, id)).run();
      return this.message(id);
    },
    // pending_actions backs an open canUseTool promise so its card survives a page refresh.
    addAction: (a) => db2.insert(pendingActions).values(a).run(),
    action: (id) => db2.select().from(pendingActions).where(eq(pendingActions.id, id)).get(),
    setActionStatus: (id, status) => db2.update(pendingActions).set({ status }).where(eq(pendingActions.id, id)).run(),
    pendingActions: () => db2.select().from(pendingActions).where(eq(pendingActions.status, "pending")).all(),
    // A thread's latest `limit` messages, oldest first. rowid breaks same-millisecond ties.
    recentMessages: (threadId, limit = 300) => db2.select().from(messages).where(eq(messages.threadId, threadId)).orderBy(sql`rowid DESC`).limit(limit).all().reverse().map(toMessage)
  };
}

// src/agents.ts
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
var FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
function parseAgentFile(text2, path) {
  const m = FRONTMATTER.exec(text2);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  if (!fm.name || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(fm.name)) return null;
  return {
    name: fm.name,
    description: fm.description ?? "",
    model: fm.model && fm.model !== "inherit" ? fm.model : void 0,
    tools: fm.tools ? fm.tools.split(",").map((t) => t.trim()).filter(Boolean) : void 0,
    permissionMode: fm.permissionMode || void 0,
    prompt: m[2].trim(),
    path
  };
}
function loadAgents(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort().flatMap((f) => {
    const path = join(dir, f);
    const a = parseAgentFile(readFileSync(path, "utf8"), path);
    if (!a) console.warn(`skipping ${path}: needs frontmatter with a plain name`);
    return a ? [a] : [];
  });
}
function withModel(text2, model) {
  const m = FRONTMATTER.exec(text2);
  if (!m) return text2;
  const lines = m[1].split(/\r?\n/);
  const i = lines.findIndex((l) => /^model:/.test(l));
  if (i >= 0) lines[i] = `model: ${model}`;
  else lines.splice(lines.findIndex((l) => /^name:/.test(l)) + 1, 0, `model: ${model}`);
  return `---
${lines.join("\n")}
---
${m[2]}`;
}
var setAgentModel = (path, model) => writeFileSync(path, withModel(readFileSync(path, "utf8"), model));
function agentFileText(a) {
  const fm = [`name: ${a.name}`, `description: ${a.description.replace(/\r?\n/g, " ")}`];
  if (a.model) fm.push(`model: ${a.model}`);
  if (a.permissionMode) fm.push(`permissionMode: ${a.permissionMode}`);
  return `---
${fm.join("\n")}
---
${a.prompt}
`;
}
function agentFilePath(dir, name) {
  const path = resolve(dir, `${name}.md`);
  return path.startsWith(resolve(dir) + sep) ? path : null;
}

// src/runtime/agent.ts
import { spawn, spawnSync } from "node:child_process";
import { randomUUID as randomUUID2 } from "node:crypto";
import { watch } from "node:fs";
import { isAbsolute, relative } from "node:path";

// src/transcript.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
function transcriptPath(cwd, sessionId) {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return join2(homedir(), ".claude", "projects", slug, `${sessionId}.jsonl`);
}
function readLines(path) {
  try {
    return readFileSync2(path, "utf8").split("\n").filter((l) => l.trim());
  } catch {
    return [];
  }
}
function textOf(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.filter((b) => !!b && typeof b === "object" && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n").trim();
}
function lastUuid(path) {
  const lines = readLines(path);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const uuid = JSON.parse(lines[i]).uuid;
      if (typeof uuid === "string") return uuid;
    } catch {
    }
  }
  return null;
}
function readSince(path, afterUuid) {
  const out = [];
  let seen = !afterUuid;
  for (const line of readLines(path)) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    const uuid = typeof m.uuid === "string" ? m.uuid : void 0;
    if (!seen) {
      if (uuid === afterUuid) seen = true;
      continue;
    }
    if (m.isSidechain || m.isMeta) continue;
    const type = m.type;
    if (type !== "user" && type !== "assistant") continue;
    const text2 = textOf(m.message?.content);
    if (!text2 || !uuid) continue;
    if (type === "user" && /^<(command-|local-command-|system-reminder)/.test(text2)) continue;
    out.push({ uuid, type, timestamp: String(m.timestamp ?? ""), text: text2 });
  }
  return out;
}

// src/runtime/agent.ts
var PERSONA = [
  "You are chatting with the user through gcnb, an iMessage-style app. Reply like a text message: short, plain, conversational. Use markdown only when sharing code.",
  'Group chat messages arrive prefixed like "[#group \xB7 from Name \xB7 lead: x \xB7 members: a, b]". Your final reply in that turn posts to the group.',
  "To pass work to another member of that group, call the hand_off tool with their name and a self-contained message; the server delivers it and their reply posts to the group. Only hand off when someone else should act next.",
  "The group lead (named in the prefix) runs the team: if the lead gave you a task and it is not you, finish it and hand_off your result to the lead. The lead reports to the user."
].join("\n");
var HAND_OFF = "mcp__gcnb__hand_off";
var PERMISSION_PROMPT = "mcp__gcnb__permission_prompt";
var IDLE_MS = Number(process.env.GCNB_IDLE_MIN ?? 30) * 6e4;
var CLAUDE_BIN = process.env.GCNB_CLAUDE_BIN ?? "claude";
function cliEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}
var authOk = null;
function checkClaudeAuth() {
  if (authOk === null) {
    try {
      authOk = spawnSync(CLAUDE_BIN, ["auth", "status"], { timeout: 1e4, windowsHide: true, env: cliEnv() }).status === 0;
    } catch {
      authOk = false;
    }
  }
  return authOk;
}
function inbox() {
  const items = [];
  let wake = null;
  let closed = false;
  const poke = () => {
    wake?.();
    wake = null;
  };
  return {
    push(x) {
      items.push(x);
      poke();
    },
    close() {
      closed = true;
      poke();
    },
    async *[Symbol.asyncIterator]() {
      for (; ; ) {
        while (items.length) yield items.shift();
        if (closed) return;
        await new Promise((r) => wake = r);
      }
    }
  };
}
function spendAfterResult(base, total, lifetime) {
  const isLifetime = lifetime ?? total >= base;
  return { spent: isLifetime ? total : base + total, lifetime: isLifetime };
}
var clip = (s, n = 120) => {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}\u2026` : one;
};
function describeTool(name, input, cwd) {
  const path = (p) => {
    if (typeof p !== "string") return "?";
    const r = relative(cwd, p);
    return (r && !r.startsWith("..") && !isAbsolute(r) ? r : p).replaceAll("\\", "/");
  };
  switch (name) {
    case "Read":
      return `Read ${path(input.file_path)}`;
    case "Edit":
    case "MultiEdit":
      return `Edited ${path(input.file_path)}`;
    case "Write":
      return `Wrote ${path(input.file_path)}`;
    case "NotebookEdit":
      return `Edited ${path(input.notebook_path)}`;
    case "Bash":
      return `Ran ${clip(input.command)}`;
    case "Glob":
      return `Searched for ${clip(input.pattern, 80)}`;
    case "Grep":
      return `Searched for "${clip(input.pattern, 80)}"`;
    case "WebFetch":
      return `Fetched ${clip(input.url, 100)}`;
    case "WebSearch":
      return `Searched the web for "${clip(input.query, 80)}"`;
    case "Task":
    case "Agent":
      return `Started a subagent: ${clip(input.description, 80)}`;
    case "TodoWrite":
      return "Updated the todo list";
    default:
      return `Used ${name}`;
  }
}
function describeRequest(name, input, cwd) {
  if (name === "Bash") return { verb: "run a command", detail: String(input.command ?? "") };
  if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(name))
    return { verb: name === "Write" ? "write a file" : "edit a file", detail: describeTool(name, input, cwd).replace(/^\w+ /, "") };
  if (name === "WebFetch") return { verb: "fetch a page", detail: String(input.url ?? "") };
  return { verb: `use ${name}`, detail: clip(JSON.stringify(input), 400) };
}
var AgentRuntime = class {
  constructor(db2, contactId, agent, emit, hooks) {
    this.db = db2;
    this.contactId = contactId;
    this.agent = agent;
    this.emit = emit;
    this.hooks = hooks;
    this.watchTranscript();
  }
  db;
  contactId;
  agent;
  emit;
  hooks;
  child;
  box;
  idleTimer;
  restartAfterTurn = false;
  interrupted = false;
  // One active turn per contact: deliveries wait here until the current turn's result.
  queue = [];
  current;
  pending = /* @__PURE__ */ new Map();
  // open canUseTool promises by action id
  watcher;
  watchDebounce;
  typing = false;
  get running() {
    return !!this.child;
  }
  /** The thread this contact's current turn belongs to (its DM when idle). */
  get threadId() {
    return this.current?.threadId ?? `dm-${this.contactId}`;
  }
  get contact() {
    return this.db.contact(this.contactId);
  }
  state() {
    const c = this.contact;
    if (!checkClaudeAuth())
      return { contactId: c.id, live: false, reason: "claude CLI not found or not logged in (run `claude` once to sign in)" };
    if (!this.child && c.sessionId && this.hooks.openInTerminal?.(c.sessionId))
      return { contactId: c.id, live: false, reason: "open in a terminal right now: exit it there to reply from here" };
    return { contactId: c.id, live: true };
  }
  /** Queue a message for this contact's session. Caller checks state().live first. */
  deliver(d) {
    if (!this.current) this.importTerminal();
    this.queue.push(d);
    this.pump();
  }
  pump() {
    if (this.current || !this.queue.length) return;
    const d = this.queue.shift();
    clearTimeout(this.idleTimer);
    if (!this.child) this.start();
    this.current = { ...d, startSpent: this.contact.spentUsd };
    this.box.push({ type: "user", message: { role: "user", content: d.text } });
  }
  /** Stop button: an interrupt control_request ends the current turn, open cards are cancelled, queued messages dropped. */
  async interrupt() {
    const dropped = this.queue.length;
    this.queue = [];
    if (dropped) this.post("system", "status", `Dropped ${dropped} queued message${dropped > 1 ? "s" : ""}`);
    if (!this.child || !this.current) return;
    this.interrupted = true;
    for (const id of [...this.pending.keys()]) this.settle(id, "cancelled", { behavior: "deny", message: "The user stopped this turn.", interrupt: true });
    try {
      this.child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: randomUUID2(), request: { subtype: "interrupt" } })}
`);
    } catch {
    }
  }
  close() {
    clearTimeout(this.idleTimer);
    for (const id of [...this.pending.keys()]) this.settle(id, "cancelled", { behavior: "deny", message: "Session closed." });
    this.box?.close();
    this.child?.kill();
    this.child = void 0;
    this.box = void 0;
    this.setTyping(false);
    this.current = void 0;
    this.pump();
  }
  /** Server stop: drop the queue first so close() doesn't start anything new. */
  shutdown() {
    this.queue = [];
    this.watcher?.close();
    this.close();
  }
  /** CLI args are fixed per process: close now (or after the current turn) and resume with new options on the next message. */
  restart() {
    if (this.current) this.restartAfterTurn = true;
    else this.close();
  }
  /** A tapback on an approval card, or chip answers on a question card. Returns false if the card isn't open. */
  answer(actionId, a) {
    const p = this.pending.get(actionId);
    const action = this.db.action(actionId);
    if (!p || !action) return false;
    if (action.type === "question") {
      if (!a.answers) return false;
      return this.settle(actionId, "answered", { behavior: "allow", updatedInput: { ...p.input, answers: a.answers } }, a.answers);
    }
    if (a.decision === "deny") return this.settle(actionId, "deny", { behavior: "deny", message: "The user denied this. Ask what they want instead." });
    if (a.decision === "always")
      return this.settle(actionId, "always", { behavior: "allow", updatedInput: p.input, updatedPermissions: p.suggestions });
    if (a.decision === "allow") return this.settle(actionId, "allow", { behavior: "allow", updatedInput: p.input });
    return false;
  }
  settle(actionId, status, result, answers) {
    const p = this.pending.get(actionId);
    if (!p) return false;
    this.pending.delete(actionId);
    this.db.setActionStatus(actionId, status);
    const message = this.db.patchMessageBody(p.messageId, answers ? { status, answers } : { status });
    if (message) this.emit({ type: "message", message });
    p.resolve(result);
    return true;
  }
  // Fires for tools the permission mode doesn't auto-allow, and always for AskUserQuestion.
  canUseTool = (toolName, input, opts) => {
    const c = this.contact;
    const actionId = randomUUID2();
    const isQuestion = toolName === "AskUserQuestion";
    const req = describeRequest(toolName, input, c.cwd);
    const body = isQuestion ? { text: `${c.displayName} has a question`, actionId, status: "pending", questions: input.questions ?? [] } : {
      text: opts.title ?? `${c.displayName} wants to ${req.verb}`,
      actionId,
      status: "pending",
      toolName,
      detail: req.detail,
      canAlways: !!opts.suggestions?.length && !opts.suppressAlwaysAllowRule
    };
    const message = this.db.addMessage({ threadId: this.threadId, sender: "agent", contactId: this.contactId, kind: isQuestion ? "question" : "approval", body });
    this.db.addAction({
      id: actionId,
      contactId: this.contactId,
      threadId: this.threadId,
      type: isQuestion ? "question" : "approval",
      payloadJson: JSON.stringify({ messageId: message.id, toolName, input, suggestions: opts.suggestions }),
      status: "pending"
    });
    this.setTyping(false);
    this.emit({ type: "message", message });
    return new Promise((resolve4) => {
      this.pending.set(actionId, { resolve: resolve4, messageId: message.id, input, suggestions: opts.suggestions });
      opts.signal.addEventListener("abort", () => this.settle(actionId, "cancelled", { behavior: "deny", message: "Cancelled." }), { once: true });
    });
  };
  /** The gcnb MCP server's permission_prompt tool: the CLI's --permission-prompt-tool. It never sends
   * permission_suggestions (confirmed live), so "always allow" builds its own session-only rule for the tool. */
  permissionPrompt(toolName, input, toolUseId) {
    const suggestions = [{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" }];
    return this.canUseTool(toolName, input, { signal: new AbortController().signal, toolUseID: toolUseId ?? randomUUID2(), requestId: randomUUID2(), suggestions });
  }
  /** The gcnb MCP server's hand_off tool. */
  handOffTool(to, message) {
    return this.current ? this.hooks.handOff(this.contactId, this.current, to, message) : "No active turn.";
  }
  post(sender, kind, text2, extra = {}) {
    const message = this.db.addMessage({ threadId: this.threadId, sender, contactId: this.contactId, kind, body: { text: text2, ...extra } });
    this.emit({ type: "message", message });
  }
  setTyping(on) {
    if (this.typing === on) return;
    this.typing = on;
    this.emit({ type: "typing", contactId: this.contactId, threadId: this.threadId, on });
  }
  // Transcript continuity: gcnb's own turns and a `claude --resume` run straight from a terminal share
  // one transcript file. transcript_uuid is the cursor past everything gcnb has already shown (advanced
  // on every `result`, above); readSince() only ever returns lines written outside gcnb.
  watchTranscript() {
    this.watcher?.close();
    this.watcher = void 0;
    const c = this.contact;
    if (!c.sessionId) return;
    try {
      this.watcher = watch(transcriptPath(c.cwd, c.sessionId), () => {
        if (this.current) return;
        clearTimeout(this.watchDebounce);
        this.watchDebounce = setTimeout(() => this.importTerminal(), 300);
      });
    } catch {
    }
  }
  /** Pulls in lines written since transcript_uuid (terminal turns gcnb hasn't shown yet) as DM messages. */
  importTerminal() {
    const c = this.contact;
    if (!c.sessionId) return;
    const lines = readSince(transcriptPath(c.cwd, c.sessionId), this.db.transcriptUuid(this.contactId));
    if (!lines.length) return;
    for (const l of lines) {
      const message = this.db.addMessage({
        threadId: `dm-${this.contactId}`,
        sender: l.type === "user" ? "user" : "agent",
        contactId: l.type === "user" ? null : this.contactId,
        kind: "text",
        body: { text: l.text, source: "terminal" }
      });
      this.emit({ type: "message", message });
    }
    this.db.setTranscriptUuid(this.contactId, lines.at(-1).uuid);
    if (this.running) this.close();
  }
  start() {
    const c = this.contact;
    const box = inbox();
    const mcpConfig = {
      mcpServers: {
        // Always loaded (not deferred behind tool search): hand_off must be visible to the model
        // from turn 1, and permission_prompt is dispatched directly by the CLI's own permission engine.
        gcnb: { type: "http", url: `${this.hooks.mcpUrl}/${this.contactId}`, headers: { Authorization: `Bearer ${this.hooks.mcpToken}` }, alwaysLoad: true }
      }
    };
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      c.model,
      "--permission-mode",
      c.permissionMode,
      ...c.permissionMode === "bypassPermissions" ? ["--allow-dangerously-skip-permissions"] : [],
      ...c.sessionId ? ["--resume", c.sessionId] : [],
      // Run the session as the contact's own .claude/agents definition, same as `claude --agent`.
      // A terminal session keeps whatever it was: no agent, no texting persona.
      ...this.agent.plain ? [] : [
        "--agents",
        JSON.stringify({
          [this.agent.name]: {
            description: this.agent.description,
            prompt: `${this.agent.prompt}

${PERSONA}`,
            tools: this.agent.tools && [...this.agent.tools, HAND_OFF]
          }
        }),
        "--agent",
        this.agent.name
      ],
      // Agents talk only through gcnb, where you can see it; permission_prompt is internal plumbing, never a callable tool.
      "--disallowedTools",
      "SendMessage",
      "ListAgents",
      PERMISSION_PROMPT,
      "--allowedTools",
      HAND_OFF,
      // routing is gcnb's own tool; never needs an approval card
      "--mcp-config",
      JSON.stringify(mcpConfig),
      "--permission-prompt-tool",
      PERMISSION_PROMPT,
      // Skip ~/.claude settings by default: a global hook could answer tool prompts before gcnb's cards see them.
      "--setting-sources",
      process.env.GCNB_SETTING_SOURCES ?? "project,local"
    ];
    const child = spawn(CLAUDE_BIN, args, { cwd: c.cwd, env: cliEnv(), windowsHide: true });
    child.on("error", (err) => {
      if (this.child === child) {
        this.post("system", "status", `Agent error: ${err.message}`);
        this.queue = [];
        this.close();
      }
    });
    this.child = child;
    this.box = box;
    void this.pumpStdin(child, box);
    void this.consume(child, c.spentUsd);
  }
  async pumpStdin(child, box) {
    for await (const msg of box) {
      try {
        child.stdin.write(`${JSON.stringify(msg)}
`);
      } catch {
      }
    }
  }
  async consume(child, base) {
    let lifetime = null;
    let errored = false;
    let stderr = "";
    child.stderr.on("data", (d) => stderr += d.toString());
    let buf = "";
    try {
      for await (const chunk of child.stdout) {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let m;
          try {
            m = JSON.parse(line);
          } catch {
            continue;
          }
          if (typeof m.session_id === "string" && m.session_id !== this.contact.sessionId) {
            this.db.updateContact(this.contactId, { sessionId: m.session_id });
            this.emit({ type: "contact", contact: this.contact });
            this.watchTranscript();
          }
          const group = this.hooks.isGroup(this.threadId);
          switch (m.type) {
            case "stream_event":
              if (!m.parent_tool_use_id && !this.pending.size) this.setTyping(true);
              break;
            case "assistant": {
              if (m.parent_tool_use_id || m.error) break;
              const content = m.message.content;
              for (const b of content) {
                if (b.type === "text" && b.text?.trim() && !group) this.post("agent", "text", b.text.trim());
                if (b.type === "tool_use" && b.name !== "AskUserQuestion" && b.name !== HAND_OFF)
                  this.post("agent", "tool", describeTool(b.name, b.input ?? {}, this.contact.cwd), { toolName: b.name });
              }
              break;
            }
            case "result": {
              const s = spendAfterResult(base, m.total_cost_usd, lifetime);
              lifetime = s.lifetime;
              this.db.updateContact(this.contactId, { spentUsd: s.spent });
              this.emit({ type: "contact", contact: this.contact });
              if (this.contact.sessionId) {
                const last = lastUuid(transcriptPath(this.contact.cwd, this.contact.sessionId));
                if (last) this.db.setTranscriptUuid(this.contactId, last);
              }
              const cost = this.current ? Math.max(0, s.spent - this.current.startSpent) : 0;
              if (group && m.subtype === "success" && !m.is_error && m.result.trim()) this.post("agent", "text", m.result.trim(), { costUsd: cost });
              if (group) this.hooks.groupTurnCost(this.threadId, cost);
              if (this.interrupted) this.post("system", "status", "Stopped");
              else if (m.subtype !== "success") this.post("system", "status", `Turn stopped (${m.subtype})`);
              else if (m.is_error) this.post("system", "status", `Error: ${m.result}`);
              this.interrupted = false;
              this.setTyping(false);
              this.current = void 0;
              this.emit({ type: "agent", agent: this.state() });
              if (this.restartAfterTurn) {
                this.restartAfterTurn = false;
                this.close();
              } else if (this.queue.length) {
                if (this.state().live) this.pump();
                else this.dropQueue(this.state().reason ?? "offline");
              } else {
                this.idleTimer = setTimeout(() => this.close(), IDLE_MS);
              }
              break;
            }
          }
        }
      }
    } catch (err) {
      if (this.child === child) {
        this.post("system", "status", `Agent error: ${err instanceof Error ? err.message : String(err)}`);
        errored = true;
      }
    } finally {
      if (this.child === child) {
        if (!errored && this.current) this.post("system", "status", `Agent error: process exited${stderr.trim() ? `: ${clip(stderr, 200)}` : ""}`);
        this.queue = [];
        this.close();
      }
    }
  }
  dropQueue(reason) {
    for (const d of this.queue.splice(0))
      this.emit({ type: "message", message: this.db.addMessage({ threadId: d.threadId, sender: "system", contactId: this.contactId, kind: "status", body: { text: `${this.contact.displayName}: not delivered (${reason})` } }) });
  }
};

// src/mcp.ts
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z as z2 } from "zod";
function tokenMatches(got, want) {
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}
var methodNotAllowed = { jsonrpc: "2.0", error: { code: -32e3, message: "Method not allowed." }, id: null };
function registerMcp(app2, runtimes2, token) {
  app2.post("/mcp/:contactId", async (req, reply) => {
    const auth = String(req.headers.authorization ?? "");
    if (!tokenMatches(auth, `Bearer ${token}`)) return reply.code(401).send({ error: "unauthorized" });
    const rt = runtimes2.get(req.params.contactId);
    if (!rt) return reply.code(404).send({ error: "no such contact" });
    const server = new McpServer({ name: "gcnb", version: "1.0.0" });
    server.registerTool(
      "hand_off",
      {
        description: "Pass work to another member of the current group chat. The server delivers your message into their session and their reply posts to the group. Chains pause after a few hand-offs without the user.",
        inputSchema: {
          to: z2.string().describe('Name of the group member to hand off to, e.g. "coder"'),
          message: z2.string().describe("Self-contained instructions for them: what to do and the context they need")
        }
      },
      async ({ to, message }) => ({ content: [{ type: "text", text: rt.handOffTool(to, message) }] })
    );
    server.registerTool(
      "permission_prompt",
      {
        description: "Internal: ask the user for permission to use a tool.",
        inputSchema: { tool_name: z2.string(), input: z2.object({}).passthrough(), tool_use_id: z2.string().optional() }
      },
      async ({ tool_name, input, tool_use_id }) => ({
        content: [{ type: "text", text: JSON.stringify(await rt.permissionPrompt(tool_name, input, tool_use_id)) }]
      })
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: void 0 });
    reply.hijack();
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } finally {
      reply.raw.on("close", () => {
        void transport.close();
        void server.close();
      });
    }
  });
  app2.get("/mcp/:contactId", async (_req, reply) => reply.hijack().raw.writeHead(405, { "content-type": "application/json" }).end(JSON.stringify(methodNotAllowed)));
  app2.delete("/mcp/:contactId", async (_req, reply) => reply.hijack().raw.writeHead(405, { "content-type": "application/json" }).end(JSON.stringify(methodNotAllowed)));
}

// src/router.ts
var HOUR = 36e5;
var escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var Router = class {
  constructor(db2, runtimes2, emit, userName = process.env.GCNB_USER_NAME ?? "You") {
    this.db = db2;
    this.runtimes = runtimes2;
    this.emit = emit;
    this.userName = userName;
  }
  db;
  runtimes;
  emit;
  userName;
  // ponytail: hourly group spend is kept in memory, so a restart forgets the last hour; persist it if the cap must survive restarts.
  spend = /* @__PURE__ */ new Map();
  /** The user posted in a thread. */
  post(threadId, text2) {
    const t = this.db.thread(threadId);
    if (!t) return;
    if (t.kind === "dm") {
      const rt = this.runtimes.get(t.contactIds[0]);
      if (!rt) return;
      const state = rt.state();
      this.add({ threadId, sender: "user", contactId: null, kind: "text", body: { text: text2, delivered: state.live } });
      if (state.live) rt.deliver({ threadId, text: text2, hops: 0 });
      else this.line(threadId, t.contactIds[0], `Not delivered: ${state.reason}`);
      return;
    }
    const message = this.add({ threadId, sender: "user", contactId: null, kind: "text", body: { text: text2, delivered: false } });
    const delivered = this.recipients(t, text2).map((id) => this.deliver(t, id, this.userName, text2, 0) === null);
    if (delivered.some(Boolean)) this.patch(message.id, { delivered: true });
  }
  recipients(t, text2) {
    if (/(^|\s)@everyone\b/i.test(text2)) return t.contactIds;
    const hit = t.contactIds.filter((id) => {
      const c = this.db.contact(id);
      return c && new RegExp(`(^|\\s)@(${escape(c.agentName)}|${escape(c.displayName)})\\b`, "i").test(text2);
    });
    return hit.length ? hit : [t.leadContactId ?? t.contactIds[0]];
  }
  /** The hand_off tool. Returns the tool result the calling agent sees. */
  handOff(fromId, from, to, message) {
    const t = this.db.thread(from.threadId);
    if (!t || t.kind !== "group") return "hand_off only works inside a group chat. Ask the user to add you and the other contact to a group.";
    const target = t.contactIds.filter((id) => id !== fromId).map((id) => this.db.contact(id)).find((c) => [c.agentName, c.displayName].some((n) => n.toLowerCase() === to.replace(/^@/, "").trim().toLowerCase()));
    if (!target) return `No other member called "${to}". Members: ${this.names(t)}.`;
    const hops = from.hops + 1;
    if (hops > HOP_LIMIT) {
      this.line(t.id, fromId, `Paused after ${HOP_LIMIT} hand-offs, waiting for you`);
      return `Paused: ${HOP_LIMIT} hand-offs in a row without the user. Do not hand off again; wrap up and wait for the user.`;
    }
    const fromName = this.db.contact(fromId).displayName;
    this.add({ threadId: t.id, sender: "system", contactId: fromId, kind: "status", body: { text: `${fromName} handed off to ${target.displayName}`, handoff: { from: fromId, to: target.id } } });
    const err = this.deliver(t, target.id, fromName, message, hops);
    return err ? `Not delivered to ${target.displayName}: ${err}` : `Handed off to ${target.displayName} (hand-off ${hops} of ${HOP_LIMIT}). Their reply will post to the group.`;
  }
  /** Called when a group turn finishes, with what it cost. */
  recordSpend(threadId, usd) {
    if (usd <= 0) return;
    this.spend.set(threadId, [...this.recent(threadId), { at: Date.now(), usd }]);
    const t = this.db.thread(threadId);
    if (t) this.emit({ type: "thread", thread: this.withSpend(t) });
  }
  withSpend = (t) => t.kind === "group" ? { ...t, spentHourUsd: this.spentLastHour(t.id) } : t;
  spentLastHour = (threadId) => this.recent(threadId).reduce((sum, s) => sum + s.usd, 0);
  recent(threadId) {
    return (this.spend.get(threadId) ?? []).filter((s) => s.at > Date.now() - HOUR);
  }
  // Delivery = a user message into the member's own session, prefixed with group and sender.
  deliver(t, contactId, from, text2, hops) {
    const rt = this.runtimes.get(contactId);
    const name = this.db.contact(contactId)?.displayName ?? contactId;
    if (!rt) return "not a contact";
    const state = rt.state();
    if (!state.live) {
      this.line(t.id, contactId, `${name}: not delivered (${state.reason})`);
      return state.reason ?? "offline";
    }
    const lead = t.leadContactId ? ` \xB7 lead: ${this.db.contact(t.leadContactId)?.agentName ?? t.leadContactId}` : "";
    rt.deliver({ threadId: t.id, text: `[#${t.title} \xB7 from ${from}${lead} \xB7 members: ${this.names(t)}] ${text2}`, hops });
    return null;
  }
  names(t) {
    return t.contactIds.map((id) => this.db.contact(id)?.agentName ?? id).join(", ");
  }
  add(m) {
    const message = this.db.addMessage(m);
    this.emit({ type: "message", message });
    return message;
  }
  patch(id, body) {
    const message = this.db.patchMessageBody(id, body);
    if (message) this.emit({ type: "message", message });
  }
  line(threadId, contactId, text2) {
    this.add({ threadId, sender: "system", contactId, kind: "status", body: { text: text2 } });
  }
};

// src/http.ts
import { readFileSync as readFileSync3, statSync } from "node:fs";
import { extname, join as join3, resolve as resolve2, sep as sep2 } from "node:path";
var LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
function originAllowed(origin, host, extra) {
  if (!origin) return false;
  if (extra.has(origin)) return true;
  let u;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (!host || u.host !== host) return false;
  return LOOPBACK.test(u.host) || u.protocol === "https:" && u.hostname.endsWith(".ts.net");
}
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};
function serveWeb(app2, dir) {
  const root2 = resolve2(dir);
  app2.get("/*", async (req, reply) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
    let file = resolve2(root2, `.${path}`);
    let isFile = false;
    try {
      isFile = file.startsWith(root2 + sep2) && statSync(file).isFile();
    } catch {
    }
    if (!isFile) file = join3(root2, "index.html");
    reply.header("cache-control", file.includes(`${sep2}assets${sep2}`) ? "public, max-age=31536000, immutable" : "no-cache");
    return reply.type(MIME[extname(file)] ?? "application/octet-stream").send(readFileSync3(file));
  });
}

// src/push.ts
import webpush from "web-push";
import { readFileSync as readFileSync4, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join4 } from "node:path";
var read = (file) => {
  try {
    return JSON.parse(readFileSync4(file, "utf8"));
  } catch {
    return null;
  }
};
var Push = class {
  publicKey;
  subs;
  subsFile;
  constructor(dataDir2) {
    const keyFile = join4(dataDir2, "vapid.json");
    let keys = read(keyFile);
    if (!keys) writeFileSync2(keyFile, JSON.stringify(keys = webpush.generateVAPIDKeys()), { mode: 384 });
    webpush.setVapidDetails(process.env.GCNB_VAPID_SUBJECT ?? "https://github.com/aayanA6/gcnb", keys.publicKey, keys.privateKey);
    this.publicKey = keys.publicKey;
    this.subsFile = join4(dataDir2, "push.json");
    this.subs = read(this.subsFile) ?? [];
  }
  get count() {
    return this.subs.length;
  }
  subscribe(sub) {
    this.subs = [...this.subs.filter((s) => s.endpoint !== sub.endpoint), sub];
    this.save();
  }
  send(note) {
    for (const sub of this.subs)
      webpush.sendNotification(sub, JSON.stringify(note), { TTL: 3600, urgency: note.urgent ? "high" : "normal" }).catch((err) => {
        if (err.statusCode === 404 || err.statusCode === 410) {
          this.subs = this.subs.filter((s) => s.endpoint !== sub.endpoint);
          this.save();
        }
      });
  }
  save() {
    writeFileSync2(this.subsFile, JSON.stringify(this.subs), { mode: 384 });
  }
};

// src/terminals.ts
import { closeSync, existsSync as existsSync2, openSync, readdirSync as readdirSync2, readFileSync as readFileSync5, readSync, statSync as statSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { basename, join as join5 } from "node:path";
var claudeDir = () => join5(homedir2(), ".claude");
var terminalContactId = (sessionId) => `t-${sessionId.slice(0, 8).toLowerCase()}`;
var isTerminalContact = (id) => id.startsWith("t-");
function readWindow(path, size, fromEnd) {
  const fd = openSync(path, "r");
  try {
    const len = statSync2(path).size;
    const n = Math.min(size, len);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, fromEnd ? len - n : 0);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
var parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};
var firstText = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.find((b) => b?.type === "text" && typeof b.text === "string")?.text ?? "";
  return "";
};
var clip2 = (s, n) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}\u2026` : one;
};
function readSession(path) {
  let head, tail;
  try {
    head = readWindow(path, 256 * 1024, false);
    tail = readWindow(path, 128 * 1024, true);
  } catch {
    return null;
  }
  let cwd = "", entrypoint = "", prompt = "", title = "", model, permissionMode;
  for (const m of head.split("\n").map(parse)) {
    if (!m || m.isSidechain) continue;
    if (!cwd && typeof m.cwd === "string") cwd = m.cwd;
    if (!entrypoint && typeof m.entrypoint === "string") entrypoint = m.entrypoint;
    if (!prompt && m.type === "user" && !m.isMeta) {
      const t = firstText(m.message?.content);
      if (t && !t.startsWith("<")) prompt = t;
    }
  }
  for (const m of tail.split("\n").map(parse)) {
    if (!m) continue;
    if (m.type === "ai-title" && typeof m.aiTitle === "string") title = m.aiTitle;
    if (m.type === "custom-title" && typeof m.customTitle === "string") title = m.customTitle;
    if (m.type === "permission-mode" && typeof m.permissionMode === "string") permissionMode = m.permissionMode;
    const mm = m.message?.model;
    if (m.type === "assistant" && typeof mm === "string" && mm !== "<synthetic>") model = mm;
  }
  if (!cwd || entrypoint.startsWith("sdk") || !existsSync2(cwd)) return null;
  return {
    sessionId: basename(path, ".jsonl"),
    cwd,
    title: clip2(title || prompt || basename(cwd), 40),
    model,
    permissionMode,
    mtime: statSync2(path).mtimeMs
  };
}
function recentSessions(days, max = 20) {
  const root2 = join5(claudeDir(), "projects");
  if (days <= 0 || !existsSync2(root2)) return [];
  const since = Date.now() - days * 864e5;
  const files = [];
  for (const dir of readdirSync2(root2)) {
    let names;
    try {
      names = readdirSync2(join5(root2, dir));
    } catch {
      continue;
    }
    for (const f of names) {
      if (!/^[0-9a-f-]{36}\.jsonl$/i.test(f)) continue;
      const path = join5(root2, dir, f);
      try {
        const mtime = statSync2(path).mtimeMs;
        if (mtime >= since) files.push({ path, mtime });
      } catch {
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const f of files) {
    if (out.length >= max) break;
    const s = readSession(f.path);
    if (s) out.push(s);
  }
  return out;
}
var alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};
function openSessions() {
  const out = /* @__PURE__ */ new Map();
  const dir = join5(claudeDir(), "sessions");
  let names;
  try {
    names = readdirSync2(dir);
  } catch {
    return out;
  }
  for (const f of names) {
    if (!/^\d+\.json$/.test(f)) continue;
    try {
      const s = JSON.parse(readFileSync5(join5(dir, f), "utf8"));
      if (String(s.entrypoint ?? "").startsWith("sdk")) continue;
      if (s.kind === "interactive" && typeof s.sessionId === "string" && Number.isInteger(s.pid) && alive(s.pid)) out.set(s.sessionId, s.pid);
    } catch {
    }
  }
  return out;
}

// src/index.ts
var GROUP_CAP = Number(process.env.GCNB_GROUP_HOURLY_CAP_USD ?? 5);
var root = fileURLToPath(new URL("../../..", import.meta.url));
var port = Number(process.env.GCNB_PORT ?? 8787);
var dataDir = process.env.GCNB_DATA_DIR ?? join6(root, ".gcnb");
var avatarDir = join6(dataDir, "avatars");
mkdirSync(avatarDir, { recursive: true });
var db = openDb(join6(dataDir, "gcnb.db"));
var webDir = process.env.GCNB_WEB_DIR ?? join6(root, "apps", "web", "dist");
var WHISPER_URL = process.env.GCNB_WHISPER_URL;
var STOP_AFTER_MIN = Number(process.env.GCNB_STOP_AFTER_MIN ?? 0);
var TERMINAL_DAYS = Number(process.env.GCNB_TERMINAL_DAYS ?? 3);
var COLORS = ["#ffd23f", "#3ddc97", "#ff6b4a", "#b9a5ff", "#5ce1ff"];
var agentsDir = process.env.GCNB_AGENTS_DIR ?? join6(root, ".claude", "agents");
var agentFiles = loadAgents(agentsDir);
agentFiles.forEach(
  (a, i) => db.seedContact(
    {
      id: a.name,
      agentName: a.name,
      displayName: a.name[0].toUpperCase() + a.name.slice(1),
      avatarPath: null,
      color: COLORS[i % COLORS.length],
      bio: a.description,
      model: a.model ?? process.env.GCNB_MODEL ?? "sonnet",
      cwd: resolve3(process.env.GCNB_CWD ?? root),
      // "allow everything": tools run without asking until Phase 3 approval cards. The server stays on 127.0.0.1.
      permissionMode: [a.permissionMode, process.env.GCNB_PERMISSION_MODE].find((m) => PERMISSION_MODES.includes(m)) ?? "bypassPermissions",
      budgetUsd: Number(process.env.GCNB_BUDGET_USD ?? 2)
    },
    `dm-${a.name}`
  )
);
var app = Fastify({ logger: { level: "info" }, bodyLimit: 2 * 1024 * 1024 });
var extraOrigins = new Set(process.env.GCNB_ALLOWED_ORIGINS?.split(",").filter(Boolean) ?? []);
var hostOf = (h) => String(h["x-forwarded-host"] ?? h.host ?? "").split(",")[0].trim();
app.addHook("onRequest", async (req, reply) => {
  const origin = req.headers.origin;
  if (req.method !== "GET" && origin && !originAllowed(origin, hostOf(req.headers), extraOrigins)) return reply.code(403).send({ error: "origin not allowed" });
});
var wss = new WebSocketServer({
  server: app.server,
  path: "/ws",
  verifyClient: ({ origin, req }) => originAllowed(origin, hostOf(req.headers), extraOrigins)
});
var push = new Push(dataDir);
var visible = /* @__PURE__ */ new Set();
var notify = (e) => {
  if (e.type !== "message" || visible.size || !push.count) return;
  const t = e.message.threadId.startsWith("g-") ? db.threads().find((t2) => t2.id === e.message.threadId) : void 0;
  const note = noteFor(e.message, (id) => db.contact(id)?.displayName ?? id, t?.title);
  if (note) push.send(note);
};
var broadcast = (e) => {
  const s = JSON.stringify(e);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(s);
  notify(e);
};
for (const a of db.pendingActions()) {
  db.setActionStatus(a.id, "expired");
  db.patchMessageBody(JSON.parse(a.payloadJson).messageId, { status: "expired" });
}
var mcpToken = randomUUID3();
var mcpUrl = `http://127.0.0.1:${port}/mcp`;
var runtimes = /* @__PURE__ */ new Map();
var router = new Router(db, runtimes, broadcast);
var terminalOpen = openSessions();
function addRuntime(a) {
  const rt = new AgentRuntime(db, a.name, a, broadcast, {
    handOff: (from, d, to, message) => router.handOff(from, d, to, message),
    groupTurnCost: (threadId, usd) => router.recordSpend(threadId, usd),
    isGroup: (threadId) => threadId.startsWith("g-"),
    mcpUrl,
    mcpToken,
    openInTerminal: (sessionId) => terminalOpen.has(sessionId)
  });
  runtimes.set(a.name, rt);
  rt.importTerminal();
  return rt;
}
function syncHq() {
  if (!runtimes.has("manager")) return;
  const team = [...runtimes.keys()].filter((id) => !isTerminalContact(id));
  const hq = db.threads().find((t) => t.kind === "group" && t.title === "hq");
  if (hq) db.addMembers(hq.id, team);
  else db.createGroup({ title: "hq", contactIds: team, leadContactId: "manager", hourlyCapUsd: GROUP_CAP });
}
function addTerminal(s) {
  const id = terminalContactId(s.sessionId);
  if (!db.contact(id)) {
    db.seedContact(
      {
        id,
        agentName: id,
        displayName: s.title,
        avatarPath: null,
        color: COLORS[runtimes.size % COLORS.length],
        bio: `Terminal session in ${s.cwd}`,
        model: s.model ?? process.env.GCNB_MODEL ?? "sonnet",
        cwd: s.cwd,
        permissionMode: PERMISSION_MODES.includes(s.permissionMode) ? s.permissionMode : "default",
        budgetUsd: 0
        // unused: no spend caps
      },
      `dm-${id}`
    );
    db.updateContact(id, { sessionId: s.sessionId });
  }
  return addRuntime({ name: id, description: "", prompt: "", path: "", plain: true });
}
for (const c of db.contacts()) if (isTerminalContact(c.id) && c.sessionId) addRuntime({ name: c.id, description: "", prompt: "", path: "", plain: true });
for (const a of agentFiles) addRuntime(a);
registerMcp(app, runtimes, mcpToken);
var ownSessions = () => new Set(db.contacts().map((c) => c.sessionId).filter(Boolean));
function scanTerminals() {
  const before = new Map([...runtimes.values()].map((r) => [r.contactId, JSON.stringify(r.state())]));
  terminalOpen = openSessions();
  const owned = ownSessions();
  let added = false;
  for (const s of recentSessions(TERMINAL_DAYS)) {
    if (owned.has(s.sessionId) || runtimes.has(terminalContactId(s.sessionId))) continue;
    addTerminal(s);
    added = true;
  }
  if (added) return broadcast(snapshot());
  for (const r of runtimes.values()) if (before.get(r.contactId) !== JSON.stringify(r.state())) broadcast({ type: "agent", agent: r.state() });
}
var trio = ["planner", "coder", "reviewer"];
if (trio.every((id) => runtimes.has(id)) && !db.threads().some((t) => t.kind === "group"))
  db.createGroup({ title: "launch crew", contactIds: trio, leadContactId: "planner", hourlyCapUsd: GROUP_CAP });
syncHq();
var visibleThreads = () => db.threads().filter((t) => t.contactIds.every((id) => runtimes.has(id)));
var snapshot = () => {
  const threads2 = visibleThreads();
  return {
    type: "snapshot",
    contacts: db.contacts().filter((c) => runtimes.has(c.id)),
    threads: threads2.map(router.withSpend),
    messages: threads2.flatMap((t) => db.recentMessages(t.id)),
    agents: [...runtimes.values()].map((r) => r.state()),
    typing: [...runtimes.values()].filter((r) => r.typing).map((r) => ({ contactId: r.contactId, threadId: r.threadId }))
  };
};
scanTerminals();
setInterval(scanTerminals, 5e3).unref();
var systemLine = (contactId, text2) => broadcast({ type: "message", message: db.addMessage({ threadId: `dm-${contactId}`, sender: "system", contactId, kind: "status", body: { text: text2 } }) });
function handle(ev, ws) {
  if (ev.type === "send") return router.post(ev.threadId, ev.text);
  if (ev.type === "visible") return void (ev.on ? visible.add(ws) : visible.delete(ws));
  if (ev.type === "createGroup") {
    const ids = [...new Set(ev.contactIds)].filter((id) => runtimes.has(id));
    if (ids.length < 2 || !ids.includes(ev.leadContactId)) return app.log.warn("createGroup needs 2+ contacts and a lead among them");
    const thread = db.createGroup({ title: ev.title.replace(/^#/, ""), contactIds: ids, leadContactId: ev.leadContactId, hourlyCapUsd: ev.hourlyCapUsd ?? GROUP_CAP });
    return broadcast({ type: "thread", thread: router.withSpend(thread) });
  }
  if (ev.type === "answer") {
    const action = db.action(ev.actionId);
    const rt2 = action && runtimes.get(action.contactId);
    if (!rt2?.answer(ev.actionId, ev)) app.log.warn({ actionId: ev.actionId }, "answer for a card that is not open");
    return;
  }
  if (ev.type === "interrupt") return void runtimes.get(ev.contactId)?.interrupt();
  if (ev.type === "handToTerminal") return void runtimes.get(ev.contactId)?.close();
  const rt = runtimes.get(ev.contactId);
  const c = db.contact(ev.contactId);
  if (!rt || !c) return;
  const patch = {};
  if (ev.displayName) patch.displayName = ev.displayName;
  if (ev.budgetUsd !== void 0) patch.budgetUsd = ev.budgetUsd;
  if (ev.permissionMode && ev.permissionMode !== c.permissionMode) patch.permissionMode = ev.permissionMode;
  if (ev.model && ev.model !== c.model) {
    patch.model = ev.model;
    const file = agentFiles.find((a) => a.name === c.agentName);
    if (file) setAgentModel(file.path, ev.model);
  }
  if (ev.cwd && resolve3(ev.cwd) !== c.cwd && !isTerminalContact(c.id)) {
    const cwd = resolve3(ev.cwd);
    let isDir = false;
    try {
      isDir = statSync3(cwd).isDirectory();
    } catch {
    }
    if (!isDir) return systemLine(c.id, `Folder not found: ${cwd}`);
    patch.cwd = cwd;
    patch.sessionId = null;
  }
  db.updateContact(c.id, patch);
  if (patch.model || patch.cwd || patch.permissionMode || patch.budgetUsd !== void 0) {
    rt.restart();
    if (patch.cwd) systemLine(c.id, `Now working in ${patch.cwd}. Sessions are stored per folder, so the next message starts a fresh one.`);
  }
  broadcast({ type: "contact", contact: db.contact(c.id) });
  broadcast({ type: "agent", agent: rt.state() });
}
var idleStop;
var armIdleStop = () => {
  if (STOP_AFTER_MIN > 0 && !wss.clients.size) idleStop = setTimeout(() => void shutdown(), STOP_AFTER_MIN * 6e4);
};
wss.on("connection", (ws) => {
  clearTimeout(idleStop);
  ws.on("close", () => {
    visible.delete(ws);
    armIdleStop();
  });
  ws.send(JSON.stringify(snapshot()));
  ws.on("message", (raw) => {
    let json;
    try {
      json = JSON.parse(String(raw));
    } catch {
      return;
    }
    const parsed = ClientEvent.safeParse(json);
    if (!parsed.success) return app.log.warn({ issues: parsed.error.issues }, "bad client event");
    handle(parsed.data, ws);
  });
});
var IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
app.addContentTypeParser(Object.keys(IMAGE_TYPES), { parseAs: "buffer" }, (_req, body, done) => done(null, body));
app.post("/api/contacts", async (req, reply) => {
  const parsed = CreateContact.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "bad contact", issues: parsed.error.issues });
  const data = parsed.data;
  if (runtimes.has(data.name)) return reply.code(409).send({ error: `a contact named "${data.name}" already exists` });
  const path = agentFilePath(agentsDir, data.name);
  if (!path || existsSync3(path)) return reply.code(409).send({ error: `a contact named "${data.name}" already exists` });
  const cwd = data.cwd ? resolve3(data.cwd) : resolve3(process.env.GCNB_CWD ?? root);
  let isDir = false;
  try {
    isDir = statSync3(cwd).isDirectory();
  } catch {
  }
  if (!isDir) return reply.code(400).send({ error: `Folder not found: ${cwd}`, issues: [{ path: ["cwd"], message: `Folder not found: ${cwd}` }] });
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync3(path, agentFileText({ name: data.name, description: data.description, model: data.model, permissionMode: data.permissionMode, prompt: data.instructions }));
  const a = { name: data.name, description: data.description, model: data.model, permissionMode: data.permissionMode, prompt: data.instructions, path };
  db.seedContact(
    {
      id: a.name,
      agentName: a.name,
      displayName: data.displayName,
      avatarPath: null,
      color: data.color ?? COLORS[agentFiles.length % COLORS.length],
      bio: data.description,
      model: data.model,
      cwd,
      permissionMode: data.permissionMode,
      budgetUsd: data.budgetUsd ?? Number(process.env.GCNB_BUDGET_USD ?? 2)
    },
    `dm-${a.name}`
  );
  agentFiles.push(a);
  addRuntime(a);
  syncHq();
  broadcast(snapshot());
  return db.contact(a.name);
});
app.post("/api/contacts/:id/avatar", async (req, reply) => {
  const c = db.contact(req.params.id);
  const ext = IMAGE_TYPES[req.headers["content-type"] ?? ""];
  if (!c || !runtimes.has(c.id)) return reply.code(404).send({ error: "no such contact" });
  if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) return reply.code(415).send({ error: "send a png, jpeg, webp or gif" });
  for (const f of readdirSync3(avatarDir)) if (f.startsWith(`${c.id}.`)) rmSync(join6(avatarDir, f));
  writeFileSync3(join6(avatarDir, `${c.id}.${ext}`), req.body);
  db.updateContact(c.id, { avatarPath: `/api/avatars/${c.id}.${ext}?v=${Date.now()}` });
  const contact = db.contact(c.id);
  broadcast({ type: "contact", contact });
  return contact;
});
app.get("/api/avatars/:file", async (req, reply) => {
  const m = /^([a-z0-9][a-z0-9_-]*)\.(png|jpg|webp|gif)$/i.exec(req.params.file);
  if (!m) return reply.code(404).send();
  try {
    const body = readFileSync6(join6(avatarDir, req.params.file));
    const type = Object.entries(IMAGE_TYPES).find(([, e]) => e === m[2].toLowerCase())[0];
    return reply.type(type).header("x-content-type-options", "nosniff").send(body);
  } catch {
    return reply.code(404).send();
  }
});
app.get("/api/config", async () => ({ vapidPublicKey: push.publicKey, whisper: !!WHISPER_URL }));
var Subscription = z3.object({ endpoint: z3.string().url().startsWith("https://"), keys: z3.object({ p256dh: z3.string().max(200), auth: z3.string().max(100) }) });
app.post("/api/push/subscribe", async (req, reply) => {
  const sub = Subscription.safeParse(req.body);
  if (!sub.success) return reply.code(400).send({ error: "bad subscription" });
  push.subscribe(sub.data);
  return { ok: true };
});
app.addContentTypeParser(/^audio\//, { parseAs: "buffer", bodyLimit: 25 * 1024 * 1024 }, (_req, body, done) => done(null, body));
app.post("/api/transcribe", async (req, reply) => {
  if (!WHISPER_URL) return reply.code(404).send({ error: "set GCNB_WHISPER_URL to use local Whisper" });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return reply.code(415).send({ error: "send recorded audio" });
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(req.body)], { type: req.headers["content-type"] }), "speech.webm");
  form.append("response_format", "json");
  if (process.env.GCNB_WHISPER_MODEL) form.append("model", process.env.GCNB_WHISPER_MODEL);
  try {
    const res = await fetch(WHISPER_URL, { method: "POST", body: form });
    if (!res.ok) return reply.code(502).send({ error: `Whisper answered ${res.status}` });
    const { text: text2 } = await res.json();
    return { text: String(text2 ?? "").trim() };
  } catch (err) {
    return reply.code(502).send({ error: `Whisper unreachable: ${err.message}` });
  }
});
app.get("/api/health", async () => ({ ok: true, agents: [...runtimes.values()].map((r) => ({ ...r.state(), running: r.running })) }));
if (existsSync3(join6(webDir, "index.html"))) serveWeb(app, webDir);
async function shutdown() {
  for (const r of runtimes.values()) r.shutdown();
  await app.close();
  db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await app.listen({ host: "127.0.0.1", port });
armIdleStop();
if (!agentFiles.length) app.log.warn("no contacts: add agent files to .claude/agents/");
if (!checkClaudeAuth()) app.log.warn("claude CLI not found or not logged in (run `claude` once to sign in): chat works, but agents will not reply");

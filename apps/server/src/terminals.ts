// Terminal sessions as chats: every interactive `claude` session you ran in a terminal (or the IDE)
// lately shows up in gcnb as a contact, so you can read it and reply to it from the chat. Discovery
// reads Claude Code's own files: transcripts in ~/.claude/projects/<slug>/<session>.jsonl, and the
// running-session registry in ~/.claude/sessions/<pid>.json (one file per live CLI process).
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export type TerminalSession = { sessionId: string; cwd: string; title: string; model?: string; permissionMode?: string; mtime: number }

const claudeDir = () => join(homedir(), '.claude')

/** A terminal session's contact id: `t-` + the start of its session id (fits the contact-id rule). */
export const terminalContactId = (sessionId: string) => `t-${sessionId.slice(0, 8).toLowerCase()}`
export const isTerminalContact = (id: string) => id.startsWith('t-')

// Transcripts can be many MB; the fields we need sit near the start (cwd, entrypoint, first prompt)
// and the end (latest ai-title, model, permission mode), so read only those two windows.
function readWindow(path: string, size: number, fromEnd: boolean): string {
  const fd = openSync(path, 'r')
  try {
    const len = statSync(path).size
    const n = Math.min(size, len)
    const buf = Buffer.alloc(n)
    readSync(fd, buf, 0, n, fromEnd ? len - n : 0)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

const parse = (line: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(line)
  } catch {
    return null // includes the partial first/last line of a window
  }
}

const firstText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.find((b) => b?.type === 'text' && typeof b.text === 'string')?.text ?? ''
  return ''
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/** Reads one transcript's header and tail. Null if it isn't an interactive session we can resume. */
export function readSession(path: string): TerminalSession | null {
  let head: string, tail: string
  try {
    head = readWindow(path, 256 * 1024, false)
    tail = readWindow(path, 128 * 1024, true)
  } catch {
    return null
  }
  let cwd = '', entrypoint = '', prompt = '', title = '', model: string | undefined, permissionMode: string | undefined
  for (const m of head.split('\n').map(parse)) {
    if (!m || m.isSidechain) continue
    if (!cwd && typeof m.cwd === 'string') cwd = m.cwd
    if (!entrypoint && typeof m.entrypoint === 'string') entrypoint = m.entrypoint
    if (!prompt && m.type === 'user' && !m.isMeta) {
      const t = firstText((m.message as { content?: unknown })?.content)
      if (t && !t.startsWith('<')) prompt = t // skip <command-name>, <local-command-stdout> and friends
    }
  }
  for (const m of tail.split('\n').map(parse)) {
    if (!m) continue
    if (m.type === 'ai-title' && typeof m.aiTitle === 'string') title = m.aiTitle
    if (m.type === 'custom-title' && typeof m.customTitle === 'string') title = m.customTitle
    if (m.type === 'permission-mode' && typeof m.permissionMode === 'string') permissionMode = m.permissionMode
    const mm = (m.message as { model?: unknown } | undefined)?.model
    if (m.type === 'assistant' && typeof mm === 'string' && mm !== '<synthetic>') model = mm
  }
  // gcnb's own contacts (and any other headless run) are `claude -p`, entrypoint sdk-*; they're not yours to pick up.
  if (!cwd || entrypoint.startsWith('sdk') || !existsSync(cwd)) return null
  return {
    sessionId: basename(path, '.jsonl'),
    cwd,
    title: clip(title || prompt || basename(cwd), 40),
    model,
    permissionMode,
    mtime: statSync(path).mtimeMs,
  }
}

/** Interactive sessions touched in the last `days`, newest first, at most `max`. */
export function recentSessions(days: number, max = 20): TerminalSession[] {
  const root = join(claudeDir(), 'projects')
  if (days <= 0 || !existsSync(root)) return []
  const since = Date.now() - days * 86_400_000
  const files: { path: string; mtime: number }[] = []
  for (const dir of readdirSync(root)) {
    let names: string[]
    try {
      names = readdirSync(join(root, dir))
    } catch {
      continue
    }
    for (const f of names) {
      if (!/^[0-9a-f-]{36}\.jsonl$/i.test(f)) continue
      const path = join(root, dir, f)
      try {
        const mtime = statSync(path).mtimeMs
        if (mtime >= since) files.push({ path, mtime })
      } catch {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const out: TerminalSession[] = []
  for (const f of files) {
    if (out.length >= max) break
    const s = readSession(f.path)
    if (s) out.push(s)
  }
  return out
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' // exists, just not ours to signal
  }
}

/** Session ids currently open in an interactive Claude Code process (a terminal or IDE), with that pid. */
export function openSessions(): Map<string, number> {
  const out = new Map<string, number>()
  const dir = join(claudeDir(), 'sessions')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const f of names) {
    if (!/^\d+\.json$/.test(f)) continue
    try {
      const s = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      // Headless `claude -p` runs (gcnb's own included) register too, as kind interactive with an sdk-* entrypoint.
      if (String(s.entrypoint ?? '').startsWith('sdk')) continue
      if (s.kind === 'interactive' && typeof s.sessionId === 'string' && Number.isInteger(s.pid) && alive(s.pid)) out.set(s.sessionId, s.pid)
    } catch {}
  }
  return out
}

// Contacts come from Claude Code's own subagent files (.claude/agents/*.md), so an agent defined
// once works in both places. Looks (pfp, color, display name) live in gcnb's DB, never in these files.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

export type AgentFile = {
  name: string
  description: string
  model?: string
  tools?: string[]
  permissionMode?: string
  prompt: string
  path: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

// ponytail: flat `key: value` frontmatter only (what Claude Code agent files use); swap in a YAML parser if lists appear.
export function parseAgentFile(text: string, path: string): AgentFile | null {
  const m = FRONTMATTER.exec(text)
  if (!m) return null
  const fm: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2')
  }
  // The name becomes a contact id, URL segment and avatar filename, so keep it plain.
  if (!fm.name || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(fm.name)) return null
  return {
    name: fm.name,
    description: fm.description ?? '',
    model: fm.model && fm.model !== 'inherit' ? fm.model : undefined,
    tools: fm.tools ? fm.tools.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
    permissionMode: fm.permissionMode || undefined,
    prompt: m[2].trim(),
    path,
  }
}

export function loadAgents(dir: string): AgentFile[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .flatMap((f) => {
      const path = join(dir, f)
      const a = parseAgentFile(readFileSync(path, 'utf8'), path)
      if (!a) console.warn(`skipping ${path}: needs frontmatter with a plain name`)
      return a ? [a] : []
    })
}

// Model edits write back to the agent file so the CLI stays in sync (plan: "Agent file model: plus SQLite").
export function withModel(text: string, model: string): string {
  const m = FRONTMATTER.exec(text)
  if (!m) return text
  const lines = m[1].split(/\r?\n/)
  const i = lines.findIndex((l) => /^model:/.test(l))
  if (i >= 0) lines[i] = `model: ${model}`
  else lines.splice(lines.findIndex((l) => /^name:/.test(l)) + 1, 0, `model: ${model}`)
  return `---\n${lines.join('\n')}\n---\n${m[2]}`
}

export const setAgentModel = (path: string, model: string) =>
  writeFileSync(path, withModel(readFileSync(path, 'utf8'), model))

// Writes a brand-new contact's agent file in the same frontmatter format parseAgentFile reads back
// (plan: "Create a contact from gcnb"). Newlines in description are flattened: frontmatter is line-based.
export function agentFileText(a: { name: string; description: string; model?: string; permissionMode?: string; prompt: string }): string {
  const fm = [`name: ${a.name}`, `description: ${a.description.replace(/\r?\n/g, ' ')}`]
  if (a.model) fm.push(`model: ${a.model}`)
  if (a.permissionMode) fm.push(`permissionMode: ${a.permissionMode}`)
  return `---\n${fm.join('\n')}\n---\n${a.prompt}\n`
}

// Where a new contact's file would live; null if the name would escape the agents dir. Names are
// already regex-checked by the caller (same rule as parseAgentFile's), so this is defense in depth,
// the same pattern as avatar paths in index.ts.
export function agentFilePath(dir: string, name: string): string | null {
  const path = resolve(dir, `${name}.md`)
  return path.startsWith(resolve(dir) + sep) ? path : null
}

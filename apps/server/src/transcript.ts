// Imports a contact's Claude Code terminal transcript into gcnb's own history (plan: "Subscription
// runtime" > terminal continuity). gcnb's own turns land in the exact same file as a `claude --resume`
// turn run straight from a terminal; the caller tracks a cursor (contacts.transcript_uuid, advanced
// past everything gcnb itself wrote) so readSince() only ever returns lines written outside gcnb.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type TranscriptLine = { uuid: string; type: 'user' | 'assistant'; timestamp: string; text: string }

// Claude Code's own project-folder slug: every non-alphanumeric character becomes '-'. Verified live:
// C:\Users\aayan\OneDrive\Desktop\gcnb -> C--Users-aayan-OneDrive-Desktop-gcnb
export function transcriptPath(cwd: string, sessionId: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  return join(homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`)
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim())
  } catch {
    return []
  }
}

// Plain string content, or an array of blocks (text / tool_use / tool_result / thinking / ...).
// Only text blocks count toward a line's text; a line with none (pure tool_use or tool_result) has none.
function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/** The uuid of the transcript's last recognizable line, or null (no file yet, or no uuid in it). Never throws. */
export function lastUuid(path: string): string | null {
  const lines = readLines(path)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const uuid = JSON.parse(lines[i]).uuid
      if (typeof uuid === 'string') return uuid
    } catch {}
  }
  return null
}

/** Conversational lines written after `afterUuid` (or all of them, if null). Skips tool-use/tool-result,
 * thinking, meta and sidechain lines, and anything with no text. Never throws on a line it doesn't recognize. */
export function readSince(path: string, afterUuid: string | null): TranscriptLine[] {
  const out: TranscriptLine[] = []
  let seen = !afterUuid
  for (const line of readLines(path)) {
    let m: Record<string, unknown>
    try {
      m = JSON.parse(line)
    } catch {
      continue
    }
    const uuid = typeof m.uuid === 'string' ? m.uuid : undefined
    if (!seen) {
      if (uuid === afterUuid) seen = true
      continue // the cursor line itself (already shown) and everything before it
    }
    if (m.isSidechain || m.isMeta) continue
    const type = m.type
    if (type !== 'user' && type !== 'assistant') continue
    const text = textOf((m.message as { content?: unknown } | undefined)?.content)
    if (!text || !uuid) continue
    if (type === 'user' && /^<(command-|local-command-|system-reminder)/.test(text)) continue // slash-command plumbing, not a message
    out.push({ uuid, type, timestamp: String(m.timestamp ?? ''), text })
  }
  return out
}

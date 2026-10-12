# gcnb roadmap

Source of truth: *gcnb — execution plan* (Sep 30, 2026). Each phase ends in something you can actually use.

| Phase | Build | Done when | Status |
|---|---|---|---|
| **0. Spike** | ~40-line script: `query()` in streaming mode, log every message type, save `session_id`, kill it, resume, ask "what did I just say?" | Resume works, and you've seen partial text, a tool call, a `canUseTool` prompt and a result with its cost | Folded into Phase 1 |
| **1. One DM, end to end** | Repo scaffold, one hardcoded contact, WebSocket events, bubbles, typing indicator, SQLite history | You chat in the browser, restart the server, and both the chat and the agent's memory survive | ✅ Done (see notes) |
| **2. Contacts** | Load `.claude/agents`, contact list, pfp upload with an initials fallback, per-contact model, folder and budget, idle close (~30 min) and resume | Three contacts with separate sessions, all surviving a restart | ✅ Done (see notes) |
| **3. See and steer** | Grey tool lines, approval cards with tapbacks, question chips, stop button (`Query.interrupt()`), spend on the contact card, "Open in terminal" | An agent asks to run a shell command and you approve it with a tapback | Next |
| **4. Group chat** | Threads and members, routing, `hand_off` tool (in-process MCP via `createSdkMcpServer()`), loop guards (4 hops, one turn per contact, group spend cap per hour) | Planner hands to coder, coder to reviewer, reviewer reports back; a forced loop pauses at 4 hops | |
| **5. iMessage everywhere** | Light and dark themes, full visual polish from the UI templates, browser notifications, `tailscale serve`, installable PWA, voice (local Whisper), package as a Claude Code plugin (`/gcnb`) | Your phone buzzes when an agent needs you and you approve from the phone | |
| **6. Stretch** | Agents that text first on a schedule, import an existing CLI session as a contact, agent view bridge experiment, Tauri window | Pick based on what you actually miss after using Phase 5 | |

## Phase 1 notes

What shipped:
- pnpm monorepo: `apps/server`, `apps/web`, `packages/shared`.
- `packages/shared` holds zod schemas for every WebSocket event (`snapshot`, `message`, `typing`, `agent`, `contact` server→client; `send` client→server). Both ends parse every frame.
- SQLite via better-sqlite3 and Drizzle with all five plan tables: `contacts`, `threads`, `thread_members`, `messages`, `pending_actions`. `pending_actions` stays unused until Phase 3.
- One hardcoded contact, Bolt, seeded once so later runs keep its `session_id` and spend.
- `apps/server/src/runtime/agent.ts` holds all SDK handling: `query()` in streaming input mode, `includePartialMessages` driving "typing…", `resume` with the stored `session_id`, `maxBudgetUsd` set to the remaining budget, `disallowedTools: [SendMessage, ListAgents]`, and a `canUseTool` that denies until Phase 3 approval cards.
- Graceful degradation: with no `ANTHROPIC_API_KEY`, or once the budget is spent, messages are still saved and the UI shows why the agent is offline.
- Theme token system: `themes/*.json` for Cartoon, HUD, Nightwatch, Citadel and Phosphor. The UI reads only CSS variables built from the tokens.
- Security: the server binds 127.0.0.1 only, and the WebSocket checks the browser's origin.

Verified: `pnpm test` (history and session_id survive a DB reopen), typecheck, web build, and the server booting and listening. Live agent replies need `ANTHROPIC_API_KEY` and have not yet been exercised on this machine.

Known gaps carried forward: tool activity lines, approvals and the stop button (Phase 3); idle close (Phase 2); `app_settings` table for the theme choice (it lives in localStorage for now).

## Phase 2 notes

What shipped:
- **Contacts:** contacts load from `.claude/agents/*.md`. The repo ships a planner, coder and reviewer trio.
  - Each contact's SDK session runs *as* its agent (SDK `agents` + `agent` options), so the same file works with `claude --agent`.
  - Each new contact is seeded into SQLite once: display name, color, folder, budget, permission mode. After that the DB owns looks, folder, budget and `session_id`.
  - Deleting an agent file hides that contact but keeps its history.
- **Contact list:** a sidebar with role tags, last message and "typing…".
- **Contact card:**
  - Click the pfp to upload one (png/jpeg/webp/gif, 2 MB max, stored in `.gcnb/avatars/`). Without one, the contact shows its initials.
  - Name changes immediately.
  - Model, folder and budget take effect on the next message: the runtime closes its process (after the current turn, if one is running) and resumes the same `session_id` with the new options.
  - A model change is also written back to the agent file's `model:` line.
  - A folder change starts a fresh session, because SDK sessions are stored per folder.
- **Idle close:** each contact's process closes after `GCNB_IDLE_MIN` (default 30) idle minutes, and the next message resumes it.
- **Permissions:** default permission mode is `bypassPermissions` (decision: "allow everything"), so tools run without asking until Phase 3 approval cards. `AskUserQuestion` is pushed back to plain-text questions until chips exist.
  - Override per agent with a `permissionMode:` line in its file, or globally with `GCNB_PERMISSION_MODE`.
  - The server stays bound to 127.0.0.1, with Origin checks on the WebSocket and on every non-GET request.

Verified:
- `pnpm test`: three contacts keep separate sessions, history and edits across a DB reopen, and the agent-file parser handles model write-back.
- Typecheck and web build.
- A bounded server smoke test: three contacts load, pfp upload works, a foreign origin gets 403, a path-traversal request gets 404.
- Not yet exercised: live replies and session resume, which need `ANTHROPIC_API_KEY`.

## Decisions

- Monthly API budget: not set. Per-contact cap defaults to $2 (`GCNB_BUDGET_USD`) on `sonnet`.
- First three contacts: planner, coder and reviewer trio.
- First test repo: open. Contacts work in this repo by default; point a contact at another folder from its card.
- TypeScript end to end.
- Browser only for now; Tauri stays a Phase 6 stretch.

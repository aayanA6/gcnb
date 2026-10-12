# gcnb roadmap

Source of truth: *gcnb — execution plan* (Sep 30, 2026). Each phase ends in something you can actually use.

| Phase | Build | Done when | Status |
|---|---|---|---|
| **0. Spike** | ~40-line script: `query()` in streaming mode, log every message type, save `session_id`, kill it, resume, ask "what did I just say?" | Resume works, and you've seen partial text, a tool call, a `canUseTool` prompt and a result with its cost | Folded into Phase 1 |
| **1. One DM, end to end** | Repo scaffold, one hardcoded contact, WebSocket events, bubbles, typing indicator, SQLite history | You chat in the browser, restart the server, and both the chat and the agent's memory survive | ✅ Done (see notes) |
| **2. Contacts** | Load `.claude/agents`, contact list, pfp upload with an initials fallback, per-contact model, folder and budget, idle close (~30 min) and resume | Three contacts with separate sessions, all surviving a restart | ✅ Done (see notes) |
| **3. See and steer** | Grey tool lines, approval cards with tapbacks, question chips, stop button (`Query.interrupt()`), spend on the contact card, "Open in terminal" | An agent asks to run a shell command and you approve it with a tapback | ✅ Built (see notes) |
| **4. Group chat** | Threads and members, routing, `hand_off` tool (in-process MCP via `createSdkMcpServer()`), loop guards (4 hops, one turn per contact, group spend cap per hour) | Planner hands to coder, coder to reviewer, reviewer reports back; a forced loop pauses at 4 hops | ✅ Built (see notes) |
| **5. iMessage everywhere** | Light and dark themes, full visual polish from the UI templates, browser notifications, `tailscale serve`, installable PWA, voice (local Whisper), package as a Claude Code plugin (`/gcnb`) | Your phone buzzes when an agent needs you and you approve from the phone | ✅ Built (see notes) |
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

## Phase 3 notes

What shipped:
- **Grey tool lines:** every main-agent `tool_use` block becomes a `tool` message, e.g. "Read src/auth.ts", "Ran npm test", "Edited apps/web/src/App.tsx". Paths are shown relative to the contact's folder.
- **Approval cards** come from the `canUseTool` callback, with three tapbacks:
  - 👍 **Allow once** is the biggest button and also the **Y** key.
  - ‼️ **Always allow** returns the SDK's `suggestions` as `updatedPermissions`. It only appears when the SDK offers suggestions.
  - 👎 **Deny** (also the **N** key).
  - The card shows the command, file or input. Once answered, it turns into "👍 Allowed once", "👎 Denied" and so on.
- **Question chips:** `AskUserQuestion` becomes a card with one chip per option plus "Other…" for free text. Multi-select and multi-question cards get a Send button; a single single-select question answers on one tap. Answers go back as `updatedInput.answers`, keyed by question text.
- **`pending_actions` backs every card:** each open card has a row (payload = tool input + suggestions + message id) and lives in `messages`, so a page refresh shows it again, still answerable.
  - If the server restarts, the canUseTool promise is gone, so leftover cards are marked **expired** at boot instead of hanging forever.
- **Stop button:** shown while the agent is typing or waiting on you. It calls `Query.interrupt()`, cancels open cards and posts a grey "Stopped" line.
- **Contact card:** spend so far against the budget, a "Before risky tools" picker (Ask me first / Accept edits / Plan only / Allow everything), and **Open in terminal**, which copies `cd "<folder>" && claude --resume <session_id>`. The same button also sits in the chat header.
- **"Needs you":** an open card puts a red dot on the contact's pfp, shows "Needs you" in the list and "Waiting on you" in the header.
- **Permission defaults:** new contacts still default to **Allow everything** (`bypassPermissions`), keeping the user's global preference. The **reviewer** ships with `permissionMode: default` so approval cards fire out of the box. Any contact can switch from its card; the change applies from the next message.

Verified:
- `pnpm test` round-trips `canUseTool` → card + `pending_actions` row → tapback → `PermissionResult`: allow-always with rules, deny, question answers, and abort → cancelled. It also covers the grey-line wording.
- A bounded WebSocket smoke test against the real server:
  - a foreign origin gets 401;
  - the reviewer loads as ask-first;
  - a card left pending across a restart comes back expired and can't be answered;
  - a permission-mode edit applies, and an invalid mode is rejected.
- **Not yet exercised live:** a real agent requesting `Bash` and you tapping 👍. That needs `ANTHROPIC_API_KEY`. To try it: DM the reviewer "run the tests", tap 👍 or press Y.

Not done yet: "Always allow" rules last only for that session (`destination` comes from the SDK's suggestion). Persisting them to `.claude/settings.local.json` is left for the contact-settings work.

## Phase 4 notes

What shipped:
- **Groups:** `threads` gained `lead_contact_id` and `hourly_cap_usd`. Older databases are migrated in place on open. Members live in `thread_members`.
  - Create a group from **+ Group** (name, members, lead, hourly cap).
  - A starter **#launch crew** (planner as lead, coder, reviewer; $5/hour) is created on first run if no group exists.
- **Server-side routing** (`apps/server/src/router.ts`, no model involved):
  - A post goes to each `@mentioned` member (agent or display name, any case; `@everyone` = all). With no mention it goes to the group's lead. Email addresses don't count as mentions.
  - Delivery is a user message into the member's **own** session, prefixed `[#launch crew · from Aayan · members: planner, coder, reviewer]` (`GCNB_USER_NAME` sets your name). Each agent keeps its own context.
  - When an agent's group turn ends, its final text (`result`) posts to the group as its bubble. In DMs every text block still posts as before.
- **`hand_off(to, message)`:**
  - An in-process MCP tool built with `createSdkMcpServer()` + `tool()`, exposed as `mcp__gcnb__hand_off`.
  - It's in `allowedTools`, so it never raises an approval card, and it's appended to agents that restrict `tools:`.
  - The router delivers the message into the target's session and posts a hand-off pill (pfp → pfp, "Planner handed off to Coder"). The calling agent gets a tool result like "Handed off to Coder (hand-off 1 of 4)".
- **Guards:**
  - **Hop limit:** each delivery carries a hop count. A user post resets it to 0, and each hand-off adds 1. Hop 5 is refused, the group gets "Paused after 4 hand-offs, waiting for you", and the agent is told to stop handing off.
  - **One active turn per contact:** each runtime keeps its own delivery queue and only feeds the SDK the next message after the current turn's `result`. So a reply is always tied to the thread it came from, and nothing gets folded into another group's turn.
  - **Group hourly spend cap** on top of each contact's `maxBudgetUsd`: each group turn's cost is recorded, and deliveries stop with "Paused: #group hit its $X/hour spend cap" once the last hour's spend reaches the cap.
  - **`disallowedTools: ['SendMessage', 'ListAgents']`** in every gcnb session, so agents can only talk through gcnb.
- **"What is everyone doing":**
  - Every member's grey tool lines, typing dots and cards land in the group they're working for, tagged with their pfp and name.
  - The group panel lists members with Needs you / Typing / Idle, the lead, the hop limit and the hourly spend.
  - **Pause all** interrupts every busy member and drops their queues.
  - Mention chips (@Planner, @Coder, @Reviewer, @everyone) sit above the composer.

Verified:
- `pnpm test` covers routing with fake runtimes:
  - an unmentioned post goes to the lead with the right prefix; mentions and `@everyone` work, emails don't count;
  - the **planner → coder → reviewer → planner** chain, with pills and hop counts 1-2-3;
  - a **forced loop** delivers hop 4 and pauses on hop 5;
  - a user post resets the count;
  - unknown, self and DM hand-offs are refused, and the hourly cap blocks deliveries;
  - an old-schema database migrates.
- A bounded WebSocket smoke test against the real server:
  - the starter group is created with lead and cap;
  - an @mention post routes to coder and reviewer (each shows "not delivered" without an API key);
  - `createGroup` works, and a one-member group is rejected.
- **Not yet exercised live:** real agents choosing to call `hand_off`. That needs `ANTHROPIC_API_KEY`. To try it, post in #launch crew: "Plan a tiny change, hand it to coder to make it, then coder hands to reviewer, and reviewer reports back."

Not done yet:
- The hourly group spend is kept in memory, so a restart forgets the last hour.
- The hop limit is the global `HOP_LIMIT = 4`, not a per-group setting.
- Typing indicators are per contact, so a member busy in a DM won't show as typing in a group.

## Phase 5 notes

What shipped:
- **Themes:** light and dark palettes plus a system-matching Auto mode, and a new Cartoon Night theme (`themes/cartoon-night.json`) alongside the existing five.
- **Phone layout:** a responsive single-column layout for narrow viewports, with search, filters, unread and date pills in the contact list.
- **Notifications:** Web Push (`apps/server/src/push.ts`, VAPID keys kept in the data dir) with an in-page fallback and visible-tab gating — the server pushes only while no open tab is looking at gcnb (`notify()` in `apps/server/src/index.ts`).
- **PWA:** manifest, service worker and icon set under `apps/web/public/`, so the app installs to a phone's home screen.
- **Tailscale-safe origin check:** `originAllowed()` (`apps/server/src/http.ts`) allows loopback and the browser's own `*.ts.net` HTTPS origin, matching Origin against the request's own Host so a DNS-rebinding attempt on a foreign host is refused even when its Host header is made to match. The server also serves the built web app itself (`serveWeb()`), so `tailscale serve` has one target.
- **Voice:** recordings POST to `/api/transcribe`, forwarded to a local Whisper server (`GCNB_WHISPER_URL`, e.g. whisper.cpp's `whisper-server --convert`; `GCNB_WHISPER_MODEL` for OpenAI-style servers). With no server configured, the composer falls back to the browser's own speech recognition.
- **Claude Code plugin:** the repo root is the plugin root (`.claude-plugin/plugin.json` + `marketplace.json`, `skills/gcnb/SKILL.md`, `bin/gcnb`, `hooks/hooks.json`). `pnpm build:plugin` (`scripts/build-plugin.mjs`) builds the web app into `dist/web` and esbuild-bundles the server into `dist/server/index.mjs` (`@gcnb/shared` bundled in, real npm deps externalized), plus a trimmed `dist/server/package.json`. `/gcnb up` copies the bundle into `${CLAUDE_PLUGIN_DATA}/app`, starts it detached, and opens a browser tab; `/gcnb stop` and `/gcnb status` manage it. A `SessionStart` hook (`hooks/hooks.json` → `gcnb install-deps`) installs the server's prod dependencies into `${CLAUDE_PLUGIN_DATA}` whenever the shipped manifest changes.

Verified:
- `pnpm --filter @gcnb/server test`: `originAllowed()` (loopback, the vite dev proxy's Host-preserving case, `*.ts.net` over https only, a foreign origin, and a DNS-rebinding attempt where Origin and Host are made to match on a non-loopback host) and `noteFor()` (a pending card is urgent, a group adds "in #title", a paused-group system line is urgent, an agent reply is a non-urgent per-thread tag, and a user line / tool line / already-answered card produce no notification).
- `pnpm --filter @gcnb/server typecheck`.
- `pnpm build:plugin` produces `dist/web/index.html` and `dist/server/index.mjs`; `node --check dist/server/index.mjs` passes.
- A bounded smoke test of `bin/gcnb` against a temp `${CLAUDE_PLUGIN_DATA}` (node_modules pointed at the repo's own, since `install-deps` wasn't exercised): `up` copies the bundle, starts the server and waits for `/api/health`; a second `up` recognizes it's already running; `stop` kills it and clears the PID file; `status` reports correctly before, during and after, and nothing was left running.
- `pnpm -r typecheck` and the web build.
- A bounded smoke test of the real server (tester pass): it serves the built page, `sw.js` and the manifest with the right types; `/../` and `/%2e%2e/` traversal fall back to `index.html` without leaking files; `/api/nope` is a JSON 404; `/api/config` returns the VAPID key; a foreign-origin POST to `/api/push/subscribe` gets 403, while a bad body or an `http://` endpoint gets 400; `/api/transcribe` without Whisper gets 404. On the WebSocket, a foreign origin is refused, same-origin is accepted, and a `*.ts.net` origin is accepted only when `X-Forwarded-Host` matches (as `tailscale serve` sends it).
- **Not yet exercised live:** a real phone buzzing over `tailscale serve`, and `gcnb install-deps`'s `npm install` into `${CLAUDE_PLUGIN_DATA}`. To try the phone: `pnpm --filter @gcnb/web build`, start the server, `tailscale serve --bg 8787`, open the `*.ts.net` URL on your phone, Add to Home Screen, tap **Turn on pings**, lock the phone, then DM the reviewer "run the tests".

Not done yet:
- `app_settings` table: theme and other prefs still live in `localStorage`, not SQLite.
- Piper read-aloud (agent replies spoken back).
- A settings screen built from the UI template.
- Per-contact worktrees.

## Phase 6

Deliberately deferred, per the plan: pick based on what you actually miss after using Phase 5.

## Subscription runtime

Replaced `@anthropic-ai/claude-agent-sdk` with driving the user's own `claude` CLI (v2.1.296+) as one
long-lived headless subprocess per contact, so agents run on the Claude subscription instead of
`ANTHROPIC_API_KEY`. No behavior change intended; same bubbles, grey tool lines, approval cards,
question chips, hand-offs and spend tracking as Phases 1-5.

What changed:
- `apps/server/src/runtime/agent.ts`: `start()` now `spawn()`s `claude -p --input-format stream-json
  --output-format stream-json --verbose --include-partial-messages --model <m> --permission-mode
  <mode> [--resume <session_id>] --max-budget-usd <remaining> --agents <json> --agent <name>
  --disallowedTools SendMessage ListAgents mcp__gcnb__permission_prompt --allowedTools
  mcp__gcnb__hand_off --mcp-config <json> --permission-prompt-tool mcp__gcnb__permission_prompt`,
  with `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` stripped from its env so the CLI can't silently
  fall back to key billing. Stdin lines are `{"type":"user","message":{...}}`; interrupt sends a
  `control_request`. stdout is parsed as stream-json and fed through the same `system/stream_event/
  assistant/result` switch as before (the wire shapes are unchanged). `canUseTool` itself is
  untouched — only its caller changed, from an in-process SDK callback to the MCP tool below.
  Local types (`PermissionResult`, `PermissionUpdate`, `CanUseTool`) replace the SDK's.
- `apps/server/src/mcp.ts` (new): a Streamable HTTP MCP endpoint at `/mcp/:contactId` on gcnb's own
  Fastify server (stateless: a fresh MCP server + transport per request), guarded by one random boot
  token as `Authorization: Bearer <token>` (the origin-check hook only looks at requests carrying an
  Origin header, so this token is the real guard for the CLI's own requests). Serves `hand_off` (same
  logic as the old in-process tool) and `permission_prompt` (delegates to the contact's `canUseTool`).
  No `--strict-mcp-config`: this matches the SDK's old default (its `strictMcpConfig` was never set),
  so the user's own project/user MCP servers still load alongside gcnb's.
- `--permission-mode default` is still accepted by the CLI as an alias (confirmed live; its `--help`
  only lists the newer `manual` name) — no mode remapping needed.
- Boot-time gating: `checkClaudeAuth()` runs `claude auth status` once (bounded, 10s timeout, cached
  for the process lifetime) in place of the `ANTHROPIC_API_KEY` checks in `state()`/the boot warning.
- `@modelcontextprotocol/sdk` added as a direct dependency; `@anthropic-ai/claude-agent-sdk` dropped
  from `apps/server/package.json` and from `scripts/build-plugin.mjs`'s `EXTERNAL` list (and its
  generated `dist/server/package.json`).
- README: auth section now documents signing in via `claude` once, `GCNB_CLAUDE_BIN`, and that no
  `.env`/API key is required. `db.test.ts` only changed its `CanUseTool` import line.

Verified:
- A throwaway probe (a logging MCP server + one bounded live `claude -p` call against a Write tool,
  deleted after) confirmed the exact args the CLI sends `--permission-prompt-tool`:
  `{"tool_name":"Write","input":{...},"tool_use_id":"toolu_..."}` — **no `permission_suggestions`
  field**. "Always allow" therefore builds its own session-only rule (`{type:'addRules',
  rules:[{toolName}], behavior:'allow', destination:'session'}`) rather than relaying one from the CLI.
- `pnpm -r typecheck`, `pnpm --filter @gcnb/server test` (unchanged `db.test.ts`, including the full
  `canUseTool` → card → tapback → `PermissionResult` round trip), `pnpm build:plugin` +
  `node --check dist/server/index.mjs`.
- A bounded live run (`GCNB_PORT=8897`, temp `GCNB_DATA_DIR`, no `.env`, no `ANTHROPIC_API_KEY` in
  env) over the real WebSocket protocol: snapshot reports all three contacts `live: true` (the new
  `claude auth status` gate passing), a model switch persisted, and a DM to the reviewer got a real
  reply on the subscription after running `Bash` (`echo hi`) — confirming the whole spawn → stdin →
  stdout → reply pipeline works end to end on a live subscription session.

Gaps:
- The live run's own Bash call was pre-approved by this machine's local GateGuard PreToolUse hook
  before gcnb's `permission_prompt` tool was reached, so the card → WS tapback → tool-runs round trip
  wasn't independently observed against a *running* agent turn in this session. The underlying
  mechanism was verified live and directly instead, via the probe above (real args round-tripped
  through the same `permission_prompt` code path), plus the unchanged `db.test.ts` coverage of
  `canUseTool` itself. Re-run the reviewer-approval smoke test in an environment without that hook to
  see the card live.
- `claude auth status`'s result is cached for the process lifetime; `claude auth login` after gcnb
  has booted needs a restart to be picked up (same granularity as the old `ANTHROPIC_API_KEY` check,
  which also only read the env once at boot).

## Decisions

- Monthly API budget: not set. Per-contact cap defaults to $2 (`GCNB_BUDGET_USD`) on `sonnet`.
- First three contacts: planner, coder and reviewer trio.
- First test repo: open. Contacts work in this repo by default; point a contact at another folder from its card.
- TypeScript end to end.
- Browser only for now; Tauri stays a Phase 6 stretch.

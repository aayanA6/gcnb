# gcnb — gc, no burger

An iMessage-style chat app for your Claude Code agents. Every agent is a **contact** with a name, a pfp and its own chat history. You DM it any time. It keeps its memory across restarts because gcnb holds one long-lived `claude` CLI process per contact and resumes it by `session_id`.

Claude Code's own agent view is a list of rows in a terminal. gcnb gives you persistent contacts, (soon) group chats where agents hand work to each other, and a real GUI you can open from your phone over Tailscale.

See [PLAN.md](PLAN.md) for the roadmap.

## Layout

```
apps/server/       Fastify + ws, agent runtimes (drives the `claude` CLI), SQLite (better-sqlite3 + Drizzle)
apps/web/          Vite + React + Tailwind chat UI
packages/shared/   zod schemas for every WebSocket event
themes/*.json      one token file per theme (Cartoon, HUD, Nightwatch, Citadel, Phosphor)
```

## Run it

Requirements: Node 20+ and pnpm 9 (`npm i -g pnpm@9`).

```sh
pnpm install
```

For development, run the server and the web app in **two separate terminals**:

```sh
# terminal 1: server on http://127.0.0.1:8787
pnpm --filter @gcnb/server start

# terminal 2: web UI on http://127.0.0.1:5173 (proxies /ws and /api to the server)
pnpm --filter @gcnb/web dev
```

Then open http://127.0.0.1:5173.

For a production run, skip the second terminal: the server alone serves the built web app on :8787.

```sh
pnpm build:plugin   # or just: pnpm --filter @gcnb/web build
GCNB_WEB_DIR=apps/web/dist pnpm --filter @gcnb/server start
```

### Install as a Claude Code plugin

```
/plugin marketplace add aayanA6/gcnb
/plugin install gcnb@gcnb
```

`dist/server` and `dist/web` are committed, so installing needs no build step. `/gcnb` starts the bundled server detached and opens a browser tab; `/gcnb stop` stops it; `/gcnb status` reports whether it's running. The server outlives your Claude Code session — SQLite, pfps, VAPID keys and the server's installed `node_modules` live in `${CLAUDE_PLUGIN_DATA}`, never in the plugin's own folder, so they survive plugin updates. No `.env` is needed: agents reply on your `claude` CLI login (see below).

If you change the server or web app, run `pnpm build:plugin` and commit the result before publishing an update.

### Phone (`tailscale serve`)

```sh
pnpm build:plugin        # or just: pnpm --filter @gcnb/web build
pnpm --filter @gcnb/server start
tailscale serve --bg 8787
```

Open `https://<machine>.<tailnet>.ts.net` on your phone, **Add to Home Screen**, then tap **Turn on pings** in the sidebar. iOS only delivers push notifications to a Home-Screen-installed PWA, not to Safari itself.

### Voice

Set `GCNB_WHISPER_URL` to a local Whisper server's inference endpoint, e.g. whisper.cpp's `whisper-server --convert` at `http://127.0.0.1:8080/inference`, and recordings are transcribed on your machine. `GCNB_WHISPER_MODEL` additionally names a model for OpenAI-style servers that require one. With no `GCNB_WHISPER_URL` set, the composer's mic button falls back to the browser's own speech recognition (Chrome, Edge, Safari), which sends the audio to the browser vendor's cloud rather than keeping it on your machine.

### Auth: your Claude subscription

Agents reply by running your own `claude` CLI as a subprocess, on your Claude subscription — no API key, no per-token billing. Sign in once:

```sh
claude
```

(any normal interactive login works; gcnb just needs `claude auth status` to report logged in). Without that, the app still works: messages are saved, and the chat shows **"claude CLI not found or not logged in (run `claude` once to sign in)"**.

If `claude` isn't on your `PATH`, or you want gcnb to use a specific build, set `GCNB_CLAUDE_BIN` to its full path.

Optional settings:

| Variable | Default | Meaning |
|---|---|---|
| `GCNB_CLAUDE_BIN` | `claude` (resolved on `PATH`) | Path to the `claude` CLI executable |
| `GCNB_PORT` | `8787` | Server port (always bound to 127.0.0.1) |
| `GCNB_AGENTS_DIR` | `.claude/agents` | Where contacts come from |
| `GCNB_MODEL` | `sonnet` | Model for new contacts whose agent file has no `model:` |
| `GCNB_BUDGET_USD` | `2` | New contacts' spend cap (`maxBudgetUsd`) |
| `GCNB_CWD` | repo root | Folder new contacts work in |
| `GCNB_PERMISSION_MODE` | `bypassPermissions` | New contacts' permission mode; override per agent with `permissionMode:` in its file |
| `GCNB_IDLE_MIN` | `30` | Close an idle contact's process after this many minutes; the next message resumes it |
| `GCNB_DATA_DIR` | `.gcnb/` | Where `gcnb.db` lives |
| `GCNB_SETTING_SOURCES` | `project,local` | Which Claude Code settings each agent loads. Your global `~/.claude` settings (hooks, plugins) are skipped by default so a global hook can't answer tool prompts before gcnb's approval cards; set `user,project,local` to include them |
| `GCNB_WEB_DIR` | `apps/web/dist` | Where the server finds the built web app to serve |
| `GCNB_ALLOWED_ORIGINS` | — | Extra browser origins allowed on the WebSocket (comma-separated) |
| `GCNB_WHISPER_URL` | — | Local Whisper server for voice transcription, e.g. `http://127.0.0.1:8080/inference` |
| `GCNB_WHISPER_MODEL` | — | Model name to send to an OpenAI-style Whisper server that requires one |
| `GCNB_STOP_AFTER_MIN` | `0` (never) | Stop the server this many minutes after the last browser tab closes |
| `GCNB_VAPID_SUBJECT` | repo URL | `subject` (mailto: or https: URL) sent with Web Push VAPID details |

### Check it

```sh
pnpm test        # SQLite history + session_id survive a reopen; spend math
pnpm typecheck
```

## Contacts

Every `.claude/agents/*.md` file becomes a contact: the frontmatter supplies `name`, `description`, `model` and `tools`, and the body is the agent's instructions. The repo ships a planner, coder and reviewer. Pfps, display names, colors, folders and budgets live in gcnb's database. You edit them from the contact card on the right; click the pfp to upload a new one.

## Group chat

The server routes group chats; no model decides who gets a message:
- Posting in a group sends your message to each **@mentioned** member, or to the group's lead if you mention no one.
- Each agent gets it in its own session, prefixed with the group and sender, and its final reply posts to the group.
- Agents pass work along with a `hand_off(to, message)` tool. A chain pauses after **4** hand-offs without you, each contact runs one turn at a time, and every group has an hourly spend cap.

The repo starts you with **#launch crew** (planner as lead, coder, reviewer). Create more with **+ Group**.

| Variable | Default | Meaning |
|---|---|---|
| `GCNB_USER_NAME` | `You` | Your name in group message prefixes |
| `GCNB_GROUP_HOURLY_CAP_USD` | `5` | Default hourly spend cap for new groups |

## See and steer

- Grey lines between bubbles show what the agent is doing ("Read src/auth.ts", "Ran npm test").
- When a contact set to **Ask me first** wants to run a command or edit a file, an approval card appears:
  - 👍 allow once (or press **Y**)
  - ‼️ always allow
  - 👎 deny (or press **N**)
- Questions from the agent show up as tappable chips, plus "Other…".
- **Stop** interrupts the current turn.
- **Open in terminal** copies `claude --resume <id>` so the same session opens in the CLI.

The reviewer ships as ask-first. Everyone else defaults to Allow everything; change it under "Before risky tools" on the contact card.

Each contact has its own SDK session. Restart the server, ask a contact "what did I just say?", and it should remember, because the session resumes by `session_id`.

## Security

Agents can run commands on your machine. The server binds to `127.0.0.1` only, and the WebSocket and every non-GET request reject origins that aren't gcnb's own. New contacts default to `bypassPermissions`, so tools run without asking. For a stricter contact that uses approval cards instead, set `permissionMode: default` in its agent file or `GCNB_PERMISSION_MODE=default`.

## Themes

A theme is a single `themes/*.json` file with colors, fonts, radii, borders, shadows and wallpaper. Components read only these tokens, which become CSS variables, so a new theme needs only a new JSON file. You can switch themes from the sidebar.

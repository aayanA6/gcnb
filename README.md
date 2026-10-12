# gcnb — gc, no burger

An iMessage-style chat app for your Claude Code agents. Every agent is a **contact** with a name, a pfp and its own chat history. You DM it any time. It keeps its memory across restarts because gcnb holds one long-lived Claude Agent SDK session per contact and resumes it by `session_id`.

Claude Code's own agent view is a list of rows in a terminal. gcnb gives you persistent contacts, (soon) group chats where agents hand work to each other, and a real GUI you can open from your phone over Tailscale.

See [PLAN.md](PLAN.md) for the roadmap.

## Layout

```
apps/server/       Fastify + ws, agent runtimes (Claude Agent SDK), SQLite (better-sqlite3 + Drizzle)
apps/web/          Vite + React + Tailwind chat UI
packages/shared/   zod schemas for every WebSocket event
themes/*.json      one token file per theme (Cartoon, HUD, Nightwatch, Citadel, Phosphor)
```

## Run it (Phase 1)

Requirements: Node 20+ and pnpm 9 (`npm i -g pnpm@9`).

```sh
pnpm install
```

Run the server and the web app in **two separate terminals**:

```sh
# terminal 1: server on http://127.0.0.1:8787
pnpm --filter @gcnb/server start

# terminal 2: web UI on http://127.0.0.1:5173 (proxies /ws and /api to the server)
pnpm --filter @gcnb/web dev
```

Then open http://127.0.0.1:5173.

### ANTHROPIC_API_KEY

Agents reply only when `ANTHROPIC_API_KEY` is set. gcnb uses the Agent SDK on your API key and is billed per token. Without the key the app still works: messages are saved, and the chat shows **"Set ANTHROPIC_API_KEY to enable live replies"**.

Set it in your shell before starting the server, or put it in a `.env` file at the repo root. The server reads that file automatically, and git ignores it:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Optional settings:

| Variable | Default | Meaning |
|---|---|---|
| `GCNB_PORT` | `8787` | Server port (always bound to 127.0.0.1) |
| `GCNB_MODEL` | `sonnet` | Model for the Phase 1 contact |
| `GCNB_BUDGET_USD` | `2` | Contact's spend cap (`maxBudgetUsd`) |
| `GCNB_CWD` | repo root | Folder the agent works in |
| `GCNB_DATA_DIR` | `.gcnb/` | Where `gcnb.db` lives |
| `GCNB_ALLOWED_ORIGINS` | — | Extra browser origins allowed on the WebSocket (comma-separated) |

### Check it

```sh
pnpm test        # SQLite history + session_id survive a reopen; spend math
pnpm typecheck
```

Phase 1 is done when you can chat with Bolt, restart the server, and see the history still there. Ask "what did I just say?" and Bolt should remember, because the SDK session resumes by `session_id`.

## Security

The server binds to `127.0.0.1` only, and the WebSocket rejects any origin that isn't gcnb's own. That matters because agents can run commands on your machine. Contacts use permission mode `default`, so risky tools ask first. Until approval cards ship in Phase 3, any tool that would ask is denied.

## Themes

A theme is a single `themes/*.json` file with colors, fonts, radii, borders, shadows and wallpaper. Components read only these tokens, which become CSS variables, so a new theme needs only a new JSON file. You can switch themes from the sidebar.

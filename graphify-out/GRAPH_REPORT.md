# Graph Report - gcnb  (2026-10-14)

## Corpus Check
- 46 files · ~30,824 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 411 nodes · 680 edges · 31 communities (30 shown, 1 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 16 edges (avg confidence: 0.67)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `e084ad25`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- index.ts
- agent.ts
- index.ts
- App.tsx
- gcnb roadmap
- dependencies
- devDependencies
- db.test.ts
- gcnb
- package.json
- package.json
- compilerOptions
- pwa.ts
- Push
- App
- voice.ts
- compilerOptions
- ContactCard
- tsconfig.json
- pip.tsx
- theme.ts
- build-plugin.mjs
- time
- tsconfig.json

## God Nodes (most connected - your core abstractions)
1. `AgentRuntime` - 29 edges
2. `App()` - 18 edges
3. `Router` - 16 edges
4. `Message` - 10 edges
5. `compilerOptions` - 10 edges
6. `gcnb roadmap` - 10 edges
7. `gcnb — gc, no burger` - 10 edges
8. `scanTerminals()` - 8 edges
9. `handle()` - 8 edges
10. `Thread` - 8 edges

## Surprising Connections (you probably didn't know these)
- `useGcnb()` --references--> `ServerEvent`  [EXTRACTED]
  apps/web/src/App.tsx → packages/shared/src/index.ts
- `Composer()` --references--> `Thread`  [EXTRACTED]
  apps/web/src/App.tsx → packages/shared/src/index.ts
- `App()` --calls--> `noteFor()`  [EXTRACTED]
  apps/web/src/App.tsx → packages/shared/src/index.ts
- `notify()` --calls--> `noteFor()`  [EXTRACTED]
  apps/server/src/index.ts → packages/shared/src/index.ts
- `addTerminal()` --references--> `PERMISSION_MODES`  [EXTRACTED]
  apps/server/src/index.ts → packages/shared/src/index.ts

## Import Cycles
- None detected.

## Communities (31 total, 1 thin omitted)

### Community 0 - "index.ts"
Cohesion: 0.06
Nodes (50): addRuntime(), addTerminal(), agentFiles, app, armIdleStop(), avatarDir, broadcast(), COLORS (+42 more)

### Community 1 - "agent.ts"
Cohesion: 0.10
Nodes (21): handle(), Delivery, AgentRuntime, checkClaudeAuth(), cliEnv(), clip(), CliUserMessage, describeRequest() (+13 more)

### Community 2 - "index.ts"
Cohesion: 0.11
Nodes (19): AgentFile, contacts, Db, messages, openDb(), pendingActions, threadMembers, threads (+11 more)

### Community 3 - "App.tsx"
Cohesion: 0.06
Nodes (19): Action, Answer, AUTO, CONTACT_COLORS, ContactPatch, FieldIssues, ICONS, initial (+11 more)

### Community 4 - "gcnb roadmap"
Cohesion: 0.06
Nodes (29): Decisions, gcnb roadmap, Phase 1 notes, Phase 2 notes, Phase 3 notes, Phase 4 notes, Phase 5 notes, Phase 6 (+21 more)

### Community 5 - "dependencies"
Cohesion: 0.07
Nodes (26): dependencies, better-sqlite3, drizzle-orm, fastify, @gcnb/shared, @modelcontextprotocol/sdk, web-push, ws (+18 more)

### Community 6 - "devDependencies"
Cohesion: 0.10
Nodes (20): dependencies, @gcnb/shared, react, react-dom, devDependencies, tailwindcss, @tailwindcss/vite, @types/react (+12 more)

### Community 7 - "db.test.ts"
Cohesion: 0.14
Nodes (16): agentFilePath(), agentFileText(), loadAgents(), parseAgentFile(), setAgentModel(), withModel(), db, dir (+8 more)

### Community 8 - "gcnb"
Cohesion: 0.15
Nodes (19): alive(), argv, fs, health(), installDeps(), logFile, noOpen, openBrowser() (+11 more)

### Community 9 - "package.json"
Cohesion: 0.14
Nodes (13): description, engines, node, name, packageManager, pnpm, onlyBuiltDependencies, private (+5 more)

### Community 10 - "package.json"
Cohesion: 0.15
Nodes (12): dependencies, zod, devDependencies, typescript, main, name, private, scripts (+4 more)

### Community 11 - "compilerOptions"
Cohesion: 0.18
Nodes (10): compilerOptions, allowImportingTsExtensions, esModuleInterop, module, moduleResolution, noEmit, resolveJsonModule, skipLibCheck (+2 more)

### Community 12 - "pwa.ts"
Cohesion: 0.27
Nodes (9): PingsToggle(), b64ToBytes(), Config, currentPings(), enablePings(), localNotify(), onOpenThread(), Pings (+1 more)

### Community 13 - "Push"
Cohesion: 0.33
Nodes (3): Push, read(), Note

### Community 14 - "App"
Cohesion: 0.33
Nodes (9): App(), initialDeepLinkThread(), load(), reduce(), save(), useGcnb(), useMedia(), usePageVisible() (+1 more)

### Community 15 - "voice.ts"
Cohesion: 0.22
Nodes (8): clock(), Composer(), Engine, Recognition, Recording, Stop, useVoice(), voiceEngine()

### Community 16 - "compilerOptions"
Cohesion: 0.29
Nodes (6): compilerOptions, jsx, lib, types, extends, include

### Community 17 - "ContactCard"
Cohesion: 0.40
Nodes (6): ContactCard(), drawer(), GroupInfo(), isTerminal(), resumeCommand(), roleOf()

### Community 18 - "tsconfig.json"
Cohesion: 0.40
Nodes (4): compilerOptions, types, extends, include

### Community 19 - "pip.tsx"
Cohesion: 0.60
Nodes (4): requestWindow(), useMirrorStyles(), usePip(), Window

### Community 20 - "theme.ts"
Cohesion: 0.40
Nodes (4): applyTheme(), files, Theme, themes

### Community 21 - "build-plugin.mjs"
Cohesion: 0.40
Nodes (3): EXTERNAL, pkg, root

### Community 22 - "time"
Cohesion: 0.50
Nodes (4): Bubble(), dateLabel(), DatePill(), time()

## Knowledge Gaps
- **163 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+158 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `AgentRuntime` connect `agent.ts` to `index.ts`, `index.ts`, `db.test.ts`?**
  _High betweenness centrality (0.047) - this node is a cross-community bridge._
- **Why does `openDb()` connect `index.ts` to `gcnb`, `index.ts`, `db.test.ts`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **Why does `Message` connect `index.ts` to `agent.ts`, `App.tsx`, `db.test.ts`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _163 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.0593990216631726 - nodes in this community are weakly interconnected._
- **Should `agent.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.10101010101010101 - nodes in this community are weakly interconnected._
- **Should `index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.10510510510510511 - nodes in this community are weakly interconnected._
#!/usr/bin/env node
// Builds the Claude Code plugin bundle: dist/web (the built web app) and dist/server (the bundled
// server + the runtime package.json that `gcnb install-deps` installs into ${CLAUDE_PLUGIN_DATA}).
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// pnpm is a .cmd shim on Windows, which needs a shell to spawn; args are our own, never user input.
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' })

// 1. Web app -> dist/web
run('pnpm', ['--filter', '@gcnb/web', 'build'])
rmSync(join(root, 'dist', 'web'), { recursive: true, force: true })
mkdirSync(join(root, 'dist', 'web'), { recursive: true })
cpSync(join(root, 'apps', 'web', 'dist'), join(root, 'dist', 'web'), { recursive: true })

// 2. Server -> dist/server/index.mjs. @gcnb/shared is a workspace TS package, so it gets bundled in;
// only real npm deps are external (do NOT use --packages=external, which would externalize it too).
const pkg = JSON.parse(readFileSync(join(root, 'apps', 'server', 'package.json'), 'utf8'))
const EXTERNAL = ['better-sqlite3', '@modelcontextprotocol/sdk', 'fastify', 'ws', 'web-push', 'drizzle-orm', 'zod']
mkdirSync(join(root, 'dist', 'server'), { recursive: true })
run('pnpm', [
  '--filter', '@gcnb/server', 'exec', 'esbuild', 'src/index.ts',
  '--bundle', '--platform=node', '--format=esm',
  `--outfile=${join(root, 'dist', 'server', 'index.mjs')}`,
  ...EXTERNAL.map((d) => `--external:${d}`),
])

// 3. The manifest `gcnb install-deps` installs into ${CLAUDE_PLUGIN_DATA}: exact versions, no
// workspace or dev deps (those got bundled in, or aren't needed at runtime).
writeFileSync(
  join(root, 'dist', 'server', 'package.json'),
  JSON.stringify({ name: 'gcnb-server', private: true, dependencies: Object.fromEntries(EXTERNAL.map((d) => [d, pkg.dependencies[d]])) }, null, 2) + '\n',
)

console.log('built dist/web and dist/server')

import type { FastifyInstance } from 'fastify'
import { readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'

// Agents can run commands on this machine, so only gcnb's own pages may talk to the server; other
// websites can't reach 127.0.0.1 through your browser. "Own page" = same origin as the request, on a
// host DNS rebinding can't fake: loopback, or the HTTPS *.ts.net name `tailscale serve` gives your machine.
// `tailscale serve` keeps Host and adds X-Forwarded-Host; a web page can't set either on a WebSocket.
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/
export function originAllowed(origin: string | undefined, host: string | undefined, extra: Set<string>): boolean {
  if (!origin) return false
  if (extra.has(origin)) return true
  let u: URL
  try {
    u = new URL(origin)
  } catch {
    return false
  }
  if (!host || u.host !== host) return false
  return LOOPBACK.test(u.host) || (u.protocol === 'https:' && u.hostname.endsWith('.ts.net'))
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

// The built web app (apps/web/dist) on the server's own port, so `tailscale serve` needs one target.
// Unknown paths fall back to index.html; /api misses stay 404.
export function serveWeb(app: FastifyInstance, dir: string) {
  const root = resolve(dir)
  app.get('/*', async (req, reply) => {
    const path = new URL(req.url, 'http://x').pathname // built files have plain names, so no decoding
    if (path.startsWith('/api/')) return reply.code(404).send({ error: 'not found' })
    let file = resolve(root, `.${path}`)
    let isFile = false
    try {
      isFile = file.startsWith(root + sep) && statSync(file).isFile()
    } catch {}
    if (!isFile) file = join(root, 'index.html')
    // Hashed assets never change; the page, manifest and service worker must always be fresh.
    reply.header('cache-control', file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache')
    return reply.type(MIME[extname(file)] ?? 'application/octet-stream').send(readFileSync(file))
  })
}

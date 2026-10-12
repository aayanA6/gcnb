// The gcnb MCP server every contact's `claude` CLI process talks to: hand_off and permission_prompt
// (plan: "MCP" design). One Streamable HTTP endpoint per contact, stateless (a fresh MCP server +
// transport per request — there is no session to keep between calls).
import { timingSafeEqual } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AgentRuntime } from './runtime/agent.ts'

// Guards against timing attacks on the bearer token; both sides are fixed-length so a length
// mismatch alone (handled by the `?? false` branch) can't leak the real token's length either.
function tokenMatches(got: string, want: string) {
  const a = Buffer.from(got)
  const b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}

const methodNotAllowed = { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }

export function registerMcp(app: FastifyInstance, runtimes: Map<string, AgentRuntime>, token: string) {
  app.post<{ Params: { contactId: string } }>('/mcp/:contactId', async (req, reply) => {
    const auth = String(req.headers.authorization ?? '')
    if (!tokenMatches(auth, `Bearer ${token}`)) return reply.code(401).send({ error: 'unauthorized' })
    const rt = runtimes.get(req.params.contactId)
    if (!rt) return reply.code(404).send({ error: 'no such contact' })

    const server = new McpServer({ name: 'gcnb', version: '1.0.0' })
    server.registerTool(
      'hand_off',
      {
        description: 'Pass work to another member of the current group chat. The server delivers your message into their session and their reply posts to the group. Chains pause after a few hand-offs without the user.',
        inputSchema: {
          to: z.string().describe('Name of the group member to hand off to, e.g. "coder"'),
          message: z.string().describe('Self-contained instructions for them: what to do and the context they need'),
        },
      },
      async ({ to, message }) => ({ content: [{ type: 'text' as const, text: rt.handOffTool(to, message) }] }),
    )
    server.registerTool(
      'permission_prompt',
      {
        description: 'Internal: ask the user for permission to use a tool.',
        inputSchema: { tool_name: z.string(), input: z.object({}).passthrough(), tool_use_id: z.string().optional() },
      },
      async ({ tool_name, input, tool_use_id }) => ({
        content: [{ type: 'text' as const, text: JSON.stringify(await rt.permissionPrompt(tool_name, input, tool_use_id)) }],
      }),
    )

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    reply.hijack()
    try {
      await server.connect(transport)
      await transport.handleRequest(req.raw, reply.raw, req.body)
    } finally {
      reply.raw.on('close', () => {
        void transport.close()
        void server.close()
      })
    }
  })

  // Stateless mode: no session to resume (GET) or end (DELETE).
  app.get('/mcp/:contactId', async (_req, reply) => reply.hijack().raw.writeHead(405, { 'content-type': 'application/json' }).end(JSON.stringify(methodNotAllowed)))
  app.delete('/mcp/:contactId', async (_req, reply) => reply.hijack().raw.writeHead(405, { 'content-type': 'application/json' }).end(JSON.stringify(methodNotAllowed)))
}

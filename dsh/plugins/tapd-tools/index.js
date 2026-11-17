/**
 * TAPD tools registered directly on `ctx.tools`.
 *
 * The built-in agent does not go through the MCP sidecar: every business
 * capability is a native tool whose schema joins the system prompt. P2 ships a
 * single probe tool; the real surface (whoami / projects / bugs / export /
 * comment / status) lands together with the local bridge in P2d.
 *
 * The plugin is mounted from the payload's `node_modules/@tapd/...`, so imports
 * resolve against the same tree the launcher uses.
 */

import { connect } from 'node:net'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tapd-tools'
export const inject = ['tools']

/**
 * A TCP connect to the bridge listener is the honest reachability answer: the
 * bridge itself authenticates individual frames, so a bare connection is all a
 * probe needs (and all it should do).
 */
function bridgeReachable(url, timeoutMs = 500) {
  return new Promise((resolve) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      resolve(false)
      return
    }
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      resolve(false)
      return
    }
    const socket = connect({
      host: parsed.hostname,
      port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
    })
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'tapd_ping',
      description:
        'Check that the TAPD desktop client bridge is reachable from this agent session. Connects to the local bridge and returns the working directory.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', required: true },
            cwd: { type: 'string', required: true },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [
          { type: 'text', text: value.ok ? `TAPD bridge ok at ${value.cwd}` : 'TAPD bridge unavailable' },
        ],
      },
      async execute(_args, exec) {
        const cwd = exec.agent?.session?.header?.cwd ?? ''
        const url = process.env.TAPD_DSH_BRIDGE_URL ?? ''
        const ok = url ? await bridgeReachable(url) : false
        return { ok, cwd }
      },
    }),
  )
}

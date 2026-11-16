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

import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tapd-tools'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'tapd_ping',
      description:
        'Check that the TAPD desktop client is reachable from this agent session. Returns the bridge identity and working directory.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            cwd: { type: 'string' },
          },
          required: ['ok', 'cwd'],
        },
        render: (_args, value) => [
          { type: 'text', text: value.ok ? `TAPD bridge ok at ${value.cwd}` : 'TAPD bridge unavailable' },
        ],
      },
      async execute(_args, exec) {
        return { ok: true, cwd: exec.agent?.session?.header?.cwd ?? '' }
      },
    }),
  )
}

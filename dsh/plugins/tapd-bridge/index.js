/**
 * Live feed and control channel for the TAPD desktop app.
 *
 * dsh runs as a child process; the SDK's stdio channel carries committed
 * events but nothing token-level, and it has no history read. This plugin owns
 * exactly those two gaps over its own 127.0.0.1 socket:
 *
 *   hello    → identity of the feed (always first)
 *   snapshot → one session's recorded events, sent on every connect
 *   stream   → every `agent/assistant-stream` frame, forwarded verbatim
 *   notice   → advisory notice from the policy plugin (notify mode)
 *
 * The same socket carries control frames the other way (NDJSON, one per line):
 *
 *   assign → move a session to a working directory (task worktrees)
 *   cancel → stop one session's turn
 *
 * Assignments that arrive before the session exists are remembered and applied
 * when the session is created, so the task flow can queue a worktree without
 * racing session creation.
 *
 * The Rust side owns normalization and deduplication, so this plugin holds no
 * transcript state. Reconnecting re-sends snapshots; the receiver dedupes by
 * event seq. Without `TAPD_DSH_BRIDGE_URL`/`_TOKEN` it is inert — the payload
 * smoke test and any standalone dsh run stay untouched.
 *
 * stdout belongs to the SDK protocol: never write there.
 */

import { createConnection } from 'node:net'
import { isAbsolute } from 'node:path'

export const name = 'tapd-bridge'
// `sessions` is required for the snapshot; the stream is a core event.
export const inject = ['sessions', 'agents', 'workingDirectory']

const RECONNECT_MIN_MS = 250
const RECONNECT_MAX_MS = 4000

export function apply(ctx) {
  const url = process.env.TAPD_DSH_BRIDGE_URL
  const token = process.env.TAPD_DSH_BRIDGE_TOKEN
  if (!url || !token) return

  const target = parseTarget(url)
  if (!target) {
    ctx.logger.warn(`${name}: TAPD_DSH_BRIDGE_URL is not a local http URL: ${url}`)
    return
  }

  let socket = null
  let reconnectTimer = null
  let closed = false
  let delay = RECONNECT_MIN_MS
  /** sessionId → cwd, for assignments that arrived before the session existed. */
  const assignments = new Map()

  const send = (message) => {
    if (!socket || socket.destroyed) return
    try {
      socket.write(`${JSON.stringify(message)}\n`)
    } catch (error) {
      // A write race with close is expected during shutdown; reconnect covers it.
      ctx.logger.debug(`${name}: write failed: ${String(error)}`)
    }
  }

  const warn = (scope, error) => {
    ctx.logger.warn(`${name}: ${scope}: ${String(error)}`)
  }

  // Listeners are the process's bus: they must never throw into dsh.
  ctx.on('agent/assistant-stream', ({ agent, frame } = {}) => {
    try {
      const sessionId = agent?.session?.id
      if (sessionId) send({ type: 'stream', token, sessionId, frame })
    } catch (error) {
      warn('assistant-stream', error)
    }
  })

  const sendSnapshots = () => {
    for (const session of ctx.sessions.list()) {
      try {
        send({
          type: 'snapshot',
          token,
          sessionId: session.id,
          // Deprecated upstream for new *core* callers, but the only history
          // read exposed to plugins in the pinned release; the bridge needs the
          // full log to rebuild the transcript after a reconnect.
          events: session.snapshotEvents(),
        })
      } catch (error) {
        warn(`snapshot ${session?.id ?? '?'}`, error)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Rust → plugin control frames
  // -------------------------------------------------------------------------

  /**
   * Points one session at `cwd`. The live agent owns the directory change, so
   * an assignment for a not-yet-created session waits for `session/created`.
   */
  const applyAssignment = (sessionId, cwd) => {
    const agent = ctx.agents.get(sessionId)
    if (!agent) {
      assignments.set(sessionId, cwd)
      return
    }
    assignments.delete(sessionId)
    ctx.workingDirectory
      .set(agent, cwd)
      .then((applied) => ctx.logger.info(`${name}: session ${sessionId} cwd → ${applied}`))
      .catch((error) => warn(`assign ${sessionId} → ${cwd}`, error))
  }

  const applyPending = (sessionId) => {
    const cwd = assignments.get(sessionId)
    if (cwd !== undefined) applyAssignment(sessionId, cwd)
  }

  // A created Session exists before its Agent is published; both edges flush,
  // and the second is a no-op after the first succeeds.
  ctx.on('session/created', (session) => applyPending(session?.id))
  ctx.on('agent/created', ({ agent } = {}) => applyPending(agent?.session?.id))

  const cancelSession = (sessionId) => {
    try {
      const agent = ctx.agents.get(sessionId)
      if (!agent) {
        ctx.logger.info(`${name}: cancel for ${sessionId} ignored, no live agent`)
        return
      }
      agent.cancel({ kind: 'user' })
    } catch (error) {
      warn(`cancel ${sessionId}`, error)
    }
  }

  const handleControlLine = (line) => {
    let frame
    try {
      frame = JSON.parse(line)
    } catch (error) {
      // One bad frame must not break the control channel.
      warn('control frame', error)
      return
    }
    if (!frame || frame.token !== token) return
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : ''
    if (!sessionId) return
    if (frame.type === 'assign' && typeof frame.cwd === 'string') {
      if (!isAbsolute(frame.cwd)) {
        warn(`assign ${sessionId}`, `cwd is not absolute: ${frame.cwd}`)
        return
      }
      applyAssignment(sessionId, frame.cwd)
    } else if (frame.type === 'cancel') {
      cancelSession(sessionId)
    }
  }

  // -------------------------------------------------------------------------
  // Notice channel (policy plugin → Rust)
  // -------------------------------------------------------------------------

  // `notice` is fire-and-forget by contract: the caller decides, this sends.
  ctx.provide('tapdBridge', {
    notice({ sessionId, tool, target, risk }) {
      send({ type: 'notice', token, sessionId: sessionId ?? '', tool, target, risk })
    },
  })

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
    delay = Math.min(delay * 2, RECONNECT_MAX_MS)
  }

  function connect() {
    if (closed) return
    const next = createConnection(target)
    socket = next
    next.setNoDelay(true)
    next.setEncoding('utf8')
    let buffer = ''
    next.on('connect', () => {
      delay = RECONNECT_MIN_MS
      buffer = ''
      send({ type: 'hello', token })
      sendSnapshots()
    })
    next.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) handleControlLine(line)
      }
    })
    next.on('error', (error) => {
      ctx.logger.debug(`${name}: ${String(error)}`)
    })
    next.on('close', () => {
      if (socket !== next) return
      socket = null
      scheduleReconnect()
    })
  }

  ctx.effect(() => {
    connect()
    return () => {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      socket?.destroy()
      socket = null
    }
  }, `${name}.connect()`)
}

/** Accepts `http://127.0.0.1:PORT` only; anything else stays inert. */
function parseTarget(url) {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== '127.0.0.1' || !parsed.port) return null
    return { host: parsed.hostname, port: Number(parsed.port) }
  } catch {
    return null
  }
}

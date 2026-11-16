/**
 * Live feed for the TAPD desktop app.
 *
 * dsh runs as a child process; the SDK's stdio channel carries committed
 * events but nothing token-level, and it has no history read. This plugin owns
 * exactly those two gaps over its own 127.0.0.1 socket:
 *
 *   hello    → identity of the feed (always first)
 *   snapshot → one session's recorded events, sent on every connect
 *   stream   → every `agent/assistant-stream` frame, forwarded verbatim
 *
 * The Rust side owns normalization and deduplication, so this plugin holds no
 * state beyond the socket. Reconnecting re-sends snapshots; the receiver
 * dedupes by event seq. Without `TAPD_DSH_BRIDGE_URL`/`_TOKEN` it is inert —
 * the payload smoke test and any standalone dsh run stay untouched.
 *
 * stdout belongs to the SDK protocol: never write there.
 */

import { createConnection } from 'node:net'

export const name = 'tapd-bridge'
// `sessions` is required for the snapshot; the stream is a core event.
export const inject = ['sessions']

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
    next.on('connect', () => {
      delay = RECONNECT_MIN_MS
      send({ type: 'hello', token })
      sendSnapshots()
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

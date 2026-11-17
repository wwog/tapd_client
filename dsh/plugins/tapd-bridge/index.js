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
 *   stats    → one session's meter projections (context occupancy/composition)
 *   team     → one root session's whole `agentTeam` board (enabled + tasks)
 *   notice   → advisory notice from the policy plugin (notify mode)
 *
 * The same socket carries control frames the other way (NDJSON, one per line):
 *
 *   assign → move a session to a working directory (task worktrees)
 *   cancel → stop one session's turn
 *   mode / default-mode → session permission mode / runtime-wide default
 *   plan → enter or leave the engine's plan mode
 *   team → enable / disable Agent Teams for one root session
 *   select-model → switch one session's model route (durable in its log)
 *   models → adopt a model catalog, Team default and credentials live
 *   discover-models → ask the engine which models a draft endpoint advertises
 *
 * `models` and `discover-models` are requests: the same socket carries the
 * reply (`models-applied` / `models-discovered`) tagged with the caller's
 * `requestId`, so the app can tell a settled reconcile from a slow one.
 *
 * Assignments that arrive before the session exists are remembered and applied
 * when the session is created, so the task flow can queue a worktree without
 * racing session creation. The same applies to a Team toggle and a model pick:
 * both need the live Agent that owns the session.
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
/** Board and meter changes commit as session events; one settled frame per burst. */
const SETTLE_MS = 300

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
  /** sessionId → enabled, for Team toggles that arrived before the Agent existed. */
  const teamModes = new Map()
  /** sessionId → { provider, model, reasoningEffort? }, for model picks that arrived early. */
  const modelSelections = new Map()
  /** sessionId → active, for plan-mode toggles that arrived before the Agent existed. */
  const planModes = new Map()
  /** sessionId → pending debounce timer for that session's board/stats frame. */
  const settleTimers = new Map()

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

  const messageOf = (error) => (error instanceof Error ? error.message : String(error))

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
  // Team board (agentTeam projection → Rust)
  // -------------------------------------------------------------------------

  // Team mode is a root-session selection; children reuse the root's board.
  const isRoot = (session) => session != null && session.header?.origin !== 'subagent'

  /** The projection values, or null when the Team service is not composed. */
  const teamProjection = (session) => {
    const projections = ctx.get('sessionProjections')
    if (!projections) return null
    try {
      return projections.snapshot(session, ['agentTeam']).values.agentTeam ?? null
    } catch (error) {
      warn(`team ${session.id}`, error)
      return null
    }
  }

  const sendTeam = (session) => {
    if (!isRoot(session)) return
    const team = teamProjection(session)
    if (!team) return
    send({
      type: 'team',
      token,
      sessionId: session.id,
      enabled: team.enabled === true,
      tasks: Array.isArray(team.tasks) ? team.tasks : [],
      ...(typeof team.failure === 'string' ? { failure: team.failure } : {}),
    })
  }

  const sendTeamFrames = () => {
    for (const session of ctx.sessions.list()) {
      try {
        sendTeam(session)
      } catch (error) {
        warn(`team ${session?.id ?? '?'}`, error)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Meter (token-meter projections → Rust)
  // -------------------------------------------------------------------------

  /**
   * The runtime's own token meter. Token totals also exist in the transcript,
   * but context occupancy (`contextPressure`) and the request composition
   * (`contextBreakdown`) are priced by dsh alone; both projections are always
   * composed by the base bundle, yet `get` keeps this inert on a trimmed one.
   */
  const meterProjection = (session) => {
    const projections = ctx.get('sessionProjections')
    if (!projections) return null
    try {
      const { values } = projections.snapshot(session, [
        'tokenUsage',
        'contextPressure',
        'contextBreakdown',
      ])
      return {
        usage: values.tokenUsage,
        pressure: values.contextPressure,
        breakdown: values.contextBreakdown,
      }
    } catch (error) {
      warn(`stats ${session.id}`, error)
      return null
    }
  }

  const sendStats = (session) => {
    const stats = meterProjection(session)
    if (!stats) return
    send({
      type: 'stats',
      token,
      sessionId: session.id,
      ...(stats.usage ? { usage: stats.usage } : {}),
      ...(stats.pressure ? { pressure: stats.pressure } : {}),
      ...(stats.breakdown ? { breakdown: stats.breakdown } : {}),
    })
  }

  const sendStatsFrames = () => {
    for (const session of ctx.sessions.list()) {
      try {
        sendStats(session)
      } catch (error) {
        warn(`stats ${session?.id ?? '?'}`, error)
      }
    }
  }

  // Any committed event may move a row (claim, complete, assign), change the
  // mode, invalidate the projection, or shift the meter; both frames are cheap,
  // so one settled send per session per burst keeps ordering without games.
  const scheduleSession = (sessionId) => {
    const pending = settleTimers.get(sessionId)
    if (pending) clearTimeout(pending)
    settleTimers.set(
      sessionId,
      setTimeout(() => {
        settleTimers.delete(sessionId)
        const session = ctx.sessions.get(sessionId)
        if (!session) return
        if (isRoot(session)) sendTeam(session)
        sendStats(session)
      }, SETTLE_MS),
    )
  }

  ctx.on('session/event', (session) => {
    try {
      if (session?.id) scheduleSession(session.id)
    } catch (error) {
      warn(`session/event ${session?.id ?? '?'}`, error)
    }
  })

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

  /**
   * Applies one Team toggle. The service needs the live Agent that owns the
   * session; a toggle for a session created later waits for `session/created`.
   */
  const applyTeamMode = (sessionId, enabled) => {
    const teams = ctx.get('agentTeams')
    if (!teams) {
      warn(`team ${sessionId}`, 'the agentTeams service is not composed')
      return
    }
    const agent = ctx.agents.get(sessionId)
    if (!agent) {
      teamModes.set(sessionId, enabled)
      return
    }
    teamModes.delete(sessionId)
    Promise.resolve(teams.setEnabled(agent, enabled)).then(
      () => ctx.logger.info(`${name}: session ${sessionId} team mode → ${enabled}`),
      (error) => warn(`team ${sessionId} → ${enabled}`, error),
    )
  }

  /**
   * Applies one session's model route. dsh records the choice as a durable
   * `model/selection` event, so it survives reloads and the Rust transcript
   * sees it without another read. A pick for an Agent that does not exist yet
   * waits for `agent/created`.
   */
  const applyModelSelection = (sessionId, selection) => {
    const agent = ctx.agents.get(sessionId)
    if (!agent?.model) {
      modelSelections.set(sessionId, selection)
      return
    }
    modelSelections.delete(sessionId)
    try {
      agent.model.select(selection)
      ctx.logger.info(
        `${name}: session ${sessionId} model → ${selection.provider}/${selection.model}`,
      )
    } catch (error) {
      warn(`model ${sessionId}`, error)
    }
  }

  const applyPlan = (sessionId, active) => {
    const planMode = ctx.get('planMode')
    const agent = ctx.agents.get(sessionId)
    if (!planMode || !agent) {
      // The engine reads plan state per agent; queue until both exist.
      planModes.set(sessionId, active)
      return
    }
    try {
      planMode.set(agent, active)
      planModes.delete(sessionId)
    } catch (error) {
      planModes.set(sessionId, active)
      warn(`plan ${sessionId}`, error)
    }
  }

  const applyPending = (sessionId) => {
    const cwd = assignments.get(sessionId)
    if (cwd !== undefined) applyAssignment(sessionId, cwd)
    const enabled = teamModes.get(sessionId)
    if (enabled !== undefined) applyTeamMode(sessionId, enabled)
    const selection = modelSelections.get(sessionId)
    if (selection !== undefined) applyModelSelection(sessionId, selection)
    const plan = planModes.get(sessionId)
    if (plan !== undefined) applyPlan(sessionId, plan)
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

  /** Replies to one Rust request; `error` is the engine's own diagnostic. */
  const reply = (type, requestId, body = {}) => {
    send({ type, token, requestId, ...body })
  }

  /**
   * Adopts a new model catalog through the engine's own config editor. The
   * editor validates the rows, rewrites the profile patch and reconciles the
   * Loader, so routes register live; the reply is sent only after that settled.
   * An absent `providers` keeps the running catalog and only refreshes the
   * managed credentials — what a start uses to overwrite a key that an earlier
   * run stored under the same reference, because a stored credential outranks
   * the process environment.
   */
  const applyModels = async (frame) => {
    const requestId = frame.requestId
    try {
      const credentials = ctx.get('credentials')
      const keys = frame.keys && typeof frame.keys === 'object' ? frame.keys : {}
      for (const [ref, value] of Object.entries(keys)) {
        if (!ref || typeof value !== 'string' || value.length === 0) continue
        if (credentials) await credentials.set(ref, value)
      }
      for (const ref of Array.isArray(frame.dropKeys) ? frame.dropKeys : []) {
        if (typeof ref === 'string' && ref) await credentials?.unset(ref)
      }
      const wantsCatalog = frame.providers !== undefined
      const wantsTeam = typeof frame.teamDefaultEnabled === 'boolean'
      if (wantsCatalog || wantsTeam) {
        const editor = ctx.get('configEditor')
        if (!editor) throw new Error('the config editor is not composed')
        const find = (id) => editor.entries().find((entry) => entry.options.id === id)
        if (wantsCatalog) {
          const llm = find('llm-pi-ai')
          if (!llm) throw new Error('the llm-pi-ai row is not composed')
          await editor.edit(llm, (current) => ({
            ...current,
            providers: frame.providers,
          }))
        }
        if (wantsTeam) {
          const team = find('agent-team')
          if (!team) throw new Error('the agent-team row is not composed')
          await editor.edit(team, (current) => ({
            ...current,
            defaultEnabled: frame.teamDefaultEnabled,
          }))
        }
      }
      reply('models-applied', requestId)
    } catch (error) {
      warn('models', error)
      reply('models-applied', requestId, { error: messageOf(error) })
    }
  }

  /**
   * Answers "which models does this endpoint advertise?". The engine's own
   * discovery serves catalog routes from its installed catalog and every other
   * route from the endpoint's listing — the same answer its Models page gets.
   */
  const discoverModels = async (frame) => {
    const requestId = frame.requestId
    try {
      const llm = ctx.get('llm')
      if (!llm?.discoverModels) throw new Error('model discovery is not available')
      const request = {
        provider: typeof frame.provider === 'string' ? frame.provider : '',
        baseURL: typeof frame.baseURL === 'string' ? frame.baseURL : '',
        ...(typeof frame.api === 'string' && frame.api ? { api: frame.api } : {}),
        ...(typeof frame.apiKey === 'string' && frame.apiKey ? { apiKey: frame.apiKey } : {}),
      }
      const models = await llm.discoverModels('llm-pi-ai', request)
      reply('models-discovered', requestId, {
        models: Array.isArray(models) ? models : [],
      })
    } catch (error) {
      warn('discover-models', error)
      reply('models-discovered', requestId, { error: messageOf(error) })
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
    // The runtime-wide default has no session; handle it before the id guard.
    if (frame.type === 'default-mode' && typeof frame.mode === 'string') {
      ctx.get('tapdPolicy')?.setDefault(frame.mode)
      return
    }
    // Catalog requests carry no session either.
    if (frame.type === 'models' && typeof frame.requestId === 'number') {
      void applyModels(frame)
      return
    }
    if (frame.type === 'discover-models' && typeof frame.requestId === 'number') {
      void discoverModels(frame)
      return
    }
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
    } else if (frame.type === 'team' && typeof frame.enabled === 'boolean') {
      applyTeamMode(sessionId, frame.enabled)
    } else if (frame.type === 'mode' && typeof frame.mode === 'string') {
      // Session permission mode: takes effect on the next tool call.
      ctx.get('tapdPolicy')?.setMode(sessionId, frame.mode)
    } else if (frame.type === 'plan' && typeof frame.active === 'boolean') {
      applyPlan(sessionId, frame.active)
    } else if (
      frame.type === 'select-model' &&
      typeof frame.provider === 'string' &&
      frame.provider &&
      typeof frame.model === 'string' &&
      frame.model
    ) {
      const selection = { provider: frame.provider, model: frame.model }
      if (typeof frame.reasoningEffort === 'string' && frame.reasoningEffort) {
        selection.reasoningEffort = frame.reasoningEffort
      }
      applyModelSelection(sessionId, selection)
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
      sendTeamFrames()
      sendStatsFrames()
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
      for (const timer of settleTimers.values()) clearTimeout(timer)
      settleTimers.clear()
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

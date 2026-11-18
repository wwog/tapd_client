/**
 * Conditional TAPD task tools (docs/AGENT_TASK_FLOW.md §4).
 *
 * The built-in agent gets its business capability from native tools, not the
 * MCP sidecar. During the execute phase the model must not even see the word
 * TAPD: the only task tool is `task_submit`, which hands the work to a human
 * review. After the host has committed, merged and cleaned up, the writeback
 * phase swaps the visible surface for the four TAPD close-out tools.
 *
 * Visibility is a registration condition (`when`), evaluated once per model
 * step against an in-memory phase mirror. It never performs RPC and never
 * changes the registration, so a step either sees the tool in its schema or
 * not at all. The host re-validates phase / kind / bug binding inside every
 * `host` request anyway; the guard in `execute` is the second, local check.
 *
 * The plugin is inert without a bridge: the phase mirror is empty, no tool
 * ever becomes visible, and the prompt sections render empty and are dropped.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  commentText,
  completeText,
  isExecuteTask,
  isWritebackTask,
  promptFor,
  statusText,
  submitText,
  transitionsText,
} from './task.js'

export const name = 'tapd-tools'
// `tapd-bridge` provides `tapdBridge` even when it is inert (no URL/token), so
// this plugin still activates in a standalone dsh. Every read below goes
// through `ctx.get` at call time instead of capturing the service during
// activation, so a service that appears later is never missed.
export const inject = ['tools', 'systemPrompt', 'tapdBridge']

/** Prompt sections sit just after the Team policy (600), before PTC-only (800). */
const EXECUTE_SECTION_ORDER = 610
const WRITEBACK_SECTION_ORDER = 620

/** The host rejects longer comments; fail locally instead of on the wire. */
const MAX_COMMENT = 8000

export function apply(ctx) {
  const bridgeOf = () => {
    try {
      return ctx.get('tapdBridge') ?? null
    } catch {
      return null
    }
  }

  /** The mirrored `{ phase, kind }` for one session, or null when untracked. */
  const taskOf = (sessionId) => {
    if (typeof sessionId !== 'string' || !sessionId) return null
    const bridge = bridgeOf()
    if (typeof bridge?.task !== 'function') return null
    try {
      const task = bridge.task(sessionId)
      return task && typeof task === 'object' ? task : null
    } catch (error) {
      ctx.logger.warn(`${name}: task(${sessionId}) failed: ${String(error)}`)
      return null
    }
  }

  /**
   * A `when` that only reads memory. A throw here aborts the whole model step,
   * so it fails closed instead: an unreadable phase hides the tool.
   */
  const visibleWhen = (accepts) => (context) => {
    try {
      const task = taskOf(context?.agent?.session?.id)
      return task != null && accepts(task)
    } catch {
      return false
    }
  }

  /**
   * The execution-time guard. The tool may have been admitted by a `when` that
   * saw an older phase, so the same predicate runs again right before the RPC.
   */
  const phaseGuard = (exec, accepts, tool) => {
    const sessionId = exec?.agent?.session?.id
    const task = taskOf(sessionId)
    if (task == null || !accepts(task)) {
      const state = task == null ? 'unset' : `${task.phase}/${task.kind}`
      throw new Error(`${tool} is not available in this task phase (${state})`)
    }
    return { sessionId, task }
  }

  /** One plugin → host request through the bridge; the host owns validation. */
  const callHost = async (method, sessionId, params = {}) => {
    const bridge = bridgeOf()
    if (typeof bridge?.call !== 'function') {
      throw new Error('TAPD host bridge is not available')
    }
    const data = await bridge.call(method, sessionId, params)
    return data && typeof data === 'object' ? data : {}
  }

  /** Mirrors a phase the host returned; best effort, never breaks the call. */
  const mirrorPhase = (sessionId, phase, kind) => {
    if (typeof phase !== 'string' || !phase) return
    const bridge = bridgeOf()
    if (typeof bridge?.setPhase !== 'function') return
    try {
      if (bridge.setPhase(sessionId, phase, kind) !== false) return
      // An unrecognized phase must not leave a stale `execute` behind: hiding
      // every task tool is the safe reading of "we no longer know the phase".
      ctx.logger.warn(`${name}: host returned unknown phase "${phase}" for ${sessionId}`)
      bridge.setPhase(sessionId, 'none', kind)
    } catch (error) {
      ctx.logger.warn(`${name}: phase mirror for ${sessionId} failed: ${String(error)}`)
    }
  }

  /** The shared output shape: one short line of already-rendered text. */
  const textOutput = () => ({
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', required: true, description: 'Short human-readable result.' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
  })

  // -------------------------------------------------------------------------
  // Execute phase (bug / local_item only)
  // -------------------------------------------------------------------------

  ctx.tools.register(
    defineTool({
      name: 'task_submit',
      description:
        'Submit the finished work for human review. Call it once the change is complete and verified, instead of committing, merging or pushing: the host performs those after a human approves. Include the root cause and the change in summary.',
      parameters: {
        summary: {
          type: 'string',
          required: true,
          description: 'Root cause and what changed.',
        },
        verification: {
          type: 'string',
          description: 'How the change was verified (commands, tests, manual check).',
        },
        risks: {
          type: 'string',
          description: 'Remaining risks, follow-ups or behaviour changes.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            outcome: {
              type: 'string',
              required: true,
              description: 'review when a human must approve, done when nothing changed.',
            },
            phase: {
              type: 'string',
              required: true,
              description: 'Phase after the submission.',
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: submitText(value) }],
      },
      async execute(args, exec) {
        const { sessionId, task } = phaseGuard(exec, isExecuteTask, 'task_submit')
        const summary = typeof args?.summary === 'string' ? args.summary.trim() : ''
        if (!summary) throw new Error('task_submit: summary is required')
        const params = { summary }
        const verification = typeof args?.verification === 'string' ? args.verification.trim() : ''
        if (verification) params.verification = verification
        const risks = typeof args?.risks === 'string' ? args.risks.trim() : ''
        if (risks) params.risks = risks

        const data = await callHost('task.submit', sessionId, params)
        const phase = typeof data.phase === 'string' && data.phase ? data.phase : task.phase
        if (phase !== task.phase) mirrorPhase(sessionId, phase, task.kind)
        return {
          outcome: typeof data.outcome === 'string' && data.outcome ? data.outcome : 'review',
          phase,
        }
      },
    }),
    { when: visibleWhen(isExecuteTask) },
  )

  // -------------------------------------------------------------------------
  // Writeback phase (bug only)
  // -------------------------------------------------------------------------

  ctx.tools.register(
    defineTool({
      name: 'tapd_get_transitions',
      description:
        "Read the TAPD bug bound to this session: its current status and the transitions the host will accept. The session supplies the bug id; there is no bugId parameter.",
      parameters: {},
      output: textOutput(),
      async execute(_args, exec) {
        const { sessionId } = phaseGuard(exec, isWritebackTask, 'tapd_get_transitions')
        const data = await callHost('tapd.transitions', sessionId)
        return { text: transitionsText(data) }
      },
    }),
    { when: visibleWhen(isWritebackTask) },
  )

  ctx.tools.register(
    defineTool({
      name: 'tapd_add_comment',
      description:
        'Write the close-out comment on the TAPD bug bound to this session. Repeat calls are idempotent and report duplicate. The session supplies the bug id; never pass one.',
      parameters: {
        comment: {
          type: 'string',
          required: true,
          description: 'Comment body: root cause, change, verification, risk, branch, commit.',
        },
      },
      output: textOutput(),
      async execute(args, exec) {
        const { sessionId } = phaseGuard(exec, isWritebackTask, 'tapd_add_comment')
        const comment = typeof args?.comment === 'string' ? args.comment.trim() : ''
        if (!comment) throw new Error('tapd_add_comment: comment is required')
        if (comment.length > MAX_COMMENT) {
          throw new Error(`tapd_add_comment: comment exceeds ${MAX_COMMENT} characters`)
        }
        const data = await callHost('tapd.comment', sessionId, { comment })
        return { text: commentText(data) }
      },
    }),
    { when: visibleWhen(isWritebackTask) },
  )

  ctx.tools.register(
    defineTool({
      name: 'tapd_update_status',
      description:
        'Move the TAPD bug bound to this session to one of the allowed target statuses (resolved for a fix). Read tapd_get_transitions first; the host rejects an illegal target.',
      parameters: {
        status: {
          type: 'string',
          required: true,
          description: 'Target status key the host listed, e.g. resolved.',
        },
      },
      output: textOutput(),
      async execute(args, exec) {
        const { sessionId } = phaseGuard(exec, isWritebackTask, 'tapd_update_status')
        const status = typeof args?.status === 'string' ? args.status.trim() : ''
        if (!status) throw new Error('tapd_update_status: status is required')
        const data = await callHost('tapd.status', sessionId, { status })
        return { text: statusText(data) }
      },
    }),
    { when: visibleWhen(isWritebackTask) },
  )

  ctx.tools.register(
    defineTool({
      name: 'task_complete',
      description:
        'Finish the TAPD writeback. The host fails this call unless both a comment and a status change were recorded, so fix the reported gap and retry in the same turn.',
      parameters: {
        note: { type: 'string', description: 'Optional short note about the close-out.' },
      },
      output: textOutput(),
      async execute(args, exec) {
        const { sessionId } = phaseGuard(exec, isWritebackTask, 'task_complete')
        const note = typeof args?.note === 'string' ? args.note.trim() : ''
        await callHost('task.complete', sessionId, note ? { note } : {})
        return { text: completeText() }
      },
    }),
    { when: visibleWhen(isWritebackTask) },
  )

  // -------------------------------------------------------------------------
  // Conditional prompt sections (empty strings are dropped by assembly)
  // -------------------------------------------------------------------------

  const sectionTask = (context) => taskOf(context?.agent?.session?.id)

  ctx.systemPrompt.section({
    name: 'tapd:task-execute',
    order: EXECUTE_SECTION_ORDER,
    text: (context) => {
      const task = sectionTask(context)
      return task?.phase === 'execute' ? promptFor(task) : ''
    },
  })

  ctx.systemPrompt.section({
    name: 'tapd:task-writeback',
    order: WRITEBACK_SECTION_ORDER,
    text: (context) => promptFor(sectionTask(context)),
  })
}

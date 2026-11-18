/**
 * Phase selection and rendering for the conditional TAPD task tools.
 *
 * Kept free of SDK imports so the rules below are unit-testable without the
 * dsh payload: `index.js` owns registration, this module owns "which phase
 * sees what" and how one host reply reads to the model.
 *
 * The phase map belongs to the host (docs/AGENT_TASK_FLOW.md §4.1). These
 * helpers only interpret the mirror the bridge exposes, and the same predicate
 * is applied twice — once in `when` for visibility, once before execution —
 * so a stale mirror cannot slip a call through.
 */

/** Task kinds that run the execute → review → writeback flow. */
export const EXECUTE_KINDS = new Set(['bug', 'local_item'])

/** Execute phase: `task_submit` exists, no TAPD tool does. */
export function isExecuteTask(task) {
  return task != null && task.phase === 'execute' && EXECUTE_KINDS.has(task.kind)
}

/**
 * The execute prompt is shown for any non-chat kind (the tools themselves stay
 * bug/local-only): a future task kind still deserves "submit, do not commit".
 */
export function showsExecutePrompt(task) {
  return task != null && task.phase === 'execute' && task.kind !== 'chat'
}

/** Writeback phase: TAPD close-out tools exist, and only for bugs. */
export function isWritebackTask(task) {
  return task != null && task.phase === 'writeback' && task.kind === 'bug'
}

/** §6.1 — the execute-phase prompt section. */
export const EXECUTE_PROMPT = [
  '任务提交（执行阶段）',
  '',
  '代码修改完成后，必须调用 `task_submit`，用 summary 说明根因与改动，用 verification 说明你如何验证，用 risks 说明风险点；调用后停止继续修改。不要 git commit、不要 push、不要写任何外部系统。',
].join('\n')

export const EXECUTE_PROMPT_EN = [
  'Task submission (execute phase)',
  '',
  'When the code change is complete, call `task_submit`: summary explains the root cause and the change, verification explains how you checked it, risks lists what remains. Stop editing after the call. Do not git commit, do not push, and do not write to any external system.',
].join('\n')

/** §6.2 — the writeback-phase prompt section. */
export const WRITEBACK_PROMPT = [
  'TAPD 收尾（写回阶段）',
  '',
  '代码已由宿主提交并合并到主仓库，worktree 已清理；不要 push、不要修改代码。',
  '现在只做 TAPD 收尾：',
  '1. `tapd_get_transitions` 确认合法目标；',
  '2. `tapd_add_comment` 写评论（根因、改动、验证、风险、分支、提交）；',
  '3. `tapd_update_status` 置为 resolved；',
  '4. `task_complete`。',
  '工具失败按错误提示修正后重试。',
].join('\n')

export const WRITEBACK_PROMPT_EN = [
  'TAPD close-out (writeback phase)',
  '',
  'The host committed the work, merged it into the main repository and cleaned up the worktree. Do not push and do not modify code.',
  'Only finish the TAPD side:',
  '1. `tapd_get_transitions` to confirm the legal targets;',
  '2. `tapd_add_comment` with the root cause, change, verification, risks, branch and commit;',
  '3. `tapd_update_status` to `resolved`;',
  '4. `task_complete`.',
  'If a tool fails, fix the reported gap and retry.',
].join('\n')

const isEnglish = () => process.env.TAPD_DSH_LOCALE === 'en'

/** The prompt body for a task's current phase; `''` renders as no section. */
export function promptFor(task) {
  if (showsExecutePrompt(task)) {
    return isEnglish() ? EXECUTE_PROMPT_EN : EXECUTE_PROMPT
  }
  if (isWritebackTask(task)) {
    return isEnglish() ? WRITEBACK_PROMPT_EN : WRITEBACK_PROMPT
  }
  return ''
}

/** One line for a `task.submit` reply (`outcome` is review | done | already). */
export function submitText(value = {}) {
  const phase = typeof value.phase === 'string' && value.phase ? value.phase : ''
  const suffix = phase ? `（phase=${phase}）` : ''
  switch (value.outcome) {
    case 'review':
      return `已提交，等待人工审核${suffix}。`
    case 'done':
      return '已提交；本次没有代码改动，任务已完成。'
    case 'already':
      return `本次已经提交过，未重复提交${suffix}。`
    default:
      return `已提交${suffix}。`
  }
}

/** Current status plus the transitions the host will accept. */
export function transitionsText(data = {}) {
  const current = typeof data.current === 'string' && data.current ? data.current : '未知'
  const alias =
    typeof data.alias === 'string' && data.alias && data.alias !== current
      ? `（${data.alias}）`
      : ''
  const transitions = Array.isArray(data.transitions) ? data.transitions : []
  const lines = [`当前状态：${current}${alias}`]
  if (transitions.length === 0) {
    lines.push('没有可用的状态流转。')
    return lines.join('\n')
  }
  lines.push('可流转到：')
  for (const item of transitions) {
    const key = typeof item === 'string' ? item : typeof item?.key === 'string' ? item.key : ''
    if (!key) continue
    const label =
      typeof item?.label === 'string' && item.label && item.label !== key ? `（${item.label}）` : ''
    lines.push(`- ${key}${label}`)
  }
  return lines.join('\n')
}

/** Result of a comment write; a repeat is idempotent, not an error. */
export function commentText(data = {}) {
  return data.duplicate === true ? '评论已存在，未重复写入。' : '评论已写入。'
}

/** Result of a status move. */
export function statusText(data = {}) {
  const from = typeof data.from === 'string' && data.from ? data.from : '未知'
  const to = typeof data.to === 'string' && data.to ? data.to : '未知'
  return `状态已从 ${from} 变更为 ${to}。`
}

/** Result of the final consistency check. */
export function completeText() {
  return '收尾完成：评论与状态均已记录，任务已置为 done。'
}

/**
 * Permission gate for the built-in agent (docs/DSH.md §9.3).
 *
 * `tools/pre-execute` is the upstream waterfall for allow / ask before a tool
 * body runs. This plugin is the deterministic half of the permission story:
 * one rule table, no model call, no token cost, unit-testable.
 *
 * The mode is per session. `TAPD_DSH_PERMISSION_MODE` only seeds the default;
 * the desktop pushes overrides over the bridge control channel and the gate
 * reads them on the next call, so switching a session never restarts anything:
 *
 *   auto   (default)  hard + soft → ask (our capsule card)
 *   notify            hard + soft → notice card, always allow
 *   full              hard → ask, everything else allowed
 *
 * The mode also owns the engine's own sandbox (`sandbox/mode`), because two
 * gates asking for one write is worse than one:
 *
 * - auto keeps `workspace-write`, so the engine enforces the session boundary.
 *   Path-boundary rules (`outside_cwd`, `protected_path`) therefore defer to
 *   it instead of asking a second time — the sandbox's own escalation card is
 *   the one prompt for that write.
 * - notify and full promise "it runs", so they switch the sandbox to
 *   `danger-full-access`; otherwise the engine would keep asking for exactly
 *   the writes those modes say are allowed.
 *
 * Plan mode is a separate engine flag (not a permission mode): while it is
 * active, file-writing tools are denied so "plan first" is deterministic, and
 * the model leaves it through the engine's own `exit_plan_mode` review.
 *
 * `ask` goes through the runtime's approval service (initialized with
 * `approvalRequests: true`), which reaches the app as `approval/request`.
 *
 * Everything else here is deliberate:
 * - `reason` is a short audited identifier line (`hard:rm_rf_root: rm -rf /`),
 *   because `approval/request` carries no separate target field. The Rust side
 *   splits it to localize the card and show the target.
 * - notices are one-way frames on the TAPD bridge; without a bridge they are
 *   dropped rather than blocking the call.
 * - this plugin never throws into the tool pipeline: a classifier bug must not
 *   break every tool call, so it fails open and logs.
 */

import { homedir } from 'node:os'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

export const name = 'tapd-policy'
export const inject = ['tools', 'agents']

const MODES = new Set(['auto', 'notify', 'full'])
const MAX_TARGET = 160

/** Tools whose first argument is a shell command line. */
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'bash_persistent', 'pwsh_persistent'])

/** Tools that write exactly the paths in their arguments. */
const FILE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor'])

/** Risky only because of *where* the write lands: the engine sandbox owns these. */
const PATH_RULES = new Set(['outside_cwd', 'protected_path'])

/** One-line descriptions for the SDK-side approval prompt (other clients). */
const DESCRIPTIONS = {
  sudo: { en: 'Runs a command as the superuser.', zh: '以超级用户身份执行命令。' },
  mkfs: { en: 'Formats a filesystem.', zh: '格式化文件系统。' },
  dd_disk: { en: 'Writes raw data to a device.', zh: '直接写入磁盘设备。' },
  rm_rf_root: { en: 'Recursively deletes the home or filesystem root.', zh: '递归删除主目录或文件系统根目录。' },
  chmod_root: { en: 'Makes the filesystem root world-writable.', zh: '把文件系统根目录改成所有人可写。' },
  git_force_push: { en: 'Force-pushes and can erase remote history.', zh: '强制推送，可能抹掉远端历史。' },
  drop_table: { en: 'Drops a database table.', zh: '删除数据库表。' },
  pipe_to_shell: { en: 'Pipes a download into a shell.', zh: '把下载内容直接交给 shell 执行。' },
  protected_path: { en: 'Writes credentials or keys.', zh: '写入凭证或密钥文件。' },
  outside_cwd: { en: 'Writes outside the session directory.', zh: '写入会话工作目录之外。' },
  package_install: { en: 'Installs dependencies.', zh: '安装依赖。' },
  git_push: { en: 'Pushes commits to a remote.', zh: '向远端推送提交。' },
  upload: { en: 'Uploads data to a remote host.', zh: '向远端上传数据。' },
}

export function apply(ctx) {
  const raw = process.env.TAPD_DSH_PERMISSION_MODE
  let defaultMode = MODES.has(raw) ? raw : 'auto'
  if (raw !== undefined && !MODES.has(raw)) {
    ctx.logger.warn(`${name}: unknown TAPD_DSH_PERMISSION_MODE "${raw}", using auto`)
  }

  // Session overrides. The desktop pushes these over the bridge control
  // channel; they take effect on the next tool call, no runtime restart.
  const sessionModes = new Map()
  // A subagent inherits the session it was delegated from. The root is resolved
  // at call time so a mode change on the root reaches running children too.
  const parentOf = new Map()

  const known = (mode) => (MODES.has(mode) ? mode : undefined)

  const modeForSession = (session) => {
    let id = session?.id
    for (let depth = 0; id && depth < 8; depth += 1) {
      const override = sessionModes.get(id)
      if (override !== undefined) return override
      id = parentOf.get(id)
    }
    return defaultMode
  }

  // The engine's sandbox for each session, as this plugin last wrote it. A
  // session's `sandbox/mode` event is durable, so the map only saves a repeated
  // identical append (the desktop re-pushes the mode before every prompt).
  const sandboxApplied = new Map()

  /** `auto` keeps the engine's confinement; the "let it run" modes drop it. */
  const sandboxFor = (mode) => (mode === 'auto' ? 'workspace-write' : 'danger-full-access')

  const applySandbox = (session, mode) => {
    if (!session?.id) return
    const target = sandboxFor(mode)
    if (sandboxApplied.get(session.id) === target) return
    try {
      // The write path `setSandboxMode()` uses: the switch *is* the event, and
      // the last one wins. Inlined so this plugin keeps zero imports and stays
      // unit-testable outside the payload tree.
      session.append('sandbox/mode', { mode: target })
      sandboxApplied.set(session.id, target)
    } catch (error) {
      // A session that cannot take the event keeps its composition default;
      // the gate above still decides, so this must not break the call.
      ctx.logger.warn(`${name}: sandbox mode for ${session.id} not set: ${String(error)}`)
    }
  }

  const sandboxForSession = (session) => applySandbox(session, modeForSession(session))

  ctx.on('session/created', (session) => {
    const parent = session?.header?.parentSession
    if (session?.id && parent && session.header?.origin === 'subagent') {
      parentOf.set(session.id, parent)
    }
    sandboxForSession(session)
  })

  // A session may exist before its Agent: the Agent edge is when a resumed
  // session gets its sandbox back.
  ctx.on('agent/created', ({ agent } = {}) => sandboxForSession(agent?.session))

  ctx.provide('tapdPolicy', {
    setDefault(mode) {
      const next = known(mode)
      if (next === undefined) return
      defaultMode = next
      // Sessions without their own pick follow the default right away; the
      // others keep theirs.
      for (const agent of ctx.agents.list()) {
        const session = agent?.session
        if (session?.id && !sessionModes.has(session.id)) applySandbox(session, next)
      }
    },
    setMode(sessionId, mode) {
      const next = known(mode)
      if (!sessionId || next === undefined) return
      sessionModes.set(sessionId, next)
      applySandbox(ctx.agents.get(sessionId)?.session, next)
    },
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    // The field name differs between the execution contract (`name`) and the
    // SDK approval request (`toolName`); accept both so a rename upstream does
    // not silently disable the gate.
    const tool = String(exec?.toolName ?? exec?.name ?? '')
    // Plan mode is prompt-enforced upstream; this gate makes the file-writing
    // half deterministic so picking 计划模式 actually means "plan first".
    if (FILE_TOOLS.has(tool) && planActive(ctx, exec?.agent?.session)) {
      return {
        kind: 'deny',
        reason: `plan mode: files cannot be modified before the plan is approved; call exit_plan_mode with the plan first (${tool})`,
      }
    }
    const mode = modeForSession(exec?.agent?.session)
    let hit
    try {
      hit = classifyCall({
        tool,
        args: exec?.arguments ?? {},
        cwd: sessionCwd(ctx, exec),
        home: homedir(),
      })
    } catch (error) {
      ctx.logger.warn(`${name}: classifier failed, allowing ${tool}: ${String(error)}`)
      return next()
    }
    if (!hit.risk) return next()

    // In auto the engine's sandbox is the boundary for path writes: it denies
    // or escalates them itself, with its own card. Asking here as well would
    // prompt twice for one write.
    if (mode === 'auto' && PATH_RULES.has(hit.rule)) return next()

    if (mode === 'notify') {
      raiseNotice(ctx, exec, hit)
      return next()
    }
    if (mode === 'full' && hit.risk !== 'hard') return next()

    return {
      kind: 'ask',
      reason: `${hit.risk}:${hit.rule}: ${hit.target}`,
      displayReason: {
        en: `${DESCRIPTIONS[hit.rule]?.en ?? 'Sensitive operation.'} (${hit.target})`,
        zh: `${DESCRIPTIONS[hit.rule]?.zh ?? '敏感操作。'}（${hit.target}）`,
      },
    }
  })
}

/**
 * Whether the session is in the engine's plan mode. The projection throws while
 * the plugin is not activated yet; treating that as "not planning" keeps the
 * gate open rather than breaking every tool call.
 */
function planActive(ctx, session) {
  if (!session) return false
  try {
    return ctx.get('planMode')?.selectedActive(session) === true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Classification (pure; exported for tests)
// ---------------------------------------------------------------------------

/**
 * Decides whether one call is risky. Returns `{ risk, rule, target }`, with
 * `risk: null` when the call is ordinary. Paths and the home directory are
 * arguments so the rule table is testable without a live session.
 */
export function classifyCall({ tool, args = {}, cwd = '', home = '' }) {
  if (SHELL_TOOLS.has(tool)) {
    return classifyShell(String(args.command ?? args.cmd ?? ''), { cwd, home })
  }
  if (FILE_TOOLS.has(tool)) {
    return classifyPaths(writeTargets(tool, args), { cwd, home })
  }
  return { risk: null }
}

function classifyShell(command, { cwd, home }) {
  const text = command.trim()
  if (!text) return { risk: null }
  const target = truncate(text)

  // Rules run on a normalized line: bash treats newlines as separators, and
  // quotes must not hide `sudo` or `of=/dev/...`. Paths are parsed from the
  // original text below, where quoted *write targets* are kept.
  const scan = text
    .replace(/["']/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, ' ; ')
    // `git -C repo push` is the same command as `git push`.
    .replace(
      /\bgit\s+(?:-C\s+\S+\s+|--git-dir=\S+\s+|--work-tree=\S+\s+|-c\s+\S+\s+)+/g,
      'git ',
    )

  for (const [rule, matches] of HARD_SHELL) {
    if (matches(scan, home)) return { risk: 'hard', rule, target }
  }
  // Only paths a command actually writes are write targets. An `ls`/`find`
  // operand or a `2>/dev/null` is not — see `shellWriteTargets`.
  const written = shellWriteTargets(text, cwd, home)
  if (written.some((path) => isProtected(path, home))) {
    return { risk: 'hard', rule: 'protected_path', target }
  }
  for (const [rule, matches] of SOFT_SHELL) {
    if (matches(scan)) return { risk: 'soft', rule, target }
  }
  const outside = written.find((path) => outsideOf(path, cwd))
  if (outside) return { risk: 'soft', rule: 'outside_cwd', target: truncate(outside) }
  return { risk: null }
}

function classifyPaths(paths, { cwd, home }) {
  // File tools name their targets relative to the session directory, so the
  // session cwd (never the process cwd) resolves them.
  const absolute = paths.map((path) => canonical(resolvePath(path, home, cwd)))
  const protectedHit = absolute.find((path) => isProtected(path, home))
  if (protectedHit) {
    return { risk: 'hard', rule: 'protected_path', target: truncate(protectedHit) }
  }
  const outside = absolute.find((path) => outsideOf(path, cwd))
  if (outside) return { risk: 'soft', rule: 'outside_cwd', target: truncate(outside) }
  return { risk: null }
}

const HARD_SHELL = [
  // `(^|[\s;&|(])` also catches a quote-wrapped `bash -c "sudo …"` once the
  // scan line drops quotes.
  ['sudo', (text) => /(^|[\s;&|(])sudo\b/.test(text)],
  ['mkfs', (text) => /(^|[\s;&|(])mkfs(\.\w+)?\b/.test(text)],
  ['dd_disk', (text) => /\bdd\b[^;&|]*\bof=\/dev\//.test(text)],
  ['rm_rf_root', (text) => deletesRoot(text)],
  ['chmod_root', (text) => /chmod\s+(-[A-Za-z]+\s+)*(777|a\+rwx|\+rwx)\s+(-[A-Za-z]+\s+)*(\/(\*)?|~(\/)?)(\s|$|[;&|])/.test(text)],
  // The git prefix is normalized to `git ` before this runs, so `-C`/`-c`
  // forms match; `+refspec` is the other force form.
  ['git_force_push', (text) => /git\s+push\b[^;&|]*\s(--force(-with-lease)?|-[a-z]*f[a-z]*|\+\S+)(\s|$)/.test(text)],
  ['drop_table', (text) => /drop\s+(table|database|schema)\b/i.test(text)],
  ['pipe_to_shell', (text) => /(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|k|da)?sh\b/.test(text)],
]

const SOFT_SHELL = [
  ['package_install', (text) => /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b/.test(text)],
  ['package_install', (text) => /\b(brew|pip|pip3|uv)\s+(install|add)\b/.test(text)],
  ['git_push', (text) => /\bgit\s+push\b/.test(text)],
  ['upload', (text) => /\bcurl\b[^;&|]*\s(-T|--upload-file)\b/.test(text)],
  ['upload', (text) => /(^|[\s;&|(])scp\b/.test(text)],
]

/** Commands that create, replace, move or delete something on disk. */
const WRITE_VERBS =
  'rm|rmdir|mv|cp|tee|dd|chmod|chown|ln|touch|mkdir|install|shred|truncate|unlink'

function deletesRoot(text) {
  const call = /\brm\s+([^;&|]*)/g
  let match
  while ((match = call.exec(text)) !== null) {
    const words = match[1].trim().split(/\s+/)
    const recursive = words.some((word) => /^-[A-Za-z]*[rR]/.test(word) || word === '--recursive')
    const force = words.some((word) => /^-[A-Za-z]*f/.test(word) || word === '--force')
    const targets = words.filter((word) => !word.startsWith('-'))
    if (recursive && force && targets.some(isRootPath)) return true
  }
  return false
}

const ROOT_PATHS = new Set([
  '/',
  '/*',
  '~',
  '~/',
  '~/*',
  '$HOME',
  '$HOME/',
  '$HOME/*',
  '${HOME}',
  '${HOME}/',
  '${HOME}/*',
])

function isRootPath(path) {
  return ROOT_PATHS.has(stripQuotes(path))
}

/** Paths a write tool would touch; `apply_patch` names them in the patch body. */
function writeTargets(tool, args) {
  if (tool !== 'apply_patch') {
    return [String(args.file_path ?? args.path ?? '')].filter(Boolean)
  }
  const patch = String(args.input ?? '')
  const paths = []
  const header = /^\*\*\*\s+(?:Add|Update|Delete) File:\s*(.+)$/gm
  let match
  while ((match = header.exec(patch)) !== null) paths.push(match[1].trim())
  const move = /^\*\*\*\s+Move to:\s*(.+)$/gm
  while ((match = move.exec(patch)) !== null) paths.push(match[1].trim())
  return paths.filter(Boolean)
}

/**
 * The paths one shell line actually writes.
 *
 * The line is split where a new command starts, and a segment contributes a
 * write target only when it redirects to a real file or passes paths to a
 * write verb. The previous version gated on "the line contains `>`" and then
 * treated *every* absolute token on it as a write target, so `find … 2>/dev/null`
 * asked to approve `/dev/null` and `ls /other/repo 2>/dev/null` asked to
 * approve a directory it only listed.
 */
function shellWriteTargets(text, cwd, home) {
  const found = []
  for (const segment of text.split(/\n|;|&&|\|\||\|/)) {
    found.push(...redirectionTargets(segment), ...writeVerbTargets(segment))
  }
  return found
    .map((token) => stripQuotes(token.trim()))
    .filter((token) => token && !token.startsWith('&') && !isDevicePath(token))
    .map((token) => canonical(resolvePath(token, home, cwd)))
}

/**
 * `> file` and `>> file`, quoted or not. The `2>` of `2>/dev/null` is a file
 * descriptor, not a target, and `>&1` duplicates one.
 */
function redirectionTargets(segment) {
  const found = []
  const redirect = /(?<![0-9&])>>?\s*("[^"]+"|'[^']+'|[^\s;&|()]+)/g
  let match
  while ((match = redirect.exec(segment)) !== null) found.push(match[1])
  return found
}

/** The path operands of the first write verb in one command segment. */
function writeVerbTargets(segment) {
  const command = new RegExp(
    `(?:^|[\\s;&|(])(?:sudo\\s+)?(?:${WRITE_VERBS})\\b([^;&|]*)`,
  ).exec(segment)
  if (!command) return []
  return command[1]
    .split(/\s+/)
    .map((word) => stripQuotes(word))
    // `dd of=/tmp/x` names its target with a prefix rather than positionally.
    .map((word) => word.replace(/^[A-Za-z_]+=/, ''))
    .filter((word) => word && !word.startsWith('-'))
}

/** Devices and pipes: writing them never touches the filesystem's state. */
const DEVICE_PATHS = new Set([
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/stdin',
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/tty',
])

function isDevicePath(path) {
  return DEVICE_PATHS.has(path) || path.startsWith('/dev/fd/')
}

function resolvePath(path, home, cwd = '') {
  const cleaned = stripQuotes(path.trim())
  if (cleaned.startsWith('${HOME}')) return home + cleaned.slice(7)
  if (cleaned.startsWith('$HOME')) return home + cleaned.slice(5)
  if (cleaned === '~') return home
  if (cleaned.startsWith('~/')) return `${home}${cleaned.slice(1)}`
  if (cleaned.startsWith('~')) {
    // `~user` needs an OS lookup; on macOS a user home is /Users/<user>
    // (/var/root for root), which is enough to catch credential targets.
    const slash = cleaned.indexOf('/')
    const user = slash === -1 ? cleaned.slice(1) : cleaned.slice(1, slash)
    const rest = slash === -1 ? '' : cleaned.slice(slash)
    if (user) return `${user === 'root' ? '/var/root' : `/Users/${user}`}${rest}`
  }
  if (!isAbsolute(cleaned) && cwd) return `${cwd.replace(/\/$/, '')}/${cleaned}`
  return cleaned
}

/**
 * Follows symlinks so a link inside the workspace cannot launder a write into
 * `~/.ssh`; for a not-yet-created file the existing parent is enough.
 */
function canonical(path) {
  try {
    return realpathSync(path)
  } catch {
    // Target does not exist (yet): resolve the parent instead.
  }
  try {
    return join(realpathSync(dirname(path)), basename(path))
  } catch {
    return path
  }
}

/**
 * Credential locations under the user's home. Anchoring on `home` keeps a
 * repository's own `.ssh` directory out of the hard set while catching both
 * `~/.ssh/id_rsa` and `/Users/me/.ssh/id_rsa`.
 */
const PROTECTED_SUFFIXES = ['/.ssh', '/.aws', '/Library/Keychains']

function isProtected(path, home) {
  if (!home) return false
  const root = home.replace(/\/$/, '')
  return PROTECTED_SUFFIXES.some(
    (suffix) => path === `${root}${suffix}` || path.startsWith(`${root}${suffix}/`),
  )
}

function outsideOf(path, cwd) {
  if (!path || !cwd) return false
  const rel = relative(cwd, path)
  return rel.startsWith('..') || isAbsolute(rel)
}

function stripQuotes(token) {
  return token.replace(/^['"]|['"]$/g, '').replace(/[,:]+$/, '')
}

function truncate(text) {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_TARGET ? `${oneLine.slice(0, MAX_TARGET - 1)}…` : oneLine
}

// ---------------------------------------------------------------------------
// Session cwd and the notice channel
// ---------------------------------------------------------------------------

/**
 * The session's effective directory. `workingDirectory` owns it (a task can
 * move the session into a worktree); the header cwd is the fallback for
 * sessions created before that service is consulted.
 */
function sessionCwd(ctx, exec) {
  const session = exec?.agent?.session
  try {
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory && session) return workingDirectory.get(session)
  } catch {
    // Service unavailable: the header cwd below is good enough for a rule check.
  }
  return session?.header?.cwd ?? process.cwd()
}

/**
 * Notify mode is advisory: the call always runs. A missing bridge (standalone
 * dsh, payload smoke test) simply means nobody to notify.
 */
function raiseNotice(ctx, exec, hit) {
  try {
    const bridge = ctx.get('tapdBridge')
    bridge?.notice({
      sessionId: exec?.agent?.session?.id ?? '',
      tool: String(exec?.toolName ?? exec?.name ?? ''),
      target: hit.target,
      risk: hit.risk,
    })
  } catch (error) {
    ctx.logger.warn(`${name}: notice failed: ${String(error)}`)
  }
}

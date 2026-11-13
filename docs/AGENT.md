# Agent 修复队列

把「处理缺陷」接到本机已安装的编码 Agent：导出 `bug.json` → 队列（Worktree 开启时可并行）→ 在 PTY 中启动 Agent 的 TUI → 自动投递任务 → 输出直接渲染到右侧终端（不落盘，可随时键盘接管）；产生改动的任务由安全网进入待审核，开启 Worktree 时审核通过后还要合并回主仓库。

支持的运行时由 `runtime_catalog()` 统一定义，新增 Agent 只需加一条描述符，不改队列与界面。

## 1. 运行时

| 运行时 | 启动命令 | 提示词投递 | MCP 自动注入 |
| --- | --- | --- | --- |
| OpenCode | `opencode` | 启动后写入终端 | 是 |
| Claude Code | `claude` | 随 argv 传入 | 是 |
| Codex | `codex` | 随 argv 传入 | 是 |
| Cursor Agent | `cursor-agent` | 随 argv 传入 | 是 |
| ZCode | `zcode` | 启动后写入终端 | 是 |
| Gemini CLI | `gemini -i <prompt>` | 随 flag 传入 | 是 |
| Qwen Code | `qwen` | 启动后写入终端 | 是 |
| GitHub Copilot | `copilot -i <prompt>` | 随 flag 传入 | 需手动配置 |
| Cline | `cline` | 启动后写入终端 | 需手动配置 |
| Aider | `aider` | 启动后写入终端 | 需手动配置 |
| Goose | `goose` | 启动后写入终端 | 需手动配置 |
| 自定义命令 | 用户填写 | 启动后写入终端 | 需手动配置 |

启动参数与注入方式参考 orca 的 TUI agent 适配表。命令可在设置中改成绝对路径；参数由描述符提供。

## 2. 配置

Agent 页 →「配置」：

| 配置 | 说明 |
| --- | --- |
| 运行时 | 从目录中选择一个作为默认运行时 |
| 可执行路径 | 默认取该运行时的命令；可填绝对路径 |
| prompt 模板 | 支持变量 `{{task_id}}`、`{{title}}`、`{{json_path}}`、`{{repo_path}}`、`{{workspace_name}}`、`{{bug_id}}`、`{{severity}}`、`{{priority}}`、`{{user_prompt}}`、`{{attachments}}`、`{{coworker}}` |
| TUI 就绪静默 | 有输出后静默多久认为 TUI 就绪，默认 900ms |
| 就绪超时 | 最长等待，默认 15s；超时会强制注入并记录 warning |
| 静默完成 | 输出静默多久视为本轮结束，默认 180s；0 表示关闭。进程退出与会话 hook 是主信号，静默只做兜底 |
| 默认模型 | 该运行时的默认 `--model`；留空交给 CLI。提交面板可按任务覆盖 |
| 访问权限 | 默认权限 / 自动执行 / 完全访问 / 只读计划等，按运行时能力提供；提交面板可按任务覆盖 |

「用 Agent 修复」面板底部可以为本次任务单独选择运行时、模型与访问权限。模型输入带常用值建议，
也可以直接填 CLI 支持的任意模型名（例如 OpenCode 的 `provider/model`）。权限选项会翻译成各 CLI
自己的参数：Claude `--permission-mode`、Codex `--full-auto` / `--dangerously-bypass-approvals-and-sandbox`、
OpenCode `--auto`、OMP `--approval-mode write|yolo`。

任务结束判定只认成功回合：会话 hook 报错、transcript 里 provider 记录的最终错误（如重试耗尽、
`ECONNRESET`、模型不可用）或没有 hook 时的非零退出码都会把任务标记为失败，不会显示成完成。

配置文件：`~/Library/Application Support/com.tapdclient.desktop/agent.json`。

Agent 页 →「配置」里的「Agent 执行」控制并行与隔离：

| 配置 | 说明 |
| --- | --- |
| Worktree 隔离 | 默认关闭。开启后每个任务在独立 git worktree 中运行，产生改动先审核、再确认合并回主仓库；队列有未结束任务时不能切换 |
| 执行单元 | Worktree 关闭时固定为 1；开启后可调 1–8，默认 2。执行单元不受开关锁影响，随时可调 |
| 启动恢复排队 | 默认开启。关闭后重启仍保留排队任务，但队列保持暂停，等用户手动「继续队列」，不会自动继续执行 |

每个 TAPD 项目在项目卡片里配置本地仓库路径与项目规则；缺失仓库时任务会失败并提示去配置。项目规则不再注入内置提示词，而是通过 `tapd_get_bug` 的 `projectRule` 返回。

### 同事与技能注入

「同事」页勾选的内置同事可叠加，选择顺序会写进 `agent.json` 的 `coworkerIds`。每个任务
组装提示词时，`{{coworker}}` 会展开为一段协作说明：角色、简述和每个技能包的
`SKILL.md` 绝对路径，要求 Agent 开工前先读取。模板没有 `{{coworker}}` 插槽时整段追加；
没有启用同事时整段为空，不会留下空标题。同事包格式与投稿规范见
[`assets/coworker/README.md`](../assets/coworker/README.md)。

## 3. 触发方式

- 缺陷详情 →「用 Agent 修复」。
- 通知窗口 →「处理」（完成改派/接受后触发 `agent://enqueue`）。

任务入队后：

1. 状态 `queued`，立即返回前端（提示“已加入队列”）；任务记录写入来源 `source`（缺陷页 / 列表手动发起为 `manual`，通知卡「处理」为 `notification`），历史页展示。
2. `preparing`：调用导出，生成 `bug.json` + `assets/`。
3. 解析并校验主仓库；开启 Worktree 时创建或复用独立 worktree，确定 `work_dir()`（worktree 或项目主仓库）。
4. 校验运行时命令，并尝试把 tapd MCP 写入该客户端的用户级配置（支持 opencode / zcode / claude / cursor / codex / OMP / Kimi Code / Gemini CLI / Qwen Code；失败只记录 warning）。随后为支持会话 hook 的运行时安装/刷新原生 hook（Codex / OpenCode / Claude / Cursor / Gemini / Qwen / OpenClaude / Qoder / Qoder CN / CodeBuddy / Kimi / ZCode / OMP），事件 POST 到桌面端 loopback `/agent/hook`。Codex 会同时写入 `hooks.json` 与 `config.toml` 的信任哈希。最后在 `work_dir()` 用 PTY 启动运行时。
   - `argv` / `flag` 模式：提示词随启动命令传入。
   - `stdin` 模式：等待 TUI 就绪后，用括号粘贴写入提示词并回车。
5. 修复轮（Worktree 关闭）：简单任务直接 `git commit`，提交后通过 MCP 评论并更新 TAPD；复杂任务不 commit、不评论、不改 TAPD，结束后由安全网进入 `awaiting_approval`。
6. 修复轮（Worktree 开启）：任务在独立 worktree 中运行，修复阶段不回写 TAPD。简单任务只 commit；复杂任务保留未提交改动。只要本轮产生改动（已提交或未提交），都进入 `awaiting_approval`。
7. 审核通过：Worktree 关闭时回到 `queued`，用提交专用提示词提交并回写 TAPD；Worktree 开启时若有未提交改动先进 `commit_only` 提交轮（只 commit、不写 TAPD），随后进入 `awaiting_merge`。
8. 合并：用户确认后用原 Agent 在主仓库执行分支合并，并统一回写 TAPD；校验分支已并入当前 HEAD 后才 `succeeded`。原 Agent 不可用或主仓不干净时保持 `awaiting_merge`，展示错误与手动合并步骤。
9. 完成判定：进程退出、会话 hook 的结束事件、或输出静默达到「静默完成」阈值；不再依赖 MCP 任务回报。

并发由「Agent 执行」控制：Worktree 关闭时固定 1 个执行单元；开启时最多 `execution_units` 个（1–8，默认 2）任务并行。Worktree 关闭时存在 `awaiting_approval` 会阻塞单队列；Worktree 开启时 `awaiting_approval` / `awaiting_merge` / `merging` 都不会阻塞启动新任务，已在运行的任务继续。用户「停止并储藏」后还会持久化 `queue_paused`，重启也不会自动继续，直到手动「继续队列」。队列中只要还有任何非终态任务，Worktree 开关就锁定，执行单元仍可调整。

## 4. Agent tab

- 子页分「运行 / 待处理 / 历史」。运行显示 `queued / preparing / running / merging`；待处理同时显示 `awaiting_approval` 与 `awaiting_merge`；历史只显示终态任务。
- 头部显示任务标题、状态、项目/缺陷、工作目录（Worktree 开启时显示分支，完整路径放在 title）、队列/运行/待处理数量与退出码；有 hook 事件时额外显示运行时状态条（当前工具、最后消息、模型、子 Agent 数量）。
- 状态文案：`awaiting_merge` 显示「待合并」，`merging` 显示「合并中」；运行中时顶部胶囊显示具体运行时（如「Claude Code 修复中」）。待处理页、任务标题栏与顶部胶囊使用同一套文案，胶囊与标题栏同时展示待审核 / 待合并数量；悬停胶囊可查看缺陷摘要并直接「打开详情」。
- 运行时状态来自 hook：`working / waiting_permission / waiting_question / error / idle`，只保存在内存，通过 `agent://runtime` 推送；任务结束后清空。
- 操作：中断、打开导出目录、打开关联缺陷；右侧终端可直接接管键盘。
- 终端：PTY 输出只走实时通道（WebGL 渲染的 xterm），不写日志文件；面板中途打开时靠一次尺寸抖动让 TUI 整屏重绘。
- 权限确认：直接在右侧终端里操作；能力声明里 `externalDecision=false`，桌面不会代为回执。
- 改动审核：任务卡片展示 Agent 按提示词给出的改动摘要、涉及文件与风险点，以及 `git status` 安全网自动生成的信息；「查看改动」按需读取 `git diff`（只含已跟踪文件，最多 12 万字符）。三个选择：
  - **通过并提交**（非 Worktree）：任务重新入队，状态回到 `queued`，下一轮使用「审核已通过」提示词，只核对、提交并回写 TAPD，不重做修复。
  - **通过并进入合并**（Worktree）：有未提交改动时先回 `queued` 跑提交轮（只 commit）；否则直接进入 `awaiting_merge`。
  - **停止并储藏**：把本次涉及的文件（含未跟踪文件）`git stash` 到 `stash@…`，任务取消、队列暂停；之后可点「继续队列」手动恢复。
- 合并确认：`awaiting_merge` 卡片显示分支与主仓路径，说明「确认后会使用原 Agent 把分支合并到主仓库；合并成功才算完成」。操作为「用原 Agent 合并」「我已手动合并」「取消任务」；`merge.error` 红色展示，`merge.instructions` 用可滚动文本展示手动步骤。合并失败、原 Agent 不可用、主仓有未提交改动或同仓库已有合并时，任务保持 `awaiting_merge` 且不判失败。

## 5. 任务与历史

- SQLite：`cache.sqlite3` 是唯一任务存储。`agent_tasks` 只有 `id / payload / updated_at`，完整任务 JSON 在 `payload` 里；`agent_queue_state` 保存 `queue_paused`。状态变化只 upsert 变化的行。终态历史也 upsert 到同一张 `agent_tasks` 表，不另建历史表。
- 任务字段：`jsonPath` 指向导出的 `bug.json`；`source` 记录来源（`manual` 手动发起 / `notification` 通知卡处理），历史页据此展示「来源」；开启 Worktree 时另有 `worktreePath` 与 `worktreeBranch`。旧记录的 `mdPath` 不再读取，字段为空即可，不做迁移。
- 无日志：旧的 `agent-logs/` 会在启动时清掉。需要回看或继续时，历史里「打开系统终端」优先用 hook 捕获的 `sessionId` 精确恢复（Claude/Cursor/OMP 用 `--resume <id>`，OpenCode/Kimi 用 `--session <id>`，Codex 用 `resume <id>`，Gemini 用 `--resume <id>`）；没有 id 时退回各 CLI 的「继续最近会话」（`--continue`，Gemini 用 `--resume latest`）。
- 状态：`queued | preparing | running | awaiting_approval | awaiting_merge | merging | succeeded | failed | canceled`
- `queue_paused` 保存在 `agent_queue_state`：用户停止审核后即使重启客户端，队列也不会自动执行。
- 「历史」子页只展示终态任务，按项目 / 终态 / 关键词在服务端筛选并分页加载（每页 50 条）；查看错误、prompt、退出码、来源与运行时，可「打开系统终端」「重试」。「打开缺陷」只在右侧详情面板展开/切换该缺陷，不跳转项目缺陷列表。
- SQLite 读写失败时 Agent 页会显示存储错误横幅；任务变更先保留在内存并在下次写入时重试。
- 取消会 kill PTY 进程组；开放的其他子进程仍可能残留。

### 启动、关闭与恢复

任务状态、队列、审核 / 合并与恢复全部由 `crates/tapd-workflow` 的 `Workflow` 决定；`AgentCore` 只持有 `workflow: Mutex<Workflow>`，`AgentTask` 是 UI 与持久化的视图。宿主执行 crate 产出的 Effect（worktree、PTY、导出、git、SQLite、UI），再以 Input 回执事实；队列 / 审核 / 合并不再有宿主侧重复状态机。

- **启动加载**：`load()` 只加载 Agent 配置与安装检测缓存，不读任务、不启动队列。在登录有效且引导完成之前，工作流尚未进入系统，队列命令返回「工作流尚未初始化，请先进入系统」。
- **进入系统**：前端在登录有效 + 引导完成后调用 `agent_enter_system`（同一会话只请求一次，失败可重试）。后端走 `SystemEntered → LoadSnapshot → SnapshotLoaded`，从 SQLite 读取任务并应用恢复规则：
  - `queued` 保留并继续排队；关闭「启动恢复排队」后仍保留任务，但队列暂停，等用户手动继续。
  - `preparing` / `running` → `queued`，标记 `interrupted`，`attempt += 1`；默认自动重试，最多 3 次，超过上限 → `failed`（「客户端重启，自动重试次数已用尽」）。
  - `merging` → `awaiting_merge`，写入「客户端重启，合并已中止」与手动合并步骤。
  - `awaiting_approval` / `awaiting_merge` 保留，等待用户操作。
- **恢复提示**：后端返回 `RecoveryReport` 并 emit `agent://recovery`；主界面 header 下方的 `RecoveryBanner` 显示「已恢复 N 个任务」以及已重新排队 / 待审核 / 待合并 / 失败数量，可「查看任务」或「知道了」。空报告不展示，已关闭的报告在同一次会话内不重复弹出。
- **关闭**：`shutdown` 对工作流应用 `Suspend`：`preparing/running` 停靠为 `queued`（`interrupted=true`）、`merging` 停靠为 `awaiting_merge`；先把 `PersistChanged` / `PersistPaused` 同步写入 SQLite，**再杀 PTY**。未进入系统时直接跳过，避免覆盖持久化的队列暂停标记。运行中的任务不再默认失败；迟到的 `RunFinished` 因为任务已不是 `preparing/running` 被核心忽略。

## 6. Worktree 隔离

「Agent 执行」里的 Worktree 隔离开关默认关闭；关闭时执行单元固定为 1，所有任务串行使用项目主仓库，不出现合并阶段。开启后执行单元可调 1–8（默认 2），每个任务在独立 git worktree 中运行：

- 目录：`<数据目录>/worktrees/<ascii(workspace_id)>/<taskId>`。
- 分支：`tapd/<缺陷 ID 尾部 8 位>-<taskId 前 8 位>`（只保留 ASCII 字母数字，为空时用 `agent`），创建命令等价于 `git -C <主仓库> worktree add -b <分支> <目录> HEAD`。
- 任务的所有工作目录操作（PTY cwd、`git status` / `git diff`、stash、审核、系统终端、TAPD 写保护）都使用 `work_dir()`：有 `worktreePath` 时用它，否则用项目配置的 `repoPath`。`repoPath` 始终是创建 worktree 的主仓库。
- 产生改动的任务都要审核：简单任务在分支上 commit，复杂任务保留未提交改动；审核通过（必要时先跑只 commit 的提交轮）后进入 `awaiting_merge`。
- 合并由原 Agent 在主仓库执行，校验 `git merge-base --is-ancestor <branch> HEAD` 成功后才算完成；不以合并进程退出码为准。
- 合并成功后删除 worktree 目录但保留分支；失败、取消、待审核、待合并保留目录供排查。删除任务记录时清理 worktree；重试会清空旧路径并新建 worktree。
- 审核通过后的提交轮复用已有 worktree；若目录已被删除则任务失败，不会在 HEAD 上重建而丢掉待提交改动。
- 创建失败（非 git 仓库、无 HEAD、路径已存在等）会把任务标为失败，错误信息包含 git stderr。
- 队列中存在任何非终态任务时，Worktree 开关锁定；执行单元始终可调整。
- Worktree 任务的 `awaiting_approval` / `awaiting_merge` / `merging` 不会阻塞新任务，执行单元可以继续工作；非 Worktree 的 `awaiting_approval` 仍阻塞单队列。

## 7. TAPD 回写

回写时机取决于隔离方式。Worktree 关闭时沿用原语义；Worktree 开启时，修复与提交阶段都不写 TAPD，统一在合并成功后由合并 Agent 回写。

1. Worktree 关闭·简单任务：先 commit，再通过 MCP 追加评论并更新状态；可先调用 `tapd_get_bug_transitions` 查看允许的下一步。
2. Worktree 关闭·复杂任务：不 commit、不评论、不更新 TAPD；说明根因、方案、影响范围与风险后结束本轮。客户端的安全网把新出现的未提交文件置为 `awaiting_approval`，等用户「通过并提交」后用提交专用提示词重新入队。
3. Worktree 开启·修复轮：简单任务只 commit，复杂任务不 commit；两者都不评论、不改状态，结束时有改动进入 `awaiting_approval`。
4. Worktree 开启·提交轮：审核通过后如有未提交改动，用 worktree 提交模板只核对 diff、跑测试、commit，仍不回写 TAPD。
5. Worktree 开启·合并轮：合并 Agent 在主仓库合并分支、跑测试，成功后统一调用 `tapd_add_bug_comment` 评论并用 `tapd_update_bug_status` 更新状态。手动合并步骤也包含回写（见卡片上的 `merge.instructions`）。

客户端还会在 MCP 层做硬校验：当前缺陷对应的 Agent 任务仍在 `running` 且存在**本轮新产生**的未提交文件时，`tapd_add_bug_comment` / `tapd_update_bug_status` 会被拒绝，并返回“请先 git commit”；任务处于 `merging` 且分支尚未并入主仓 HEAD 时，写操作会被拒绝并提示先完成合并。任务开始前就存在的本地改动不计入，避免误伤。

MCP 提供：

- `tapd_get_bug_transitions`：读取当前状态与允许的下一步。
- `tapd_add_bug_comment`：追加「原因 / 方案 / 影响范围」评论。
- `tapd_update_bug_status`：把状态更新到目标（支持中文名或 key）；若不能直接到达，会先自动接受再流转。

不再提供审核暂停或任务回报工具：审核由客户端的安全网与待处理页完成，完成判定由进程退出、会话 hook 或输出静默完成。

## 8. 安全与边界

- 仓库路径由用户显式配置，客户端不会自动猜测项目路径。
- 简单改动由 agent 自行 commit（不 push）；复杂改动必须经用户审核。Worktree 开启时，所有产生改动的任务都要审核并合并回主仓库，合并前 TAPD 写接口会被客户端拒绝。
- 停止审核只会 `git stash` 本次涉及的文件；任务开始前就存在的其它改动不受影响。储藏信息记录在任务的 `approval.stash` 与错误信息里，可用 `git stash list` / `git stash pop` 找回。
- 权限确认由用户在右侧终端里自行完成，桌面不会自动批准。
- 输出按帧节拍（16ms）解码后推送，极端情况下批边界可能拆开多字节字符，下一批会补齐。

## 9. 人工验收

1. Agent 页 →「配置」：选择运行时，填可执行路径，点「检测版本」；为当前项目填仓库绝对路径；保存。同页「Agent 执行」确认 Worktree 默认关闭且执行单元显示 1。
2. 缺陷详情 →「用 Agent 修复」：提示加入队列并切到 Agent tab。
3. 观察状态 `queued → preparing → running`，TUI 出现后自动投递 prompt。
4. 再入队第二个缺陷：Worktree 关闭时显示排队；开启并调高执行单元后，两个任务应各自在独立 worktree 中并行。任一战果未结束时 Worktree 开关应禁用，执行单元仍可调整。
5. 通用 TUI：在右侧终端完成一次权限确认；确认桌面没有代为回执。
6. 让 agent 做一次复杂改动：它应不 commit、不改 TAPD，结束后任务自动进入「待审核」。非 Worktree 点「通过并提交」后重新入队并在提交后回写 TAPD；Worktree 点「通过并进入合并」后进入待合并，确认后用原 Agent 合并并回写 TAPD。点「停止并储藏」后确认 `git stash list` 有 `tapd-agent` 记录、任务进入历史、队列显示暂停。
7. Worktree 再跑一次简单改动：分支上应出现提交，任务进入「待审核」而不是直接成功；审核通过后进入「待合并」，合并成功后 worktree 目录删除、分支保留。
8. 手工验证写保护：任务未提交时调用 `tapd_update_bug_status` 应被拒绝并提示先 commit；任务处于合并中且分支尚未并入 HEAD 时，写操作应被拒绝并提示先完成合并。
9. 手工验证合并回退：让主仓留有未提交改动后点「用原 Agent 合并」，任务应保持「待合并」，展示 `merge.error` 与手动步骤（cd、git status、git merge、冲突解决、测试、TAPD 回写、回来点「我已手动合并」）；按步骤合并后点「我已手动合并」应成功。
10. 确认任务能在进程退出、会话 hook 结束事件或「静默完成」阈值后自动结束，不依赖任何 MCP 回报工具。
11. 开启 Worktree 后核对成功任务的分支保留、目录删除；失败 / 取消 / 待审核 / 待合并任务目录保留；删除任务记录会清理目录，重试会新建 worktree。历史子页确认退出码、「打开系统终端」（应打开 Terminal 并续接会话）与「打开缺陷」跳转；测试中断/重试与重启恢复（含待审核/待合并/队列暂停状态）。
12. 重启恢复：在 `running` 或 `preparing` 时退出客户端，确认再次登录并完成引导后任务回到队列而不是直接失败；主界面 header 下方出现恢复横幅，显示已重新排队 / 待审核 / 待合并 / 失败数量，点「查看任务」进入 Agent 页、点「知道了」关闭。连续中断超过 3 次的任务应显示失败并带「自动重试次数已用尽」。在登录页停留期间确认队列不会自行启动。

如需不依赖真实 CLI 做 PTY 冒烟测试，可将 binaryPath 临时指向 `fixtures/fake-agent.sh`（会打印 READY 并回显输入），测试完恢复。

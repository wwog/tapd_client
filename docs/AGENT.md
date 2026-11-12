# Agent 修复队列

把「处理缺陷」接到本机已安装的编码 Agent：导出 Markdown → 串行队列 → 在 PTY 中启动 Agent 的 TUI → 自动投递任务 → 输出直接渲染到右侧终端（不落盘，可随时键盘接管）；复杂改动通过 MCP 暂停等待审核。

支持的运行时由 `runtime_catalog()` 统一定义，新增 Agent 只需加一条描述符，不改队列与界面。

## 1. 运行时

| 运行时 | 启动命令 | 提示词投递 | MCP 自动注入 |
| --- | --- | --- | --- |
| OpenCode | `opencode` | 启动后写入终端 | 是 |
| Claude Code | `claude` | 随 argv 传入 | 是 |
| Codex | `codex` | 随 argv 传入 | 是 |
| Cursor Agent | `cursor-agent` | 随 argv 传入 | 是 |
| ZCode | `zcode` | 启动后写入终端 | 是 |
| Gemini CLI | `gemini -i <prompt>` | 随 flag 传入 | 需手动配置 |
| Qwen Code | `qwen` | 启动后写入终端 | 需手动配置 |
| GitHub Copilot | `copilot -i <prompt>` | 随 flag 传入 | 需手动配置 |
| Cline | `cline` | 启动后写入终端 | 需手动配置 |
| Aider | `aider` | 启动后写入终端 | 需手动配置 |
| Goose | `goose` | 启动后写入终端 | 需手动配置 |
| 自定义命令 | 用户填写 | 启动后写入终端 | 需手动配置 |

启动参数与注入方式参考 orca 的 TUI agent 适配表。命令可在设置中改成绝对路径；参数由描述符提供。

## 2. 配置

Agent 页 →「配置」（也可从 设置 →「默认 Agent」→「管理全部运行时」进入）：

| 配置 | 说明 |
| --- | --- |
| 运行时 | 从目录中选择一个作为默认运行时 |
| 可执行路径 | 默认取该运行时的命令；可填绝对路径 |
| prompt 模板 | 支持变量 `{{task_id}}`、`{{title}}`、`{{md_path}}`、`{{repo_path}}`、`{{workspace_name}}`、`{{bug_id}}`、`{{severity}}`、`{{priority}}`、`{{project_rule}}` |
| TUI 就绪静默 | 有输出后静默多久认为 TUI 就绪，默认 900ms |
| 就绪超时 | 最长等待，默认 15s；超时会强制注入并记录 warning |
| 静默完成 | 通用 TUI 未调用 `agent_task_report` 时，输出静默多久视为本轮结束，默认 180s；0 表示关闭 |

配置文件：`~/Library/Application Support/com.tapdclient.desktop/agent.json`。

每个 TAPD 项目在项目卡片里配置本地仓库路径与项目规则；缺失仓库时任务会失败并提示去配置。

## 3. 触发方式

- 缺陷详情 →「用 Agent 修复」。
- 通知窗口 →「处理」（完成改派/接受后触发 `agent://enqueue`）。

任务入队后：

1. 状态 `queued`，立即返回前端（提示“已加入队列”）。
2. `preparing`：调用导出，生成 `bug.md` + `assets/` + `bug.json`。
3. 校验仓库路径、运行时命令，并尝试把 tapd MCP 写入该客户端的用户级配置（支持 opencode / zcode / claude / cursor / codex / OMP / Kimi Code / Gemini CLI / Qwen Code；失败只记录 warning）。
4. `running`：在仓库目录用 PTY 启动运行时。
   - `argv` / `flag` 模式：提示词随启动命令传入。
   - `stdin` 模式：等待 TUI 就绪后，用括号粘贴写入提示词并回车。
5. 简单缺陷：Agent 直接 `git commit`，提交成功后再通过 MCP 评论并更新 TAPD，最后调用 `agent_task_report` 回报 `completed`。
6. 复杂缺陷：Agent 调用 `tapd_request_review`，桌面端把任务切到 `awaiting_approval` 并 kill TUI，工作区保留未提交的 diff；队列停在原地。
7. 安全网：即使模型忘了调用审核工具，只要本轮结束时有**新出现**的未提交文件（不含任务开始前就存在的本地改动），也会自动进入 `awaiting_approval`。
8. 兜底：`agent_task_report` 未调用时，输出静默达到「静默完成」阈值、或进程以 0 退出，也会结束本轮。

严格串行：同一时间只有一个任务占用 worker；`preparing/running` 都算运行态，后续任务排队。存在 `awaiting_approval` 时 worker 主动停住；用户「停止并储藏」后还会持久化 `queue_paused`，重启也不会自动继续，直到手动「继续队列」。并发数固定为 1 是刻意约束（同一仓库不接受多个 Agent 同时改写）。

## 4. Agent tab

- 子页分「运行 / 待审核 / 历史」。运行只显示 `queued / preparing / running`；待审核显示 `awaiting_approval`；历史只显示终态任务。
- 头部显示任务标题、状态、项目/缺陷、仓库路径、队列/运行/待审核数量与退出码。
- 操作：中断、打开导出目录、打开关联缺陷；右侧终端可直接接管键盘。
- 终端：PTY 输出只走实时通道（WebGL 渲染的 xterm），不写日志文件；面板中途打开时靠一次尺寸抖动让 TUI 整屏重绘。
- 权限确认：直接在右侧终端里操作；能力声明里 `externalDecision=false`，桌面不会代为回执。
- 改动审核：任务卡片展示 Agent 给出的改动摘要、涉及文件与风险点，以及 `git status` 安全网自动生成的信息；「查看改动」按需读取 `git diff HEAD`（只含已跟踪文件，最多 12 万字符）。两个选择：
  - **通过并提交**：任务重新入队，状态回到 `queued`，下一轮使用「审核已通过」提示词，只核对、提交并回写 TAPD，不重做修复。
  - **停止并储藏**：把本次涉及的文件（含未跟踪文件）`git stash` 到 `stash@…`，任务取消、队列暂停；之后可点「继续队列」手动恢复。

## 5. 任务与历史

- SQLite：`cache.sqlite3` 是唯一任务存储。`agent_tasks` 只有 `id / payload / updated_at`，完整任务 JSON 在 `payload` 里；`agent_queue_state` 保存 `queue_paused`。状态变化只 upsert 变化的行。
- 无日志：旧的 `agent-logs/` 会在启动时清掉。需要回看或继续时，历史里「打开系统终端」用运行时声明的 resume 参数（`opencode`/`claude`/`omp`/`kimi`/`qwen` 用 `--continue`，`codex` 用 `resume`，`gemini` 用 `--resume latest`）在系统终端里续接会话；OMP 的会话 hook 会记录 `sessionId`，有值时改用 `--resume <id>` 精确恢复。
- 状态：`queued | preparing | running | awaiting_approval | succeeded | failed | canceled`
- `queue_paused` 保存在 `agent_queue_state`：用户停止审核后即使重启客户端，队列也不会自动执行。
- 「历史」子页只展示终态任务，按项目 / 终态 / 关键词在服务端筛选并分页加载（每页 50 条）；查看错误、prompt、退出码与运行时，可「打开系统终端」「重试」。「打开缺陷」只在右侧详情面板展开/切换该缺陷，不跳转项目缺陷列表。
- 客户端重启时，遗留的 `preparing/running` 会标记为 failed（“客户端重启”）；`awaiting_approval` 保留，继续出现在待审核页；`queued` 任务在队列未暂停时继续执行。
- SQLite 读写失败时 Agent 页会显示存储错误横幅；任务变更先保留在内存并在下次写入时重试。
- 取消会 kill PTY 进程组；开放的其他子进程仍可能残留。

## 6. TAPD 回写

只有 `git commit` 成功后才会回写 TAPD。默认提示词把流程拆成两步：

1. 简单缺陷：先 commit，再通过 MCP 追加评论并更新状态，最后调用 `agent_task_report(status=completed)`。
2. 复杂缺陷：先调用 `tapd_request_review` 暂停，等用户「通过并提交」后重新入队，使用「审核已通过」提示词 commit，再回写 TAPD。

客户端还会在 MCP 层做硬校验：只要当前缺陷对应的 Agent 任务仍有**本轮新产生**的未提交文件，`tapd_add_bug_comment` / `tapd_update_bug_status` 会被拒绝，并返回“请先 git commit”。任务开始前就存在的本地改动不计入，避免误伤。

MCP 提供：

- `tapd_get_bug_transitions`：读取当前状态与允许的下一步。
- `tapd_add_bug_comment`：追加「原因 / 方案 / 影响范围」评论。
- `tapd_update_bug_status`：把状态更新到目标（支持中文名或 key）；若不能直接到达，会先自动接受再流转。
- `tapd_request_review`：暂停复杂改动并进入待审核（仅 Agent 任务使用）。
- `agent_task_report`：通用 TUI 运行时的生命周期回报（`completed` / `failed` / `needs_review` / `progress`）。

## 7. 外部 AI 占用

外部客户端用 `tapd_claim_bug` 登记占用后，缺陷进入「外部处理中」状态：

- 列表行显示处理方、创建时间与滚动用时，操作列只保留「取消」（释放占用）。
- 本地 Agent 正在运行 / 等权限 / 待审核时不接受外部占用，并通知用户接管被拒绝；本地只是排队时取消该排队任务，通知「“Zcode”接管了「标题」，队列中的 Agent 任务已取消」。
- 本地入队会直接拒绝被外部占用的缺陷；占用 15 分钟无心跳自动失效，外部 AI 处理期间需要重新调用 `tapd_claim_bug` 续约。
- 用户点「取消」释放占用后，外部 AI 下次心跳会收到冲突；它已经产生的代码改动不受影响。

写操作受 TAPD 工作流约束；非法流转会返回允许的下一步，agent 可据此调整。所有写操作都记录在客户端日志与 MCP 审计。

## 8. 安全与边界

- 仓库路径由用户显式配置，客户端不会自动猜测项目路径。
- 简单改动由 agent 自行 commit（不 push）；复杂改动必须经用户审核。未提交前 TAPD 写接口会被客户端拒绝。
- 停止审核只会 `git stash` 本次涉及的文件；任务开始前就存在的其它改动不受影响。储藏信息记录在任务的 `approval.stash` 与错误信息里，可用 `git stash list` / `git stash pop` 找回。
- 权限确认由用户在右侧终端里自行完成，桌面不会自动批准。
- 输出按帧节拍（16ms）解码后推送，极端情况下批边界可能拆开多字节字符，下一批会补齐。

## 9. 人工验收

1. Agent 页 →「配置」：选择运行时，填可执行路径，点「检测版本」；为当前项目填仓库绝对路径；保存。
2. 缺陷详情 →「用 Agent 修复」：提示加入队列并切到 Agent tab。
3. 观察状态 `queued → preparing → running`，TUI 出现后自动投递 prompt。
4. 再入队第二个缺陷：显示排队；第一个完成后自动启动。
5. 通用 TUI：在右侧终端完成一次权限确认；确认桌面没有代为回执。
6. 让 agent 做一次复杂改动：它应调用 `tapd_request_review` 并暂停，任务进入「待审核」。点「通过并提交」后重新入队并在提交后回写 TAPD；点「停止并储藏」后确认 `git stash list` 有 `tapd-agent` 记录、任务进入历史、队列显示暂停。
7. 手工验证写保护：在任务未提交时调用 `tapd_update_bug_status`，应被拒绝并提示先 commit。
8. 通用 TUI 完成后应调用 `agent_task_report`；不调用时等待「静默完成」阈值，确认任务能自动结束。
9. 历史子页确认退出码、「打开系统终端」（应打开 Terminal 并续接会话）与「打开缺陷」跳转；测试中断/重试与重启恢复（含待审核/队列暂停状态）。

如需不依赖真实 CLI 做 PTY 冒烟测试，可将 binaryPath 临时指向 `fixtures/fake-agent.sh`（会打印 READY 并回显输入），测试完恢复。

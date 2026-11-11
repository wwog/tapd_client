# Agent 修复队列

把「处理缺陷」接到 opencode：导出 Markdown → 串行队列 → PTY 中启动 opencode TUI → 自动注入修复任务 → 输出写入日志（可查看或在 Terminal 恢复会话）；同时通过私有 `opencode serve` 事件流判断完成与权限审核。

## 1. 配置

设置 → Agent：

| 配置 | 说明 |
| --- | --- |
| opencode 路径 | 默认 `opencode`（走 PATH），也可填绝对路径；「检测版本」会执行 `opencode --version` |
| 项目仓库映射 | 每个 TAPD 项目对应一个本地仓库绝对路径；缺失时任务会失败并提示去配置 |
| prompt 模板 | 支持变量 `{{task_id}}`、`{{title}}`、`{{md_path}}`、`{{repo_path}}`、`{{workspace_name}}`、`{{bug_id}}`、`{{severity}}`、`{{priority}}`、`{{project_rule}}`；默认模板区分简单/复杂改动，复杂时调用 `tapd_request_review` 等待人工审核 |
| TUI 就绪静默 | 有输出后静默多久认为 TUI 就绪，默认 900ms |
| 就绪超时 | 最长等待，默认 15s；超时会强制注入并记录 warning |

配置文件：`~/Library/Application Support/com.tapdclient.desktop/agent.json`。

自定义提示词若要主动走改动审核，需要保留 `{{task_id}}`，并在复杂改动的分支调用 `tapd_request_review`；即使没写，桌面端也会在本轮结束发现新的未提交文件时自动进入待审核。

启动任务前会幂等检查 opencode 全局配置是否包含 `tapd` MCP（与 MCP tab 的「一键导入 opencode」共用逻辑），失败只记录警告，不阻塞任务。

## 2. 触发方式

- 缺陷详情 →「用 Agent 修复」。
- 通知窗口 →「处理」（完成改派/接受后触发 `agent://enqueue`）。

任务入队后：

1. 状态 `queued`，立即返回前端（提示“已加入队列”）。
2. `preparing`：调用导出，生成 `bug.md` + `assets/` + `bug.json`。
3. 校验仓库路径（使用入队时已解析的 `repo_path`）、opencode 可执行文件，并确保 MCP 注入。
4. `running`：在仓库目录启动私有 `opencode serve`，再用 portable-pty 启动 `opencode --server http://127.0.0.1:<port>` TUI；Rust 订阅 server 的 `/event`。
5. 检测 TUI 就绪（输出静默或超时），写入渲染后的 prompt + 回车。
6. 简单缺陷：agent 直接 `git commit`，提交成功后再通过 MCP 评论并更新 TAPD；`session.idle`（注入后带 ~2s 宽限）→ `succeeded`。
7. 复杂缺陷：agent 调用 `tapd_request_review`（`taskId` 来自提示词），桌面端把任务切到 `awaiting_approval`，中止本轮并 kill TUI，工作区保留未提交的 diff；队列停在原地。
8. 安全网：即使模型忘了调用审核工具，只要本轮结束时有**新出现**的未提交文件（不含任务开始前就存在的本地改动），也会自动进入 `awaiting_approval`，避免改动被遗忘。
9. `session.execution.failed` → `failed`；若 server/SSE 不可用，回退为仅 TUI + 进程退出码语义（任务日志会记录降级原因）。

严格串行：同一时间只有一个任务占用 worker；`preparing/running/waiting_review` 都算运行态，后续任务排队。存在 `awaiting_approval` 时 worker 主动停住；用户「停止并储藏」后还会持久化 `queue_paused`，重启也不会自动继续，直到手动「继续队列」。并发数固定为 1 是刻意约束（同一仓库不接受多个 opencode 同时改写），不提供配置项。

## 3. Agent tab

- 子页分「运行 / 待审核 / 历史」。运行只显示 `queued / preparing / running / waiting_review`；待审核显示 `awaiting_approval`；历史只显示终态任务。
- 头部显示任务标题、状态、项目/缺陷、仓库路径、队列/运行/权限/待审核数量与退出码。
- 操作：中断、查看日志、终端恢复、打开导出目录、打开关联缺陷。
- 日志：PTY 的 IO 输出写入 `agent-logs/<taskId>.log`；「查看日志」用等宽 `<pre>` 展示，ANSI 清洗但保留换行。也可在 Terminal 中执行 `opencode -s <sessionId>` 恢复会话。
- 权限审核：opencode 发出权限请求时状态变为 `waiting_review`，面板上方出现「允许一次 / 总是允许 / 拒绝」，回复走 `POST /session/{id}/permissions/{pid}`；顶部胶囊同时变为「Agent 待审核」。
- 改动审核：任务卡片展示 Agent 给出的改动摘要、涉及文件与风险点，以及 `git status` 安全网自动生成的信息；「查看改动」按需读取 `git diff HEAD`（只含已跟踪文件，最多 12 万字符）。两个选择：
  - **通过并提交**：任务重新入队，状态回到 `queued`，下一轮使用「审核已通过」提示词，只核对、提交并回写 TAPD，不重做修复。
  - **停止并储藏**：把本次涉及的文件（含未跟踪文件）`git stash` 到 `stash@…`，任务取消、队列暂停；之后可点「继续队列」手动恢复。
- 有待审核任务时，队列不会自动推进；主窗口标题栏（更新图标旁）显示待审核数量，点击直达本页；顶部胶囊也会显示「Agent 待审核」。工作区未提交的 diff 在用户决定前一直保留。

## 4. 任务、历史与恢复

- SQLite：`cache.sqlite3` 是唯一任务存储。`agent_tasks` 只有 `id / payload / updated_at`，完整任务 JSON 在 `payload` 里；`agent_queue_state` 保存 `queue_paused`。状态变化只 upsert 变化的行。
- 日志：`agent-logs/`（TUI / 服务 / ACP 日志）、`agent-events/`（server 事件 JSONL，用于版本适配排障）；保留最近 200 个任务的产物，更早的自动清理。
- 状态：`queued | preparing | running | waiting_review | awaiting_approval | succeeded | failed | canceled`
- `queue_paused` 保存在 `agent_queue_state`：用户停止审核后即使重启客户端，队列也不会自动执行。
- 「历史」子页只展示终态任务，按项目 / 终态 / 关键词在服务端筛选并分页加载（每页 50 条）；查看错误、prompt、退出码、会话 ID，可「查看日志」「终端恢复」「重试」。「打开缺陷」只在右侧详情面板展开/切换该缺陷，不跳转项目缺陷列表。
- 客户端重启时，遗留的 `preparing/running/waiting_review` 会标记为 failed（“客户端重启”）；`awaiting_approval` 保留，继续出现在待审核页；`queued` 任务在队列未暂停时继续执行。
- 取消会先尝试 `POST /session/{id}/abort`，再 kill TUI + server 进程组；开放的其他子进程仍可能残留。

## 5. TAPD 回写

只有 `git commit` 成功后才会回写 TAPD。默认提示词把流程拆成两步：

1. 简单缺陷：先 commit，再通过 MCP 追加评论并更新状态。
2. 复杂缺陷：先调用 `tapd_request_review` 暂停，等用户「通过并提交」后重新入队，使用「审核已通过」提示词 commit，再回写 TAPD。

客户端还会在 MCP 层做硬校验：只要当前缺陷对应的 Agent 任务仍有**本轮新产生**的未提交文件，`tapd_add_bug_comment` / `tapd_update_bug_status` 会被拒绝，并返回“请先 git commit”。任务开始前就存在的本地改动不计入，避免误伤。

MCP 提供：

- `tapd_get_bug_transitions`：读取当前状态与允许的下一步。
- `tapd_add_bug_comment`：追加「原因 / 方案 / 影响范围」评论。
- `tapd_update_bug_status`：把状态更新到目标（支持中文名或 key）；若不能直接到达，会先自动接受再流转。
- `tapd_request_review`：暂停复杂改动并进入待审核（仅 Agent 任务使用）。
- `tapd_get_bug_prompt`：按缺陷 id 返回同一套模板渲染的修复提示词；外部客户端默认用不含审核队列的 MCP 模板，`kind: "agent"` 返回这里配置的全局模板原文。

上面配置的「本地文件夹」也会被 MCP 复用：外部 AI 传 `root`（或 sidecar 自动填入自己的 cwd）时，客户端按仓库目录反查 TAPD 项目。

### 5.1 外部 AI 占用

外部客户端用 `tapd_claim_bug` 登记占用后，缺陷进入「外部处理中」状态：

- 列表行显示处理方、创建时间与滚动用时，操作列只保留「取消」（释放占用）。
- 本地 Agent 正在运行 / 等权限 / 待审核时不接受外部占用，并通知用户接管被拒绝；本地只是排队时取消该排队任务，通知「“Zcode”接管了「标题」，队列中的 Agent 任务已取消」。
- 本地入队会直接拒绝被外部占用的缺陷；占用 15 分钟无心跳自动失效，外部 AI 处理期间需要重新调用 `tapd_claim_bug` 续约。
- 用户点「取消」释放占用后，外部 AI 下次心跳会收到冲突；它已经产生的代码改动不受影响。

写操作受 TAPD 工作流约束；非法流转会返回允许的下一步，agent 可据此调整。所有写操作都记录在客户端日志与 MCP 审计。

## 6. 安全与边界

- 仓库路径由用户显式配置，客户端不会自动猜测项目路径。
- 简单改动由 agent 自行 commit（不 push）；复杂改动必须经用户审核。未提交前 TAPD 写接口会被客户端拒绝。
- 停止审核只会 `git stash` 本次涉及的文件；任务开始前就存在的其它改动不受影响。储藏信息记录在任务的 `approval.stash` 与错误信息里，可用 `git stash list` / `git stash pop` 找回。
- 权限确认由用户在 Agent tab / 胶囊里决定，不会自动批准。
- 输出按批解码，极端情况下批边界可能拆开多字节字符；日志文件保存原始字节，不受影响。

## 7. 人工验收

1. 设置 → Agent：填 `opencode`，点「检测版本」；为当前项目填仓库绝对路径；保存。
2. 缺陷详情 →「用 Agent 修复」：提示加入队列并切到 Agent tab。
3. 观察状态 `queued → preparing → running`，TUI 出现后自动提交 prompt。
4. 再入队第二个缺陷：显示排队；第一个完成（server idle）后自动启动，而不是等终端退出。
5. 在 `opencode` 中触发一次需要批准的操作（如 `permissions` 配置为 `ask`）：胶囊显示「Agent 待审核」，在 tab 里允许/拒绝后任务继续。
6. 让 agent 做一次复杂改动：它应调用 `tapd_request_review` 并暂停，任务进入「待审核」，标题栏出现数量角标。点「通过并提交」后任务重新入队并在提交后回写 TAPD；点「停止并储藏」后确认 `git stash list` 有 `tapd-agent` 记录、任务进入历史、队列显示暂停，点「继续队列」恢复。
7. 手工验证写保护：在任务未提交时调用 `tapd_update_bug_status`（或在运行中的 Agent 里触发），应被拒绝并提示先 commit。
8. 历史子页确认日志、退出码与「打开缺陷」跳转；测试中断/重试与重启恢复（含待审核/队列暂停状态）。

如需不依赖 opencode 做 PTY 冒烟测试，可将 binaryPath 临时指向 `fixtures/fake-agent.sh`（会打印 READY 并回显输入），测试完恢复为 opencode。

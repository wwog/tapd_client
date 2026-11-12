# 多 Agent 接入方案

> 目标：Agent 修复队列不再绑定 opencode，可以接入本机任意编码 Agent 的 TUI，并保持权限确认、改动审核与 TAPD 回写可用。

## 1. 结论

**采用 orca 的 TUI 适配路线，不引入 ACP。**

原因：

- ACP 只覆盖少数提供适配器的 Agent，适配器本身还需要 Node、登录态和版本对齐，覆盖面远小于"能在终端跑的 CLI"。
- ACP 模式没有交互式 TUI，用户无法接管 Agent 的权限菜单和会话。
- 本项目已经有 PTY、xterm 内嵌终端、提示词注入、日志与进程组回收，通用 TUI 是成本最低的扩展方式。
- 任务生命周期由进程退出、会话 hook 与输出静默判定，不依赖 MCP 回报或协议层。

orca 的通用做法是一张运行时适配表：`detectCmd` + `launchCmd` + `promptInjectionMode` + 就绪/提交信号。本项目采用同样的结构，但把"完成判定"收敛到进程退出、会话 hook 与输出静默兜底，避免维护各 Agent 的屏幕标记。

## 2. 运行时适配表

| 运行时 | 命令 | 提示词投递 | MCP 自动注入 |
| --- | --- | --- | --- |
| OpenCode | `opencode` | stdin | 是 |
| Claude Code | `claude` | argv | 是 |
| Codex | `codex` | argv | 是 |
| Cursor Agent | `cursor-agent` | argv | 是 |
| ZCode | `zcode` | stdin | 是 |
| Gemini CLI | `gemini` | flag `-i` | 是 |
| Qwen Code | `qwen` | stdin | 是 |
| GitHub Copilot | `copilot` | flag `-i` | 手动 |
| Cline / Aider / Goose / Amp | 同名命令 | stdin | 手动 |
| Antigravity | `agy` | stdin | 手动 |
| Auggie | `auggie` | stdin | 手动 |
| Autohand | `autohand` | stdin | 手动 |
| CodeBuddy | `codebuddy`（别名 `cbc`） | argv | 手动 |
| Codebuff / Freebuff | 同名命令 | stdin | 手动 |
| Command Code | `command-code --trust` | stdin | 手动 |
| Continue | `cn` | stdin | 手动 |
| Charm | `crush` | stdin | 手动 |
| Devin | `devin -- <提示词>` | argv | 手动 |
| Droid | `droid` | argv | 手动 |
| Grok | `grok -- <提示词>` | argv | 手动 |
| Hermes | `hermes --tui` | stdin | 手动 |
| Jcode | `jcode` | stdin | 手动 |
| Kilocode | `kilo` | stdin | 手动 |
| Kimi | `kimi`（别名 `kimi-code`） | stdin | 是 |
| Kiro | `kiro-cli chat --tui` | stdin | 手动 |
| MiMo Code | `mimo` | stdin | 手动 |
| Mistral Vibe | `vibe`（别名 `mistral-vibe`） | stdin | 手动 |
| Muse | `muse --trust-workspace` | stdin | 手动 |
| OMP | `omp` | argv | 是 |
| OpenClaude | `openclaude` | argv | 手动 |
| OpenClaw | `openclaw` | stdin | 手动 |
| OpenCode 2 | `opencode2 --standalone` | stdin | 手动 |
| Pi | `pi` | argv | 手动 |
| Prime Agent | `prime-agent -- <提示词>` | argv | 手动 |
| Qoder CLI | `qodercli`（别名 `qoder`） | stdin | 手动 |
| Qoder CLI China | `qoderclicn`（别名 `qodercn`） | stdin | 手动 |
| Rovo Dev | `acli rovodev run` | stdin | 手动 |
| Trae | `traecli -- <提示词>` | argv | 手动 |
| DeepSeek Harness | `dsh-tui .`（别名 `dst`） | stdin | 手动 |
| 自定义命令 | 用户填写 | stdin | 手动 |

`argv` / `flag` 模式把提示词直接放进启动命令（声明了终止符的运行时会在提示词前补 `--`），避免 TUI 就绪竞态；`stdin` 模式等待输出静默后用括号粘贴写入并回车。目录对齐 orca 的 TUI agent 表，仅去掉其私有的 `claude-teams` 包装（依赖 orca 自己的 CLI）。

## 2.1 本机安装检测

- `agent_scan.rs` 在用户 shell 的 `PATH` 里查找每个运行时的 `binary` 与别名，命中后跑一次 `--version` 取首行。
- 结果写入应用数据目录的 `agent-scan.json`（`checkedAt` + 每个运行时的 `resolvedPath` / `version` / `found`）。
- 启动时缓存超过 24 小时才自动扫描一次；设置页「刷新检测」和 Agent 配置页的刷新按钮会强制重扫。
- 设置页「默认 Agent」用一个下拉框选择（已检测到的排前面并带版本，未检测到的标注「未检测到」）；全部运行时的列表、参数与互通说明在 Agent 页 →「配置」里，入口是「管理全部运行时」。

## 3. 数据模型

```rust
enum PromptInjection { Argv, Flag, Stdin }

struct AgentRuntimeDescriptor {
    id, name, vendor, description,
    binary: &'static str,
    aliases: Vec<&'static str>,      // 仅用于安装检测
    args: Vec<&'static str>,
    prompt_injection: PromptInjection,
    prompt_flag: Option<&'static str>,
    argv_separator: Option<&'static str>, // argv 模式下的 `--`
    capabilities: AgentRuntimeCapabilities,
    lifecycle: Vec<AgentLifecycleStage>,
    limitations: Vec<&'static str>,
    fallback: &'static str,
}
```

任务入队时固化 `runtime_id`，之后修改设置不影响已排队任务。缺陷详情的提交面板可以只给本次任务指定 `runtimeId`；未指定时使用设置里的默认 Agent。

`AgentTask` 的详情文件字段是 `jsonPath`（`bug.json` 绝对路径）；`source` 记录来源（`manual` / `notification`），历史页展示与恢复。开启 Worktree 隔离时另有 `worktreePath` / `worktreeBranch`；`repoPath` 仍是项目主仓库，所有运行时工作目录取 `work_dir()`（优先 worktree）。旧记录的 `mdPath` 不迁移，读为空。

`crates/tapd-workflow` 的 `Task` 与这份 JSON 形状对齐：camelCase、`TaskSpec` 平铺、`TaskId` 为 transparent 字符串 newtype、时间戳为字符串；`agent/workflow_bridge.rs` 直接做 serde JSON 往返。

配置只有一个 `binaryPath`（默认运行时的命令）与全局提示词模板；切换默认运行时时自动回填该运行时的默认命令。任务运行时不是默认运行时，优先用检测到的绝对路径，其次用描述符里的默认命令。

## 4. 启动链路

```
run_task
  ├─ 导出 bug.json / assets
  ├─ 校验主仓库
  ├─ 按需创建 / 复用 worktree，确定 work_dir
  ├─ 解析命令并确保 tapd MCP 已写入客户端配置
  ├─ 安装/刷新会话 hook，下发任务级 hook token
  ├─ 渲染提示词（task_id / json_path / coworker / ...）
  └─ 通用 PTY（cwd = work_dir）
        ├─ argv/flag：提示词随启动命令传入
        ├─ stdin：就绪后括号粘贴 + 回车
        ├─ 等待进程退出 / 会话 hook / 输出静默
        └─ kill 进程组，进入完成、待审核或待合并
```

状态迁移由 `tapd-workflow` 的 Effect 驱动，上面的步骤只是宿主执行的副作用；每一步完成后以 Input 回执（worktree 创建、导出、AgentStarted、RunFinished 等），由核心决定下一步。

## 5. 完成判定

运行时没有统一协议事件，按以下顺序判定本轮结束：

1. 进程退出：主信号。
2. 会话 hook：启动时给运行时挂原生 hook，事件 POST 到桌面端 loopback `/agent/hook`。
   - OMP：`--extension` 临时扩展，上报会话、提示词、工具、回合与 `agent_settled`。
   - OpenCode：全局 `plugins/tapd-session-monitor.js`，上报会话、提示词、工具、权限、提问、错误与 `session.idle`。
   - Codex：`~/.codex/hooks.json` + `config.toml` 信任哈希，上报会话、提示词、工具、权限、子 Agent 与 `Stop` / `Interrupt`。
   - Claude / OpenClaude：`settings.json` 的 `SessionStart` / `UserPromptSubmit` / `Stop` / `StopFailure` / `SubagentStart` / `SubagentStop` / `PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `PermissionRequest` / `Notification` / `PostCompact` / `SessionEnd`。
   - Qwen / Qoder / Qoder CN / CodeBuddy：同一结构下的 Qwen 官方事件枚举。
   - Cursor：`~/.cursor/hooks.json` 的 `afterAgentResponse` / `postToolUse` / `postToolUseFailure` / `stop`。
   - Gemini CLI：`~/.gemini/settings.json` 的 `BeforeAgent` / `AfterAgent` / `BeforeTool` / `AfterTool`。
   - Kimi Code：`~/.kimi-code/config.toml` 的会话、提示词、工具、权限与 Stop 事件。
   - ZCode：`~/.zcode/cli/config.json` 的 `hooks.events`，会话、提示词、工具、权限与 Stop。
   桌面端在 `agent_end` 且没有后续工作时结束本轮，同时把 hook 捕获的 `sessionId` 持久化到任务里，供「打开系统终端」精确 `--resume <id>`（TUI 持续重绘时静默判断不会触发）。
3. 提示词已投递且输出静默达到 `idleCompleteMs`（默认 180s）：视为完成并记录 warning。
4. 用户中断：任务取消。

复杂改动不再调用 MCP 审核工具：Agent 按提示词不 commit、不评论、不更新 TAPD。本轮结束的 `RunFinished` 带回改动事实，工作流的安全网发现本轮新的未提交文件时，把任务置为 `awaiting_approval` 并保留工作区 diff。

开启 Worktree 隔离后，审核与合并成为所有改动的必经阶段：

- 简单任务在任务分支上 commit，复杂任务保留未提交改动；只要产生改动就进入 `awaiting_approval`，无改动直接成功。
- 审核通过时若仍有未提交改动，先回 `queued` 跑只 commit 的提交轮（不写 TAPD）；否则直接进入 `awaiting_merge`。
- 用户确认后，用原 Agent（同一 `runtime_id`）在主仓库执行合并，并统一回写 TAPD。校验以 `git merge-base --is-ancestor <branch> HEAD` 为准，不以合并进程退出码为准。
- 原 Agent 不可用、主仓有未提交改动、同仓库已有合并或合并未通过校验时，任务保持 `awaiting_merge`，写入 `merge.error` 与手动步骤；用户手动合并后点「我已手动合并」走同一校验。
- Worktree 任务在 `awaiting_approval` / `awaiting_merge` / `merging` 期间不阻塞新任务；非 Worktree 的 `awaiting_approval` 仍阻塞单队列。

## 5.1 工作流核心与启动恢复

任务模型、状态机、执行单元调度、审核 / 合并策略、恢复与历史都在 `crates/tapd-workflow`（sans-IO，正常依赖只有 `serde`，`#![forbid(unsafe_code)]`，92 个测试）。桌面端已完整接入：`AgentCore` 只持有 `workflow: Mutex<Workflow>`，`AgentTask` 只是 UI 与持久化视图。

- 桌面 `AgentTask` 与 crate `Task` 的 JSON 形状一致，`agent/workflow_bridge.rs` 用 `serde_json` 整条往返，不手写字段映射。
- 宿主执行 Effect（worktree / PTY / 导出 / git / SQLite / UI）并以 Input 回执；approve 的 `InspectWorkspace`、merge_start 的 `CheckMergePreconditions`、verify_merge 的 `VerifyBranchMerged` 在命令路径同步执行，保证命令返回最终状态。
- 启动 `load()` 只加载配置，不读任务、不启动队列；登录有效 + 引导完成后前端调用 `agent_enter_system` 才走 `SystemEntered → LoadSnapshot → SnapshotLoaded` 恢复任务。
- 恢复规则：`queued` 保留（关闭「启动恢复排队」时保留但暂停队列）；`preparing/running` → `queued` + `interrupted` + `attempt+1`（默认最多 3 次自动重试，超限失败）；`merging` → `awaiting_merge` + 「客户端重启，合并已中止」；`awaiting_approval` / `awaiting_merge` 保留。结果通过 `RecoveryReport` 返回并 emit `agent://recovery`，主界面 `RecoveryBanner` 展示数量。
- 关闭 `shutdown` 应用 `Suspend`：`preparing/running → queued`、`merging → awaiting_merge`，`PersistChanged` / `PersistPaused` 同步写入后才杀 PTY；未进入系统时跳过。迟到的 `RunFinished` 因任务已不是 `preparing/running` 被核心忽略。
- 队列出队、执行单元、审核阻塞、审核 / 合并决策全部由 crate 的 `schedule()` 与状态机决定；宿主没有第二份实现。Worktree 开关锁、合并提示词与手动步骤也直接复用 crate 的纯函数。

## 6. 权限与交互

- 权限菜单直接显示在右侧 xterm 中，由用户操作；能力声明 `externalDecision=false`，桌面不代为回执。
- 所有运行时都可以在右侧终端接管键盘输入。

## 7. MCP 注入与会话 hook

- 支持自动注入：opencode / zcode / claude / cursor / codex / OMP / Kimi Code / Gemini CLI / Qwen Code，复用 `mcp_import`。
- 其他运行时：启动时跳过注入，管理页的能力/限制中明确提示"需手动配置 tapd MCP"。
- 未注入 MCP 时，Agent 仍可改代码并提交，但无法回写 TAPD；任务完成仍由进程退出、hook 或输出静默判定。

会话 hook 走桌面端 loopback，和 MCP 共用同一个 HTTP 服务：

- `agent/hooks.rs` 生成共享脚本 `agent-hooks/tapd-agent-hook.sh`，命令形如 `… tapd-agent-hook.sh agent_end`。
- 客户端执行 hook 时，脚本把 stdin 原样作为 `payload`，用 `curl` POST 到 `http://127.0.0.1:<port>/agent/hook`。
- 每次任务随机生成 hook token，通过 `TAPD_AGENT_HOOK_URL` / `TAPD_AGENT_HOOK_TOKEN` / `TAPD_AGENT_TASK_ID` 注入 PTY 环境；hook 请求用 `X-Tapd-Hook-Token` 鉴权，和主 API 的 bearer token 隔离。
- 桌面端校验 token 与任务后，把 `sessionId` 直接写回任务，并把事件放进内存队列；PTY 线程消费事件后结束本轮。事件不落盘。
- 事件同时会归一化成运行时状态（`idle / working / waiting_permission / waiting_question / error`），通过 `agent://runtime` 推送；任务头显示当前工具、最后消息、模型与子 Agent 数量。
- Agent 页任务头部的状态条是临时状态，不写入 SQLite；任务结束后清空。
- hook 在非本应用启动的会话里没有这些环境变量，脚本直接空操作；配置只写一次，后续启动按内容判断是否更新。
- 写入客户端配置前会先备份为 `*.bak-tapd-*`，解析失败的原文件不会被覆盖。
- Codex 会在 `config.toml` 写入 `[hooks.state."<hooks.json>:<event>:<group>:0"]` 信任哈希，和 `hooks.json` 一起幂等更新；版本过旧、不识别 hook 时退回进程退出 / 静默兜底。

## 8. 新增一个 Agent

1. 在 `runtime_catalog()` 加一条 `tui_runtime(...)`：
   - `binary`：可执行命令。
   - `args`：固定启动参数（子命令、跳过信任提示等）。
   - `prompt_injection`：该 CLI 支持的最稳投递方式。
   - `prompt_flag`：flag 模式必填。
   - `mcp_auto`：是否已有 MCP 注入适配。
   - 需要检测别名或 `--` 终止符时改用 `tui_runtime_with(...)` 并传 `TuiRuntimeExtra`。
   - 需要会话 hook 时在 `TuiRuntimeExtra` 里设置 `session_hook: SessionHookKind`，并在 `agent/hooks.rs` 增加对应的安装器。
2. 如果该客户端需要自动注入 MCP，在 `mcp_import` 补一条客户端映射，并在 `mcp_client_for_runtime` 里加上 runtime id。
3. 安装检测自动覆盖新条目（`binary` + `aliases`），不需要改 `agent_scan.rs`。
4. 不需要改队列、UI 或完成判定。

## 9. 已知限制

- `stdin` 模式的就绪检测是启发式的：TUI 输出慢或一直动画时，可能等到超时才注入。
- 各 TUI 对括号粘贴的支持不完全一致；不支持时提示词可能以普通输入写入。
- 首次启动的信任目录菜单可能吞掉提示词；需要在终端里先处理一次。
- 通用 TUI 无法把权限请求结构化到桌面，只能在终端确认。
- 当前 hook 只做「观察 + 状态展示」，不代替用户在终端里回执权限；结构化权限回执是后续阶段。
- 会话 hook 会写客户端的用户级配置（settings.json / hooks.json / config.toml / plugins）；脚本在没有任务环境变量时为空操作。
- 部分客户端的 hook 事件/字段可能随版本变化；失败只记录 warning，任务退回进程退出 / 静默兜底。
- `--version` 不保证所有 CLI 都很快返回；检测有 5 秒超时，超时的条目会记录错误但仍视为已安装。
- 默认单任务串行；开启 Worktree 隔离后按执行单元并行（1–8，默认 2），每个任务一个 worktree。非 git 仓库的任务会在创建 worktree 时明确失败。
- Worktree 任务必须审核并合并回主仓库才算完成；合并失败不会把任务判为失败，而是保留待合并并提供手动步骤。队列有未结束任务时 Worktree 开关锁定，执行单元仍可调整。
- 任务状态、队列、审核 / 合并与恢复只有 `tapd-workflow` 一份实现；宿主只提供 PTY、git、导出、SQLite 与 UI 适配器，不保留第二份状态机。

## 10. 与 orca 的差异

| 方面 | orca | 本项目 |
| --- | --- | --- |
| 接入方式 | TUI 适配表 + 各 Agent hook | TUI 适配表 + 各 Agent hook |
| 事件通道 | hook POST 到本地 hook server | hook POST 到桌面端 loopback `/agent/hook` |
| 完成判定 | hook 事件 + 屏幕标记 | 进程退出 + hook 事件 + 静默兜底 |
| 权限 | 各 Agent hook / 终端 | 统一在终端确认 |
| 隔离 | 每任务 worktree | 默认串行；开启 Worktree 后每任务独立 worktree，审核通过后合并回主仓 |
| 范围 | 桌面全功能编排 | TAPD 缺陷修复队列 |

# 多 Agent 接入方案

> 目标：Agent 修复队列不再绑定 opencode，可以接入本机任意编码 Agent 的 TUI，并保持权限确认、改动审核与 TAPD 回写可用。

## 1. 结论

**采用 orca 的 TUI 适配路线，不引入 ACP。**

原因：

- ACP 只覆盖少数提供适配器的 Agent，适配器本身还需要 Node、登录态和版本对齐，覆盖面远小于"能在终端跑的 CLI"。
- ACP 模式没有交互式 TUI，用户无法接管 Agent 的权限菜单和会话。
- 本项目已经有 PTY、xterm 内嵌终端、提示词注入、日志与进程组回收，通用 TUI 是成本最低的扩展方式。
- 任务生命周期已经由 MCP 工具 `agent_task_report` 承接，不依赖协议层。

orca 的通用做法是一张运行时适配表：`detectCmd` + `launchCmd` + `promptInjectionMode` + 就绪/提交信号。本项目采用同样的结构，但把"完成判定"收敛到 MCP 回报，避免维护各 Agent 的屏幕标记。

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

配置只有一个 `binaryPath`（默认运行时的命令）与全局提示词模板；切换默认运行时时自动回填该运行时的默认命令。任务运行时不是默认运行时，优先用检测到的绝对路径，其次用描述符里的默认命令。

## 4. 启动链路

```
run_task
  ├─ 导出 bug.md / assets
  ├─ 校验 repo_path
  ├─ 解析命令并确保 tapd MCP 已写入客户端配置
  ├─ 渲染提示词（task_id / project_rule / ...）
  └─ 通用 PTY
        ├─ argv/flag：提示词随启动命令传入
        ├─ stdin：就绪后括号粘贴 + 回车
        ├─ 等待 agent_task_report / 进程退出 / 输出静默
        └─ kill 进程组，进入完成或待审核
```

## 5. 完成判定

运行时没有协议事件，按以下顺序判定本轮结束：

1. Agent 调用 `agent_task_report(status=completed|failed|needs_review)`：主路径。
2. 进程以 0 退出：视为完成。
3. OMP：启动时通过 `--extension` 临时挂载会话监控 hook，监听 `session_start` / `agent_start` / `turn_end` / `agent_end`；`agent_end` 且没有后续工作时结束本轮，同时把 `sessionId` 持久化到任务里，供「打开系统终端」精确 `--resume <id>`（TUI 持续重绘时静默判断不会触发）。
4. 提示词已投递且输出静默达到 `idleCompleteMs`（默认 180s）：视为完成并记录 warning。
5. 用户中断：任务取消。

复杂改动仍走 `tapd_request_review`：桌面收到 MCP 调用后把任务切到 `awaiting_approval` 并 kill TUI，工作区保留 diff。即使 Agent 忘记调用，`finish_task` 的 git 安全网也会在发现新的未提交文件时进入待审核。

## 6. 权限与交互

- 权限菜单直接显示在右侧 xterm 中，由用户操作；能力声明 `externalDecision=false`，桌面不代为回执。
- 所有运行时都可以在右侧终端接管键盘输入。

## 7. MCP 注入

- 支持自动注入：opencode / zcode / claude / cursor / codex / OMP / Kimi Code / Gemini CLI / Qwen Code，复用 `mcp_import`。
- 其他运行时：启动时跳过注入，管理页的能力/限制中明确提示"需手动配置 tapd MCP"。
- 未注入 MCP 时，Agent 仍可改代码并提交，但无法回写 TAPD，也无法调用 `agent_task_report`（依赖静默完成兜底）。

## 8. 新增一个 Agent

1. 在 `runtime_catalog()` 加一条 `tui_runtime(...)`：
   - `binary`：可执行命令。
   - `args`：固定启动参数（子命令、跳过信任提示等）。
   - `prompt_injection`：该 CLI 支持的最稳投递方式。
   - `prompt_flag`：flag 模式必填。
   - `mcp_auto`：是否已有 MCP 注入适配。
   - 需要检测别名或 `--` 终止符时改用 `tui_runtime_with(...)` 并传 `TuiRuntimeExtra`。
2. 如果该客户端需要自动注入 MCP，在 `mcp_import` 补一条客户端映射，并在 `mcp_client_for_runtime` 里加上 runtime id。
3. 安装检测自动覆盖新条目（`binary` + `aliases`），不需要改 `agent_scan.rs`。
4. 不需要改队列、UI 或完成判定。

## 9. 已知限制

- `stdin` 模式的就绪检测是启发式的：TUI 输出慢或一直动画时，可能等到超时才注入。
- 各 TUI 对括号粘贴的支持不完全一致；不支持时提示词可能以普通输入写入。
- 首次启动的信任目录菜单可能吞掉提示词；需要在终端里先处理一次。
- 通用 TUI 无法把权限请求结构化到桌面，只能在终端确认。
- `--version` 不保证所有 CLI 都很快返回；检测有 5 秒超时，超时的条目会记录错误但仍视为已安装。
- 并发仍固定为 1；worktree 并行是后续独立阶段。

## 10. 与 orca 的差异

| 方面 | orca | 本项目 |
| --- | --- | --- |
| 接入方式 | TUI 适配表 + 各 Agent hook | TUI 适配表 + MCP 生命周期回报 |
| 完成判定 | hook 事件 + 屏幕标记 | `agent_task_report` + 进程退出 + 静默兜底 |
| 权限 | 各 Agent hook / 终端 | 统一在终端确认 |
| 隔离 | 每任务 worktree | 单仓库串行 |
| 范围 | 桌面全功能编排 | TAPD 缺陷修复队列 |

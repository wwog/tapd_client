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

| 运行时 | 命令 | 提示词投递 | 适配方式 | MCP 自动注入 |
| --- | --- | --- | --- | --- |
| OpenCode | `opencode` | stdin | 通用 TUI | 是 |
| Claude Code | `claude` | argv | 通用 TUI | 是 |
| Codex | `codex` | argv | 通用 TUI | 是 |
| Cursor Agent | `cursor-agent` | argv | 通用 TUI | 是 |
| ZCode | `zcode` | stdin | 通用 TUI | 是 |
| Gemini CLI | `gemini` | flag `-i` | 通用 TUI | 手动 |
| Qwen Code | `qwen` | stdin | 通用 TUI | 手动 |
| GitHub Copilot | `copilot` | flag `-i` | 通用 TUI | 手动 |
| Cline | `cline` | stdin | 通用 TUI | 手动 |
| Aider | `aider` | stdin | 通用 TUI | 手动 |
| Goose | `goose` | stdin | 通用 TUI | 手动 |
| 自定义命令 | 用户填写 | stdin | 通用 TUI | 手动 |

`argv` / `flag` 模式把提示词直接放进启动命令，避免 TUI 就绪竞态；`stdin` 模式等待输出静默后用括号粘贴写入并回车。

## 3. 数据模型

```rust
enum PromptInjection { Argv, Flag, Stdin }

struct AgentRuntimeDescriptor {
    id, name, vendor, description,
    binary: &'static str,
    args: Vec<&'static str>,
    prompt_injection: PromptInjection,
    prompt_flag: Option<&'static str>,
    capabilities: AgentRuntimeCapabilities,
    lifecycle: Vec<AgentLifecycleStage>,
    limitations: Vec<&'static str>,
    fallback: &'static str,
}
```

任务入队时固化 `runtime_id`，之后修改设置不影响已排队任务。

配置只有一个 `binaryPath`（当前运行时的命令）与全局提示词模板；切换运行时时自动回填该运行时的默认命令。

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
3. 提示词已投递且输出静默达到 `idleCompleteMs`（默认 180s）：视为完成并记录 warning。
4. 用户中断：任务取消。

复杂改动仍走 `tapd_request_review`：桌面收到 MCP 调用后把任务切到 `awaiting_approval` 并 kill TUI，工作区保留 diff。即使 Agent 忘记调用，`finish_task` 的 git 安全网也会在发现新的未提交文件时进入待审核。

## 6. 权限与交互

- 权限菜单直接显示在右侧 xterm 中，由用户操作；能力声明 `externalDecision=false`，桌面不代为回执。
- 所有运行时都可以在右侧终端接管键盘输入。

## 7. MCP 注入

- 支持自动注入：opencode / zcode / claude / cursor / codex，复用 `mcp_import`。
- 其他运行时：启动时跳过注入，管理页的能力/限制中明确提示"需手动配置 tapd MCP"。
- 未注入 MCP 时，Agent 仍可改代码并提交，但无法回写 TAPD，也无法调用 `agent_task_report`（依赖静默完成兜底）。

## 8. 新增一个 Agent

1. 在 `runtime_catalog()` 加一条 `tui_runtime(...)`：
   - `binary`：可执行命令。
   - `args`：固定启动参数。
   - `prompt_injection`：该 CLI 支持的最稳投递方式。
   - `prompt_flag`：flag 模式必填。
   - `mcp_auto`：是否已有 MCP 注入适配。
2. 如果该客户端需要自动注入 MCP，在 `mcp_import` 补一条客户端映射，并在 `mcp_client_for_runtime` 里加上 runtime id。
3. 不需要改队列、UI 或完成判定。

## 9. 已知限制

- `stdin` 模式的就绪检测是启发式的：TUI 输出慢或一直动画时，可能等到超时才注入。
- 各 TUI 对括号粘贴的支持不完全一致；不支持时提示词可能以普通输入写入。
- 首次启动的信任目录菜单可能吞掉提示词；需要在终端里先处理一次。
- 通用 TUI 无法把权限请求结构化到桌面，只能在终端确认。
- 并发仍固定为 1；worktree 并行是后续独立阶段。

## 10. 与 orca 的差异

| 方面 | orca | 本项目 |
| --- | --- | --- |
| 接入方式 | TUI 适配表 + 各 Agent hook | TUI 适配表 + MCP 生命周期回报 |
| 完成判定 | hook 事件 + 屏幕标记 | `agent_task_report` + 进程退出 + 静默兜底 |
| 权限 | 各 Agent hook / 终端 | 统一在终端确认 |
| 隔离 | 每任务 worktree | 单仓库串行 |
| 范围 | 桌面全功能编排 | TAPD 缺陷修复队列 |

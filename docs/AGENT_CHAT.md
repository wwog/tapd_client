# Agent Chat 设计（transcript + hook + PTY）

> 目标：在现有 TAPD Agent 队列上增加一个类似 Orca 的 Chat 视图，但使用本项目的设计语言。
> 首个版本必须支持 **Claude Code、Codex、OpenCode、OMP** 四个运行时的完整 transcript。
> 本文描述设计与落地实现；实现与本文的差异见文末「实现状态」。

---

## 1. 背景与问题

当前 Agent 页只有：

- 左栏：运行 / 排队任务列表，行内只有「正在执行工具」一行状态。
- 右栏：任务头 + xterm 终端。
- 运行时状态：`AgentRuntimeStatus` 只有最新一份快照，任务结束后清空。
- 任务结束：只有 `AgentTask` 的元数据、错误与 prompt，没有对话记录。
- 权限确认：只能在内嵌终端里操作。

问题：

1. 看不到 Agent 读过/改过哪些文件、执行过什么命令、思考了多久。
2. 终端输出是 ANSI 重绘，无法稳定地做「对话」展示。
3. 权限与 `AskUserQuestion` 只能进终端，胶囊无法审批。
4. Agent 图标全部是 lucide 的通用 `Bot` / `Terminal`。

---

## 2. 结论

**不引入 Orca 的 structured agent session / journal 协议，也不解析终端屏幕。**

采用三层数据：

| 层 | 来源 | 职责 |
| --- | --- | --- |
| transcript | 各 CLI 自己落盘的会话文件 / SQLite | 完整 user / assistant / tool / thinking 消息 |
| hook | 现有 `/agent/hook` | 实时当前动作、等待权限/提问、回合结束信号 |
| PTY | 现有内嵌终端 | Chat 底部输入、无法结构化的交互、兜底 |

Chat 视图默认给 **Claude Code / Codex / OpenCode / OMP**；其他运行时禁用 Chat，只保留终端。
左栏继续保留队列，并在下方增加「执行流程」紧凑投影；左右两侧共用同一份 transcript 数据。

---

## 3. Orca 的实现（本地 `../orca` 源码核对）

### 3.1 两种 chat 模式

`src/renderer/src/components/native-chat/NativeChatView.tsx`：

- `mode: 'structured'`：接 Orca 自己的 structured agent session（host + journal），消息、工具、审批走协议，可实时流式。
- `mode: 'bridge'`：已有 PTY 会话走这条，也是本项目的参照。

### 3.2 bridge 模式的数据链

`NativeChatResolvedView.tsx` + `session/terminal/`：

1. **transcript 提供完整消息**
   `useNativeChatRetainedSession({ paneKey, agent, sessionId, transcriptPath })`
   → `window.api.nativeChat.readSession(agent, sessionId, limit, transcriptPath)`
   读取 Claude / Codex / OpenCode / OMP 等 provider 的会话文件。

2. **hook 只做实时预览**
   `hookPreview = agentStatusByPaneKey[paneKey]?.lastAssistantMessage`
   → `deriveNativeChatStreamingText(...)` 在 turn 未结束时作为流式文本追加。

3. **PTY 写入是发送通道**
   `useNativeChatPtyComposerSend` → `sendNativeChatMessage(ptyId, text)`
   → 写终端输入，并做乐观 pending 气泡、投递回执、失败提示。

4. **pending prompt 卡片**
   `useNativeChatTerminalPromptCard` 从 `interactivePrompt` + `toolName` 解析出：
   - approval：`Allow once` / `Reject`
   - question：单问题单选的选项按钮
   - unsupported：只能在终端回答

### 3.3 PendingPrompt 与 smart keys

`src/shared/agent-status/contracts/agent-pending-prompt.ts`：

```ts
type PendingPrompt =
  | { kind: 'approval'; promptId; tool; summary?; options }
  | { kind: 'question'; promptId; question; header?; options }
  | { kind: 'unsupported'; promptId }
```

每个选项在服务端映射到 PTY 按键：

`src/shared/terminal/input/agent-smart-keys.ts`：

| 运行时 | 权限允许 | 权限拒绝 | 问题选项 |
| --- | --- | --- | --- |
| Claude / OpenClaude | `1` | `Esc` | 选项序号数字 |
| Codex / Grok | `y` | `n` | 选项序号数字 |
| OpenCode / OpenCode 2 / ZCode | `Enter` | `Esc` | 选项序号数字 |

- Claude 额外有 `2` = 「总是允许」。
- 多选 / 多问题 / 带 preview 的问题一律 `unsupported`，回退终端。
- 多段按键之间间隔约 120ms，避免 `Esc Esc` 被识别成 Alt+Esc。

### 3.4 UI 结构

- `activity-thread-row.tsx`：左侧状态点 → 标题 + 相对时间 → 2–3 行状态预览 → Agent 图标 + workspace + hover 操作。
- `activity-thread-detail-pane.tsx`：右侧只有「状态点 + Agent 图标 + 标题 + repo/worktree」头部，下面直接是终端。
- `AgentStateDot.tsx`：working = spinner，permission/waiting = attention，failed = 红点，done = 绿勾，interrupted/idle = 弱化点。
- `AgentIcon.tsx`：已知 Agent 内联品牌 SVG，其他用 favicon，最后回退首字母；图片圆角 2px。

### 3.5 与本项目的差异

Orca 的 Activity 只记录 Agent 状态切换（`stateHistory` 最多 20 条），工具/回复预览不重复入历史。
本项目要在其基础上增加**逐工具步骤 + 耗时**，并保留 Chat 与终端两个视图。

---

## 4. 本项目范围

### 4.1 支持运行时

首版必须完整支持：

| 运行时 id | transcript 形态 | Chat |
| --- | --- | --- |
| `claude` | JSONL（`~/.claude/projects`） | 是 |
| `codex` | JSONL（`~/.codex/sessions`） | 是 |
| `opencode` | SQLite（`opencode.db`） | 是 |
| `omp` | JSONL（`~/.omp/agent/sessions`） | 是 |

兼容别名（成本低，随首版一起做）：

- `openclaude` → Claude 解析器
- `opencode2` → OpenCode 解析器
- `pi` → OMP 同族解析器

其他 40+ 运行时：Chat 页签禁用，显示「该运行时暂不支持对话视图」，默认终端。
后续可以按同一接口加 Gemini / Qwen / Kimi 等。

### 4.2 数据源职责

| 数据 | 来源 | 是否进入 Chat |
| --- | --- | --- |
| user 消息 | transcript（Claude/Codex/OpenCode/OMP） | 是 |
| assistant 文本 | transcript | 是 |
| thinking / reasoning | transcript | 是，默认折叠 |
| tool_use / tool_result | transcript | 是，工具卡片 |
| 当前工具 / 当前 phase / 已用时长 | hook `AgentRuntimeStatus` | Working 条，不重复成消息 |
| 权限 / AskUserQuestion | hook `interactivePrompt` + tool input | 内联 PendingPrompt 卡片 |
| 用户从 Chat 发送的文本 | 前端乐观消息 + PTY 写入 | 是，transcript 到达后去重 |
| 任务生命周期 | 后端 | 系统行（入队/启动/完成/失败） |

---

## 5. 总体架构

```
┌──────────────────────────── Agent 页 ────────────────────────────┐
│ 左栏 320px                          │ 右栏                          │
│ ┌────────────────────────────────┐  │ ┌──────────────────────────┐ │
│ │ 执行队列（Orca 风格行）         │  │ │ 任务头 + [对话|终端]      │ │
│ │  ● 任务 A  读取 src/a.ts  2s   │  │ ├──────────────────────────┤ │
│ │  ○ 任务 B  排队中              │  │ │ Chat 消息流               │ │
│ ├────────────────────────────────┤  │ │  user / assistant / tool  │ │
│ │ 执行流程（紧凑投影）            │  │ │  thinking / prompt card   │ │
│ │  10:01 读取文件 src/a.ts  2s   │  │ │  working 条               │ │
│ │  10:02 修改文件 src/b.tsx 5s   │  │ ├──────────────────────────┤ │
│ │  10:03 执行命令 cargo test 12s │  │ │ Composer（写 PTY）        │ │
│ └────────────────────────────────┘  │ └──────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘

数据流：
CLI 落盘 transcript ──read-only──> Rust transcript reader ──agent_chat──> Chat
CLI 原生 hook ──POST /agent/hook──> AgentCore ──agent://runtime──> Working/审批
Chat composer ──agent_send_message──> PTY writer ──> CLI
Prompt card ──agent_prompt_answer──> PTY 按键 ──> CLI
```

---

## 6. Transcript 读取层

新增 `apps/desktop/src-tauri/src/agent/transcript.rs`，只读、限长、无网络。

### 6.1 统一模型

```rust
pub(super) enum TranscriptAgent { Claude, Codex, OpenCode, Omp }

pub(super) struct ChatMessage {
    pub id: String,          // 稳定 id：provider message id / rowid + block index
    pub role: String,        // user | assistant | tool | system
    pub kind: String,        // message | thinking | tool | system
    pub at: String,          // RFC3339
    pub text: Option<String>,
    pub tool: Option<ChatTool>,
}

pub(super) struct ChatTool {
    pub name: String,
    pub input: Option<String>,   // 可读参数：路径 / 命令 / 模式
    pub output: Option<String>,  // 结果预览，默认折叠
    pub status: String,          // running | done | failed
    pub duration_ms: Option<u64>,
    pub call_id: Option<String>,
}
```

一条 provider 消息可以拆成多条 `ChatMessage`：

- `thinking` 块 → `kind=thinking`
- `text` 块 → `kind=message`
- `tool_use` 块 → `kind=tool`
- `tool_result` → 回填对应 `ChatTool.output/status/duration`，不新增卡片

这样 Chat 与左栏时间线可以共用同一份扁平事件流。

### 6.2 路径解析

统一入口：

```rust
pub(super) struct TranscriptSource {
    pub agent: TranscriptAgent,
    pub path: PathBuf,
    pub session_id: String,
    pub opencode: Option<OpenCodeSource>,
}

pub(super) fn resolve_source(
    runtime_id: &str,
    session_id: &str,
    cwd: &str,
) -> Option<TranscriptSource>
```

`session_id` 来自 `AgentTask.agent_session_id`（现有 hook 已捕获）。
若为空：Chat 显示「等待会话 id」，不猜测文件。

#### Claude Code

- 根目录：`$CLAUDE_CONFIG_DIR/projects`（绝对路径时），否则 `~/.claude/projects`。
- 文件名：`<session-id>.jsonl`，位于某个 project bucket 下。
- 解析：
  1. 遍历 `projects/*/`（depth 1），找 `<id>.jsonl`。
  2. 找不到时，用 `encodeClaudeProjectPath(cwd)` 定位 cwd bucket，取该目录最新 `.jsonl`，并检查记录里的 `sessionId` 是否匹配。
  3. 长路径 bucket 是 `<前 200 字符>-<hash>`，用前缀匹配。
- 编码规则：每个非字母数字字符替换成 `-`，不折叠连续字符。

真实记录：

```jsonc
{"type":"user","uuid":"...","timestamp":"...","sessionId":"...",
 "message":{"role":"user","content":"..."}}
{"type":"assistant","uuid":"...","timestamp":"...",
 "message":{"role":"assistant","model":"...","content":[
   {"type":"thinking","thinking":"..."},
   {"type":"text","text":"..."},
   {"type":"tool_use","id":"toolu_...","name":"Bash","input":{"command":"cargo test"}}
 ]}}
{"type":"user","message":{"role":"user","content":[
   {"type":"tool_result","tool_use_id":"toolu_...","content":"..."}
]}}
```

- `content` 可能是字符串，也可能是 block 数组。
- `isSidechain: true` 是子 Agent，主 Chat 先跳过；后续可在子 Agent 区展示。
- `isMeta: true` 或已知注入文本（`<system-reminder>` 等）跳过或折叠。
- 工具耗时：`tool_use` 所在记录 timestamp → `tool_result` 所在记录 timestamp。

#### Codex

- 根目录：`$CODEX_HOME/sessions`（绝对路径时），否则 `~/.codex/sessions`。
- 文件名：`rollout-<timestamp>-<uuid>_<uuid>.jsonl`，递归查找 stem 等于 id 或以 `-<id>` 结尾的文件。
- 归档 `.jsonl.zst` 首版不读；运行中的会话写 `.jsonl`。

真实记录：

```jsonc
{"type":"session_meta","payload":{"id":"...","cwd":"...","timestamp":"..."}}

{"type":"response_item","timestamp":"...","payload":{
  "type":"message","id":"...","role":"user",
  "content":[{"type":"input_text","text":"..."}]}}

{"type":"response_item","payload":{
  "type":"custom_tool_call","name":"exec","call_id":"...","input":"..."}}
{"type":"response_item","payload":{
  "type":"custom_tool_call_output","call_id":"...","output":"..."}}

{"type":"event_msg","payload":{
  "type":"item_completed","started_at_ms":...,"completed_at_ms":...,
  "item":{"type":"CommandExecution","command":[...],"aggregated_output":"...",
          "status":"completed","exit_code":0,"duration":{...}}}}
{"type":"event_msg","payload":{
  "type":"task_complete","last_agent_message":"...","duration_ms":...}}
```

解析策略：

- `response_item` + `payload.type=message` → user/assistant；跳过 `developer`。
- `custom_tool_call` / `function_call` → 工具卡片。
- `custom_tool_call_output` / `function_call_output` → 回填结果。
- `event_msg` + `item_completed`：
  - `CommandExecution` → 命令、输出、exitCode、duration。
  - `FileChange` → 修改文件 + diff。
  - `McpToolCall` → MCP 工具卡片。
- `task_complete.last_agent_message` 可作为最后一条 assistant 文本的兜底（若 response_item 缺失）。
- 工具耗时优先用 item 的 `started_at_ms/completed_at_ms`，否则用前后记录 timestamp。

#### OpenCode

- 数据目录：`$XDG_DATA_HOME/opencode`，否则 `~/.local/share/opencode`。
- DB：`$OPENCODE_DB`（绝对路径）或 `<data>/opencode.db`；同时探测 `<data>/opencode-*.db`。
- 首版支持两种 schema：

**v2（当前）**：

```sql
session_v2(id, title, directory, time_created, time_updated, ...)
session_message(session_id, type, data, time_created, ...)
```

`data` 是 JSON：

```jsonc
// user
{"text":"...","time":{"created":1794389621682}}
// assistant
{"time":{"created":...,"streamed":...,"completed":...},
 "content":[
   {"type":"reasoning","text":"..."},
   {"type":"text","text":"..."},
   {"type":"tool","tool":"bash","callID":"...",
    "state":{"status":"completed","input":{"command":"..."},
             "output":"...","time":{"start":...,"end":...}}}
 ]}
```

**v1（兼容）**：

```sql
message(id, session_id, time_created, time_updated, data)
part(id, message_id, session_id, time_created, time_updated, data)
```

- `message.data`：`role`、`time`、`summary`、`model`、`tokens`。
- `part.data.type`：`text`、`tool`、`reasoning`、`step-start`、`step-finish`、`patch`。
- `tool` part 的 `state` 与 v2 相同，`time.start/end` 直接给出耗时。
- 读取顺序：`message.time_created` → `part.time_created`。

**JSON storage 兜底（旧版本）**：

- `<data>/storage/session/<session-id>.json`
- `<data>/storage/message/<session-id>/*.json`
- 只还原 text/summary；没有工具 parts 时工具卡片留空，不报错。

实现注意：

- 用 `rusqlite` 只读打开（`SQLITE_OPEN_READ_ONLY`），`busy_timeout` 500ms。
- 先探测表存在，再决定 v2 / v1，避免不同 release 直接报错。
- DB 可能很大（本机 200MB），只查目标 session 并按 `time_created` 限制条数。

#### OMP

- 根目录（按优先级）：
  - `$OMP_CODING_AGENT_DIR`（可能是 agent 根、`.omp` 根或 sessions 根）
  - `$XDG_DATA_HOME/omp/sessions`，否则 `~/.local/share/omp/sessions`
  - `~/.omp/agent/sessions`
  - profile：`~/.omp/profiles/<name>/agent/sessions`、`$XDG_DATA_HOME/omp/profiles/<name>/sessions`
- 文件名：`<timestamp>_<session-id>.jsonl`；递归查找 stem 等于 id 或以 `_<id>` 结尾的文件。
- 子 Agent 目录跳过（`subagent` artifact 目录名可能命中父 id）。

真实记录：

```jsonc
{"type":"session","id":"...","cwd":"...","timestamp":"..."}
{"type":"model_change","model":"..."}
{"type":"message","id":"...","timestamp":"...","message":{
  "role":"user","content":[{"type":"text","text":"..."}]}}
{"type":"message","id":"...","message":{
  "role":"assistant","content":[
    {"type":"thinking","thinking":"..."},
    {"type":"text","text":"..."},
    {"type":"toolCall","id":"call_...","name":"bash",
     "arguments":{"command":"...","i":"..."}}
  ]}}
{"type":"message","message":{
  "role":"toolResult","toolCallId":"call_...","toolName":"bash","isError":false,
  "content":[{"type":"text","text":"..."}]}}
```

- `toolResult` 用 `toolCallId` 精确回填，`isError` 决定 failed。
- 工具耗时：`toolCall` 所在消息 timestamp → `toolResult` 消息 timestamp。
- OMP 的 `arguments` 里常带 `i`（意图描述），展示时优先命令/路径，`i` 作为标题。

### 6.3 合并、去重、耗时

- 每个 provider 内部按记录顺序生成扁平 `ChatMessage`。
- tool_result 通过 `call_id` 回填，不新增卡片；找不到对应 call 时追加一条 `kind=tool` 的 system 卡片。
- 耗时：
  - Claude / OMP：前后消息 timestamp。
  - Codex：item 的 `started_at_ms/completed_at_ms` 优先。
  - OpenCode：`state.time.start/end` 优先。
- 单次返回上限：2000 条消息、单条文本 16KB、工具输出 8KB、总读取 8MB。
- 超限时截断并在返回里带 `truncated: true`。

### 6.4 缓存与轮询

- `agent_chat(taskId)` 读取 transcript。
- 后端缓存：`Mutex<HashMap<taskId, TranscriptCache>>`，记录 `mtime + size + last_len`。
  - JSONL：文件未变化直接返回缓存。
  - SQLite：每次查 `session_message` 的 `max(time_created)/count`，变化才重读。
- 前端：
  - Chat 可见且任务 `running`：每 1s 调一次。
  - 任务结束：调一次并停止。
  - `document.hidden` 时暂停（复用 `usePoll` 的 `pauseWhenHidden`）。

---

## 7. 实时态（hook）

### 7.1 `AgentRuntimeStatus` 扩展

在现有字段上补：

```rust
pub struct AgentRuntimeStatus {
    phase, label, tool, detail, message, model, session_id, subagents,
    started_at: Option<String>,          // 当前 phase 起始
    last_message: Option<String>,        // 最近 assistant 文本（Orca lastAssistantMessage）
    prompt: Option<AgentPendingPrompt>,  // 权限/提问卡片
    updated_at,
}
```

`started_at` 用于 Working 条和胶囊的已用时长；`last_message` 用于 transcript 尚未落盘时的预览。

### 7.2 `AgentPendingPrompt`

```rust
pub struct AgentPendingPrompt {
    pub prompt_id: String,          // taskId + stateStartedAt，防旧卡片误操作
    pub kind: String,               // approval | question
    pub tool: Option<String>,
    pub summary: Option<String>,    // 权限请求摘要
    pub question: Option<String>,   // AskUserQuestion 题干
    pub header: Option<String>,
    pub options: Vec<AgentPromptOption>, // { id, label, description? }
    pub can_answer: bool,
    pub answer_hint: Option<String>,     // “发送 1 / Esc”“在终端中回答”
}
```

来源：

- `PermissionRequest` / `PermissionAsked` → `kind=approval`，`summary` 取 `tool_input` 可读摘要。
- `PreToolUse` 且工具名归一化为 `askuserquestion` / `ask_user_question` / `request_user_input`：
  - 解析 `tool_input.questions`。
  - 仅支持单问题、单选、无 preview；其余 `can_answer=false`。
- `Notification` 中 `notification_type` 含 `permission` → approval。
- 非等待事件（PostToolUse / 下一个 PreToolUse / Stop）清空 `prompt`。

### 7.3 按键映射

新增 `agent/prompt.rs`（或 `status.rs` 内部纯函数）：

| 运行时 | approval 允许 | approval 拒绝 | question 选项 |
| --- | --- | --- | --- |
| `claude` / `openclaude` | `1` | `Esc` | `1..9` |
| `codex` / `grok` | `y` | `n` | `1..9` |
| `opencode` / `opencode2` / `zcode` | `Enter` | `Esc` | `1..9` |
| 其他 | 不可回执 | 不可回执 | 不可回执 |

- `can_answer=false` 时 UI 只显示「在 Agent 界面处理」。
- 多段按键按 120ms 间隔逐段写（本次单键场景通常不需要）。
- 写入复用 `AgentCore::write_input()`。

---

## 8. Chat API

### 8.1 `agent_chat`

请求：

```json
{ "taskId": "..." }
```

响应：

```json
{
  "taskId": "...",
  "runtimeId": "claude",
  "sessionId": "...",
  "messages": [ChatMessage],
  "truncated": false,
  "source": "claude-jsonl",
  "error": null
}
```

- 找不到 transcript：`messages=[]`，`error` 给出可读原因（无 session id / 文件不存在 / 解析失败）。
- 不影响终端；Chat 视图显示空状态 + 错误提示。

### 8.2 `agent_send_message`

请求：

```json
{ "taskId": "...", "text": "..." }
```

行为：

1. 校验任务 `running`。
2. 若当前有 `prompt` 且 `can_answer`，拒绝发送并提示先回答。
3. 写入：`\x1b[200~` + text + `\x1b[201~\r`（复用 `pty.rs` 的 bracketed paste 方式）。
4. 返回 `{ sent: true }`。

前端：

- 立即插入一条 pending user 气泡。
- transcript 出现同文本 user 消息后移除 pending。
- 60s 未出现则标记「未确认送达」，允许重试。
- Agent 忙时由各 CLI 自己排队/打断；首版不做应用层队列。

### 8.3 `agent_prompt_answer`

请求：

```json
{ "taskId": "...", "promptId": "...", "optionId": "allow_once" }
```

行为：

1. 校验 `promptId` 仍是当前 prompt。
2. 按运行时映射取按键。
3. 写 PTY。
4. 返回 `{ sent: true, message: "已发送 1" }`。
5. 不伪造状态，等下一个 hook 事件确认。

### 8.4 事件

- `agent://runtime`：已有，扩展 `prompt` / `started_at` / `last_message`。
- `agent://chat`（可选）：transcript 轮询命中新内容时推送，减少前端空轮询。
  首版可以先只用前端 1s 轮询，事件后续再加。

---

## 9. 前端设计

### 9.1 右栏 Chat / 终端

`AgentPage` 运行 tab 的右侧：

```
AgentTaskHeader
  ├─ 状态点 + Agent 图标 + 标题 + 仓库 + 操作
  └─ [对话] [终端]  Segmented
内容区
  ├─ Chat：消息流 + Working 条 + Composer
  └─ 终端：现有 AgentTerminal
```

- 支持的运行时默认「对话」；不支持默认「终端」并禁用对话页签。
- 终端页签始终可用；转录失败/为空时显示「切换到终端」。
- Chat 可见时才轮询 transcript。

### 9.2 消息卡片

参考 Orca 的 `NativeChatAgentMessageCard`，换成项目 token：

- user：右对齐浅色气泡（`bg-sky-50 border-sky-100`），最大宽度 80%。
- assistant：左对齐卡片（`rounded-xl border border-border bg-surface`），左上 Agent 图标，Markdown 正文。
- system / lifecycle：居中弱化小字（入队、启动、完成、失败）。
- thinking：默认折叠的一行「思考中 · 12s」，展开显示文本。
- tool：紧凑卡片：
  - 图标（读/改/命令/搜索/联网/子 Agent）
  - 标题（读取文件 / 修改文件 / 执行命令）
  - 目标（路径 / 命令，mono，两行截断）
  - 状态点 + 耗时
  - 展开：工具参数、输出预览、编辑 diff
- 文件修改卡片额外显示「查看改动」，调用现有 `agent_review_diff`（按需）。

Markdown：

- 引入 `@uiw/react-markdown-preview`（已是 `@uiw/react-md-editor` 的传递依赖，补成直接依赖）。
- 只读渲染，禁用图片远程加载（项目已有策略可复用）。
- 代码块横向滚动，不用 `dangerouslySetInnerHTML` 处理用户输入。

### 9.3 Working 条

位于消息流底部、Composer 上方：

```
[spinner] 正在执行命令 · cargo test       已用 1m 12s    [中断]
```

- 数据来自 `AgentRuntimeStatus`：`label`、`tool`、`detail`、`started_at`。
- 每秒 ticker 更新已用时长。
- Agent 等待权限/提问时切换为 attention 色，并显示 prompt 卡片。
- transcript 新消息到达后 Working 条自动上移。

### 9.4 Composer

```
┌────────────────────────────────────────────────────┐
│ 输入要发送给 Agent 的消息…                    [↑]  │
│ Enter 发送 · Shift+Enter 换行 · 写入当前终端        │
└────────────────────────────────────────────────────┘
```

- 自动高度 textarea，最多 8 行。
- 发送中禁用；显示「发送中…」。
- pending 气泡显示「发送中 / 未确认送达 / 重试」。
- 有 pending prompt 时，prompt 卡片占据输入区，回答后恢复。
- 粘贴长文本走现有 `admitNativeChatPastedText` 思路：前端限长，超出提示。

### 9.5 左栏「执行流程」

- 位置：队列下方，`AgentTimeline`。
- 数据：同一份 `agent_chat` 结果，投影成紧凑步骤：
  - user → 跳过（或「收到任务」）
  - thinking → 「思考中」+ 耗时
  - tool → 「读取文件 src/a.ts」+ 耗时
  - assistant → 「回复」+ 首行
  - pending prompt → 「等待权限确认 / 等待回答」
  - lifecycle → 「已入队 / 启动 / 完成 / 失败」
- 运行中在末尾追加一条来自 `AgentRuntimeStatus` 的「当前动作」，transcript 追上后移除。
- 自动跟随最新；上滚后暂停并显示「回到最新」。
- 最多渲染 500 行，使用 `content-visibility: auto`。

### 9.6 胶囊

`AgentSummary` 扩展：

```
runtimeId, runtimeName, phase, statusLabel, tool, detail, message,
startedAt, queued, lastMessage, prompt, pendingReviews, permissionCanAnswer
```

- 折叠胶囊：品牌图标 + `{runtimeName} 运行中/等待权限/等待回答/待审核/排队中`。
- Hover peek（高度 88 → 172）：
  - Agent 图标 + 名称 + 状态点 + 已用时长
  - 缺陷标题 / 项目 + #bug
  - 当前动作（`tool · detail`）
  - pending prompt 选项按钮（最多 3 个，其余「更多」）
  - 审批按钮：`允许一次` / `拒绝`，或 `通过并提交` / `停止并储藏` / `中断` / `打开 Agent 界面`
- 操作复用 `agent_prompt_answer` / `agent_review_approve` / `agent_review_stop` / `agent_task_cancel` / `agent_open_task`。
- 点击胶囊打开主窗口对应任务；双击打开主窗口。

### 9.7 图标

- vendor `@lobehub/icons-static-svg`（MIT）到 `apps/desktop/src/assets/agent-icons/`。
- Orca 的 Pi / OMP / Aider / Kilo / Copilot / OpenCode glyph（MIT）作为补充。
- `AgentIcon.tsx`：
  - `-color` 版本 `<img>` 原色；
  - 单色版本 CSS mask + `bg-current`；
  - 无图回退首字母圆角块；未知运行时 `?`；
  - 图片 2px 圆角。
- 替换点：AgentPicker、AgentTaskHeader、AgentQueuedDetail、AgentHistory、AgentApproval、AgentComposeSheet、AgentConfigPane、DefaultAgentCard、AgentActivityLine、IslandWindow、TitleBar。
- NavRail 仍保留 Agent 页图标（页面身份，不是具体 Agent）。

---

## 10. 持久化与性能

### 10.1 持久化

- **transcript 本身由 CLI 落盘**，本项目不复制内容。
- `AgentTask` 增加：

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub transcript_path: Option<String>,   // JSONL 路径或 opencode.db#sessionId
```

- 首次 `agent_chat` 解析成功后写回任务并持久化，后续直接读路径，避免每次扫目录。
- `agent_session_id` 已有；没有它时 Chat 不可用。
- 任务删除不删除 provider transcript（用户可能还需要）。

### 10.2 性能

- 单次读取上限 2000 条 / 8MB；超出截断。
- 文件缓存按 `mtime + size`，SQLite 按 `max(time_created) + count`。
- Chat 不可见 / 窗口隐藏时停止轮询。
- 左栏时间线只渲染 500 行，`content-visibility: auto`。
- 不在 `AgentTasksState` 广播里携带 transcript；只用 `agent_chat` 按需拉取。

---

## 11. 错误与回退

| 情况 | 行为 |
| --- | --- |
| 运行时不在四个支持列表 | Chat 页签禁用，默认终端 |
| 没有 `agent_session_id` | Chat 显示「等待会话 id」，终端可用 |
| transcript 文件不存在 | Chat 空状态 + 错误 + 「切换到终端」 |
| JSONL 解析失败 | 跳过坏行；全部失败则返回错误 |
| OpenCode DB 打不开 / 被锁 | 返回错误，不阻塞任务；可重试 |
| transcript 为空但任务在跑 | 显示 Working 条 + 「等待 Agent 输出」 |
| 发送时 Agent 已结束 | 返回错误，气泡标「未发送」 |
| prompt 已过期 | 返回「权限请求已处理」，刷新状态 |
| 终端权限无法按键 | 卡片显示「在终端中回答」 |

---

## 12. 实施顺序

### 阶段 1：transcript 层（Rust）

1. `agent/transcript.rs`：统一模型、路径解析、四个 provider 解析器。
2. 单元测试：用本地真实文件的精简 fixture（脱敏）覆盖：
   - Claude user/assistant/tool_use/tool_result/thinking
   - Codex response_item + item_completed + task_complete
   - OpenCode v2 / v1
   - OMP toolCall/toolResult
3. `agent_chat` 命令 + 缓存 + `transcript_path` 写回。

### 阶段 2：Chat UI（React）

1. `AgentChatPane`：消息流、Markdown、工具卡片、Working 条。
2. `[对话|终端]` 切换；不支持时禁用。
3. `agent_send_message` + Composer + pending 气泡。
4. 空状态/错误/截断提示。

### 阶段 3：PendingPrompt

1. `AgentRuntimeStatus.prompt` + `agent_prompt_answer`。
2. `AgentPromptCard`（approval / question）。
3. 任务头与胶囊共用。
4. 按键映射单测。

### 阶段 4：左栏流程与胶囊

1. `AgentTimeline` 投影。
2. `AgentSummary` 扩展 + 胶囊文案/peek/操作。
3. 胶囊几何常量同步（`PEEK_CARD_HEIGHT`）。

### 阶段 5：图标

1. vendor 图标 + `AgentIcon`。
2. 替换所有 Agent 展示点。

---

## 13. 测试与验收

### 13.1 自动测试

- `cargo test -p tapd-client`：
  - transcript 四个 provider 的解析 fixture。
  - 工具 call/result 匹配与耗时。
  - 路径解析（Claude 编码、Codex/OMP 文件名、OpenCode DB）。
  - PendingPrompt 解析与按键映射。
  - 读取上限/截断。
- `pnpm -C apps/desktop typecheck`。
- `pnpm -C apps/desktop build`。

### 13.2 手动验收

1. 用 Claude Code 跑一个缺陷任务：
   - Chat 出现 user prompt、thinking、读/改/命令工具卡片、assistant 回复。
   - 工具卡片耗时与终端行为一致。
   - 底部发送一条消息，终端能收到并出现在 Chat。
2. Codex：同样验证；确认 `CommandExecution` 输出和 `task_complete` 不重复。
3. OpenCode：验证 v2 DB 消息、工具卡片、`state.time` 耗时；切到终端仍可接管。
4. OMP：验证 `toolCall` / `toolResult` 匹配、thinking 折叠。
5. 权限：Claude `PermissionRequest` 在 Chat 与胶囊出现「允许一次 / 拒绝」，点击能推进终端。
6. 提问：Claude `AskUserQuestion` 单问题单选出现选项按钮；多选回退终端。
7. 任务结束后重启客户端：从历史任务重新打开 Chat，transcript 仍可读。
8. 不支持的运行时：Chat 页签禁用，终端正常。
9. 深色主题、长消息、长工具输出、窗口变窄。

---

## 14. 风险与开放问题

1. **Transcript schema 会随 CLI 版本变化**：解析器必须「坏行跳过、缺字段降级」，不能阻塞任务。
2. **Claude 文件名不一定等于 session id**：需要 cwd bucket 兜底；极端情况下 Chat 退回终端。
3. **Codex `.jsonl.zst` 归档**：首版只读运行中的 `.jsonl`；历史归档需要 zstd 解压，后续再加。
4. **OpenCode schema v1/v2 并存**：探测表结构，v2 优先；JSON storage 只做文本兜底。
5. **工具输出可能很大/含敏感信息**：单条截断、默认折叠、只读本地，不上传。
6. **发送语义**：首版直接写 PTY，Agent 忙时由 CLI 决定排队/打断；应用层队列是后续阶段。
7. **权限按键是 best-effort**：只对确认过的运行时/状态开放；协议变化时标 `unsupported`，回退终端。
8. **结构化流式**：transcript 不是逐 token；assistant 文本按消息落盘出现。若要 Orca structured 级别的流式，需要另起 host/journal 协议，不在本设计范围。

---

## 15. 与现有文档的关系

- `docs/AGENT.md`：Agent 队列、运行时、TUI、审核、回写。
- `docs/MULTI_AGENT.md`：运行时适配表与完成判定。
- 本文：Chat 视图、transcript 读取、PendingPrompt、胶囊审批。

---

## 16. 实现状态

已落地：

- `agent/transcript.rs`：Claude / Codex / OpenCode（v2、v1、JSON storage 兜底）/ OMP
  的只读解析，工具结果回填、耗时、2000 条 / 8 MB 截断，`cargo test` 覆盖。
- `agent/prompt.rs`：权限 / 提问解析与按键映射（Claude 1/Esc、Codex y/n、OpenCode Enter/Esc）。
- `agent_chat` / `agent_send_message` / `agent_prompt_answer` 命令。
- `AgentRuntimeStatus.startedAt/lastMessage/prompt` 与 `agent://summary` 实时推送。
- 右侧「对话 / 终端」切换、消息流、Markdown、工具卡片、思考折叠、Working 条、
  Composer 乐观气泡、权限 / 提问卡片。
- 左栏「执行流程」紧凑时间线；历史记录通过「查看对话」只读回看。
- 胶囊 peek 显示当前动作、已用时长，并可直接回答权限 / 提问。
- 运行时图标：Claude / Codex / OpenCode / OMP 内联品牌记号，其余回退首字母。
- 任务级运行时 / 模型 / 访问权限选择；设置页保存每个运行时的默认模型与权限。
- 任务头与 Chat Working 条显示当前模型；Provider 最终错误（重试耗尽、网络中断、
  模型不可用）会让任务按失败收尾，而不是误报完成。

与设计的差异：

- transcript 路径只缓存在内存（`ChatCache`），没有写回 `AgentTask.transcript_path`；
  重启后首次打开重新定位一次目录，复杂度与跨 crate 改动更低。
- `agent_chat` 支持前端回传指纹：内容未变化时只返回 `unchanged=true`，不重复传输
  2000 条消息。
- 历史任务没有独立的左右分栏 Chat，使用弹窗只读查看；发送、权限卡片只在运行中可用。
- 多问题 / 多选 / 带 preview 的提问仍回退终端（与设计一致）；OMP 的权限按键未开放。

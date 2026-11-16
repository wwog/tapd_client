# 内置 dsh 运行时（契约与调研结论）

> 本文记录把 DeepSeek Harness（dsh）作为**内置 Agent 运行时**嵌进桌面端的契约：
> 钉哪个版本、用哪些扩展点、三条通道各管什么、升级时要验什么。
> 上游源码只作为只读参考（本地 clone：`~/projects/deepseek-harness`，不提交进本仓库）。

## 1. 钉定的版本

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/deepseek-ai/deepseek-harness |
| commit | `39163dd30f703a79079e2d2446545cff3c453738`（2026-11-13） |
| 包版本 | `@deepseek-ai/dsh@0.2.2-rc.3` |
| 许可 | MIT（需在 THIRD_PARTY_NOTICES 里披露） |

升级流程：改 `vendor/dsh/package.json` 的精确版本 → `pnpm install --frozen-lockfile` →
跑 `scripts/dsh/verify.mjs` 契约冒烟 → 人工过一遍会话流 / 审批 / 提问 / 团队板。**不做 rebase，不改上游文件。**

## 2. 运行时要求：系统 Node，不打包

- 引擎要求 `node >= 24.9`（上游 `package.json` 的 `engines`），本机实测 `v24.21.0`。
- **没有原生 addon**：存储与索引都用 Node 24 内置的 `node:sqlite`
  （`packages/storage/storage-sqlite/src/schema.ts`、`packages/session-query/session-query-sqlite/src/index.ts`）。
  因此不需要匹配 ABI，只要版本够新即可。
- 启动时必须用 `shell_path::user_path()` 解析 `node`（GUI 进程的 PATH 与终端不同），
  校验主次版本，失败给明确错误页（安装命令 + 重新检测），**不静默降级、不打包 node**。
- 打包的是 JS 依赖树：`resources/dsh/{node_modules,plugins,profiles}`。

### 2.1 已实测（2026-11-16，`/tmp/dsh-probe`）

| 验证 | 结果 |
| --- | --- |
| `npm i @deepseek-ai/dsh@0.2.2-rc.3` | 成功；`bin.dsh = lib/bin.js`，91 个直接依赖 |
| `node lib/bin.js --profile sdk --dump-config` | 自动初始化 `$DSH_HOME/profiles/sdk`，630+ 行 config |
| 自定义 profile `tapd`（bundles = base + sdk-app） | 启动成功 |
| profile patch 用**绝对路径**挂插件 | 生效，dump 里规范化为 `file:///…` |
| `llm-pi-ai.providers.<id>` 自定义 provider | 路由解析通过（冒烟用 `openai-completions`） |
| `initialize` | 返回 `{serverInfo:{name:'deepseek-harness-sdk-runtime',version:'0.0.1'}}` |
| `session/query` | 返回 `{kind:'prompt',messageId}` |
| 响应并发 | 请求可乱序返回（id 2 先于 id 1），客户端必须按 id 派发 |

实验性插件（auto-review、CUA、插件市场、CoT 翻译、徽章技能、会话标题、个性化推荐、
tool-worktree、inspector 等）本来就随 `@deepseek-ai/dsh` 的依赖树发布，不需要单独安装。

### 2.2 依赖树体积（实测，arm64 macOS）

| 状态 | 大小 | 说明 |
| --- | --- | --- |
| `npm i @deepseek-ai/dsh@0.2.2-rc.3` 原样 | 1.3 GB | 含 web 前端、Office、CUA、webworker 等全部 bundle |
| 删除未挂载的重型家族后 | 816 MB | LibreOffice(-311M)、`dsh-web-frontend`、`dsh-client-ui-*`、`dsh-experimental-*`、`dsh-cua*`；**仍能启动并 initialize** |
| 再删 `.ts` / `.d.ts` / `.map` / `docs` | 预计 ~300 MB | 34k 个 `.ts` 源文件共 239 MB，`.map` 56 MB |

原生依赖（都是 N-API，ABI 稳定，不需要按 Node 小版本重新编译）：
`node-addon-require-builtin`（napi-v9）、`node-pty`（多平台 prebuilds）、
`sharp`/libvips（图片）、`sherpa-onnx`（语音输入，实验插件用）。
后两者与语音 / 图片预览相关，未挂载对应插件时可以按平台裁剪。

P2b 的构建脚本按「必需集合 + 平台裁剪」生成 payload，并跑契约冒烟确认裁剪没有破坏启动。

## 3. 三条通道

| 通道 | 方向 | 用途 | 稳定性 |
| --- | --- | --- | --- |
| stdio JSON-RPC | 双向 | 建会话、发 prompt、等待、恢复、审批、提问、关停 | **文档化**（`packages/sdk/protocol`） |
| 本机 TCP + token 的 NDJSON | dsh → Rust | token 级流式、任务板、会话快照 | 自研契约（本文第 5 节） |
| `127.0.0.1` HTTP + token | dsh → Rust | TAPD 业务工具（替代 MCP） | 复用现有 `server.rs` / `feature_router` |

**为什么流式不能只靠 SDK**：SDK 只推已提交的 `session.event`；token 级增量是进程内的
`agent/assistant-stream`，官方只给 Web 的 follow 适配器接。Gateway（`/api/remote.mux`，
Typert 生成式 RPC）确实有 `assistant/live-chunk`，但那是内部生成协议 + 每进程凭证，
用 Rust 逆向不划算。所以我们自己在插件里订阅并把 frame 转发出来。


### 3.1 应用侧宿主（已实现，P2c）

| 步骤 | 代码 | 实测 |
| --- | --- | --- |
| 找到 payload | `dsh/payload.rs`：`TAPD_DSH_PAYLOAD` → 调试期 `src-tauri/resources/dsh` → 打包资源 | 三种来源都能解析 |
| 校验 + 解压 | sha256 + 大小比对，解到 `<data>/dsh/<version>/`，先写 staging 再 rename | 231 MB / 25k 文件，首次 6.0 s（debug 构建 23 s） |
| 找 Node | `dsh/runtime.rs::resolve_node`：`shell_path::user_path()` + Homebrew 兜底，`node --version` 过门槛 | 命中 nvm 的 `v24.21.0` |
| 组合 profile | `crates/dsh-host/profile.rs` 渲染 manifest/patch/pnpm-workspace；插件来自 `<runtime>/node_modules/@tapd/*` | ready 1.8 s |
| 控制面 | `initialize`（approvalRequests + userQuestions）→ `session/query` | 返回 `{kind:"prompt",messageId}` |
| 事件 | `session.event` → `dsh://session-event`；审批/提问 → `dsh://approval` / `dsh://question`，回执按 RPC id | 待 P2d 接前端 |

调试期有一个只读驱动：`POST /dev/dsh`（`{"action":"payload|prepare|start|stop|status|prompt"}`），
用 `_dev` 数据目录里的 token 鉴权，可以在不打开 UI 的情况下走完整条链路。

### 3.2 两个容易踩的坑（已修）

1. **裁剪不能删 `build/src`**：`@opentelemetry/api-logs`、`human-signals` 的运行时入口就在
   `build/src/index.js`。`prepare.mjs` 现在只在**包根**删除 `src/` 与 `docs/`。
2. **`output.schema` 是 ValueSchemaSpec，不是 JSON Schema**：`required: [...]` 会直接抛
   `JsonSchemaError`，必填要写成属性上的 `required: true`，并且对象要显式给
   `additionalProperties`。

## 4. 已验证的扩展点

### 4.1 工具注册（不走 MCP）

```ts
export const name = 'tapd-tools'
export const inject = ['tools']
export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'tapd_get_bug',
    description: '…',
    parameters: { bug_id: { type: 'string', required: true } },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute(args, exec) { /* POST 127.0.0.1:<port>/internal/tapd/... */ },
  }))
}
```

`defineTool` 自动校验参数、把 schema 并入系统提示词、注册是 effect（插件卸载即注销）。
参考 `packages/shell/tool-bash`、`docs/cookbook/adding-a-tool.md`。

### 4.2 流式

```ts
// packages/core/agent/src/runtime-types.ts:155
type AssistantStreamFrame =
  | { type: 'start'; attemptId; revision; turn; step }
  | { type: 'chunk'; attemptId; revision; index; time; chunk: StreamChunk }
  | { type: 'end'; attemptId; revision; index;
      outcome: { kind: 'committed'; eventType: 'assistant/message' | 'assistant/attempt'; seq } | { kind: 'abandoned' } }
```

`StreamChunk`（`packages/llm/llm/src/types.ts:496`）：
`block-start | text-delta | reasoning-delta | tool-call-delta | block-end | usage | finish`，全部是纯 JSON。

订阅方式：`agent/assistant-stream`，payload 为 `{ agent, frame }`；`revision` 在同一 Agent 生命周期内单调，
递增表示替换（重试 / 改写），接收端必须按 `revision` 重置而不是追加。

### 4.3 会话与历史

- `ctx.sessions.get(id)` / `list()`；`session.snapshotEvents(...)`、`eventAt(seq)`、`deriveMessages()`。
- `session/query` 的 `sessionId` 是**幂等键**：已存在的会话再 query 会返回
  `session "…" already exists`。新建会话用新 id，续接已有会话用 `session/resume`。
- 桥插件连上后先推 `snapshot`（header + 全量事件 + 游标 + 投影基线），再推增量；
  形制对齐上游 `SessionFollowFrame`（`snapshot | SessionEventEntry | assistant-stream`），
  这样「刷新后恢复历史」不依赖 SDK（SDK 没有 history 读接口）。

### 4.4 审批 / 提问（SDK）

```ts
// initialize
{ cwd, provider, model, approvalRequests: true, capabilities: { userQuestions: true }, reasoningEffort?, maxTokens? }

// server → client
'approval/request': { sessionId, toolName, callId?, reason? }
  → { outcome: 'allowed-once' | 'rejected' | 'cancelled' }   // 只有 allowed-once 放行

'user-question/ask': { requestId, sessionId, questions: AskUserQuestionItem[] }
  → { answers: [{ id, selected: string[], custom?: string }] } | { cancelled: true }

'user-question.cancelled': { requestId, sessionId }          // 运行时放弃等待，宿主丢弃
```

`AskUserQuestionItem`（`packages/interaction/user-questions/src/types.ts:55`）：
`id / question / detail? / header? / options? / multiSelect? / intent?`；
`intent` 有 `plan-review`（detail 即计划）与 `approval`（固定 拒绝/允许/始终允许）。
跳过某题 = `{ id, selected: [] }` 且无 `custom`；**关闭面板必须发 `{cancelled:true}`，不是放行**。

### 4.5 团队任务板

- root session 的投影 `agentTeam`：`{ enabled, tasks: TeamTaskView[], failure? }`。
- `TeamTaskView`：`id(task-<n>) / revision / subject / description / status(pending|in_progress|completed|deleted)
  / blockedBy[] / writeScopes[] / ownerId? / ownerName? / ready / writeScopeWarnings[]`。
- 开关：profile 里 `- id: agent-team config: { defaultEnabled: false }`，会话内可写 `team/mode`；
  Web 侧方法名为 `remote.agentTeams.setEnabled`。默认关闭，符合我们的产品设定。
- 子 agent 提供者：`subagent-spawn-in-process` / `-fork-in-process` / `-acp` / `-codex` /
  `-claude-code` / `-dsh-sdk`。同事先用 in-process + 技能根；ACP 留给后续。

### 4.6 自定义模型 Provider

`@deepseek-ai/dsh-llm-pi-ai` 的 `providers` 字典就是「自定义模型 API」：

```yaml
- name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      acme-gateway:
        displayName: Acme Gateway
        apiKeyEnv: ACME_GATEWAY_API_KEY      # 走 dsh 的凭证服务，密钥不落配置文件
        api: openai-completions              # openai-completions | anthropic | gemini
        baseURL: https://gateway.example/v1
        models: [{ id: acme-think, name: Acme Think, contextWindow: 262144 }]
```

模型目录可以留空（目录外 ID 直接发送），与截图二的形态一致。

### 4.7 组合与插件安装

- profile 是 `$DSH_HOME/profiles/<name>/`：`package.json`（`dsh.profile.bundles` + `dependencies`）
  + 用户 patch `cordis.patch.yml` + `pnpm-workspace.yaml`。实测形状：

  ```json
  {
    "name": "dsh-profile-tapd",
    "private": true,
    "dependencies": {},
    "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"] } }
  }
  ```

- patch 支持 `- id: <row> config: {...}` 覆盖、`- id: <row> disabled: true`、`- insert: [...]` 新增。
  例：`packages/bundle/sdk-app/cordis.patch.yml`、`apps/cli/config/examples/team-mode.yml`。
- **内置插件不需要 pnpm**：patch 的 `insert` 可以直接把 `name` 写成插件目录的绝对路径，
  启动时会被规范化为 `file:///…` 并由 Node 的 ESM 解析器加载（实测通过）。
  所以 `dsh/plugins/*` 随 App 打包、原样引用即可，profile 的 `dependencies` 保持为空。
- `plugin_manager` 工具默认关闭（它会调 pnpm）；插件开关由我们自己的 UI 改 patch 后重启运行时生效。


## 5. 自研桥协议（dsh → Rust，NDJSON over `127.0.0.1`）

Rust 先监听随机端口并把 `TAPD_DSH_BRIDGE_URL` / `TAPD_DSH_BRIDGE_TOKEN` 注入子进程；插件启动后连接。第一版消息：

| 类型 | 方向 | 内容 |
| --- | --- | --- |
| `hello` | 插件→Rust | `{ profile, version, sessions }` |
| `session/snapshot` | 插件→Rust | `{ sessionId, header, cursor, events[] }`（含投影基线） |
| `session/event` | 插件→Rust | `{ sessionId, event }` |
| `stream` | 插件→Rust | `{ sessionId, frame }`（`AssistantStreamFrame`，按 `revision` 收敛） |
| `team/board` | 插件→Rust | `{ sessionId, projection }` |
| `error` | 插件→Rust | `{ sessionId?, code, message }` |

带宽策略：`text-delta` / `reasoning-delta` 在插件侧按 16–32ms 合并成单帧再发；`tool-call-delta` 原样；
`end` 必须发（Rust 用它结算消息并丢弃未完成的流）。

## 6. 升级前必须过的验证

`scripts/dsh/verify.mjs`（当前设计）：
1. 用系统 node 起 `dsh --profile tapd`，`initialize` 成功；
2. 发一条 prompt，断言 `stream` 收到 `start → text-delta+ → end(committed)`；
3. 触发一次写入（`write` 工具），断言收到 `approval/request`，回 `allowed-once`，断言 turn 结束；
4. 断言 `session/snapshot` 能还原上一轮历史；
5. 断言 `tapd_whoami` 出现在工具表里。

## 7. 与旧架构的差异（已删除的能力）

- 不再有 PTY 运行时、TUI 适配表、`--model` / 权限参数翻译、就绪静默、完成静默、会话 hook 安装。
- 不再读别人的 transcript / JSONL；消息流来自 dsh 的 session log。
- 不再给内置 Agent 注入 MCP 配置；外部客户端仍走 `tapd-mcp` sidecar。
- 状态机只剩 `running → awaiting_review → awaiting_merge → done`，turn 生命周期交给 dsh。

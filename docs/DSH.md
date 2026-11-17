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
- 打包的是压缩 payload：`resources/dsh/{manifest.json,payload-<version>-<platform>-<arch>.tar.zst}`
  （约 19 MB，解压后约 233 MB / 2.5 万文件），首启按版本解到 `<data>/dsh/<version>/`；
  payload 里是 JS 依赖树与自有插件，**不含 Node 二进制**。清理只删版本形态的旧目录：
  同一父目录下的 `home/`（`DSH_HOME`）与解压 staging 必须保留。

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

## 2.3 与已安装 dsh 的隔离

用户机器上可能已经装了 `dsh`（npm 全局或桌面版）。内置运行时不与它共享任何东西：

| 维度 | 内置运行时 | 已安装 dsh |
| --- | --- | --- |
| 代码 | `<data>/dsh/<version>/node_modules/...`（打包 payload 解压） | 用户自己的安装目录 |
| 配置 / 会话 | `DSH_HOME=<data>/dsh/home`（显式覆盖，绝不读 `~/.dsh`） | 默认 home |
| profile 名 | `tapd` | `web` / `desktop` / `sdk` … |
| 入口 | `node <payload>/@deepseek-ai/dsh/lib/bin.js`（绝对路径） | PATH 上的 `dsh` |
| 端口 | stdio + 桥接随机端口 | 默认 3080 |

启动子进程时**只**用绝对入口 + 显式 `DSH_HOME`，不 `source` 用户的 shell 配置、不写全局
npm/pnpm 配置。`docs/DSH.md` 里所有配置都落在应用数据目录的 `agent.json` 与 `dsh/` 下。

**密钥存储**：每个供应商的 API key 以**明文**写在应用数据目录的
`agent.json`（`dshModels.providers[].apiKey`）里。这是本地单机应用，不接 Keychain、不做加密；
启动运行时按供应商分别通过 `TAPD_DSH_API_KEY_<供应商 id 大写化>` 交给子进程，profile 里写的
是对应的 `apiKeyEnv`。密钥不进入 profile、不写进任何日志行。

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
- 开关：profile 里 `- id: agent-team config: { defaultEnabled: <有同事?> }` —— 由配置页的「同事」
  开关决定（`coworker_ids` 非空即开），打开时同事随团队一起加入；会话内仍可写 `team/mode`，
  Web 侧方法名为 `remote.agentTeams.setEnabled`。
- 子 agent 提供者：`subagent-spawn-in-process` / `-fork-in-process` / `-acp` / `-codex` /
  `-claude-code` / `-dsh-sdk`。同事先用 in-process + 技能根；ACP 留给后续。

### 4.6 自定义模型 Provider

`@deepseek-ai/dsh-llm-pi-ai` 的 `providers` 字典就是「自定义模型 API」，可以并存多个：界面左侧
供应商列表的一项对应一个键，启动时**所有启用且可用的**供应商都写进去，`initialize` 只把默认
供应商 / 默认模型传给 SDK。

```yaml
- id: llm-pi-ai
  config:
    providers:
      'opencode-go':
        displayName: 'OpenCode Go'
        apiKeyEnv: 'TAPD_DSH_API_KEY_OPENCODE_GO'   # 走 dsh 的凭证服务，密钥不落配置文件
        api: 'openai-completions'                   # openai-completions | openai-responses | anthropic-messages | google-generative-ai
        baseURL: 'https://opencode.ai/zen/go/v1'
        models:
          - id: 'deepseek-v4.1-flash'
            name: 'deepseek-v4.1-flash'
            contextWindow: 1000000
            maxTokens: 64000                        # 省略 = 走目录默认
            input: ['text', 'image']                # 省略 = 走目录默认；此版本只有 text / image
            reasoningEfforts:                       # 省略 = 走目录默认；等级按低到高
              low: 'low'
              high: 'high'
```

`api` 只认上面四个字符串（`anthropic` / `gemini` 会被上游 zod 拒绝，读旧配置时就地更正）。
模型目录不能为空：目录外的 ID 必须列出来，运行时才解析得到；每个模型的 `contextWindow`、
`maxTokens`、`input`、`reasoningEfforts` 都可以逐项覆盖目录默认值。

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

## 8. 桥插件与归一化视图

本节是**前端唯一的渲染契约**。第 5 节是最初的设计草图；实际实现以本节为准。

### 8.1 通道与生命周期

- Rust 在每次 `dsh_start` 时绑定 `127.0.0.1:0`，生成随机 token，把
  `TAPD_DSH_BRIDGE_URL`（`http://127.0.0.1:<port>`）与 `TAPD_DSH_BRIDGE_TOKEN`
  注入子进程环境；插件 `@tapd/plugin-bridge` 读取这两个变量。
- 两个变量缺失时插件完全惰性（`scripts/dsh/prepare.mjs --verify` 与独立 dsh 运行都不受影响）。
- 插件只连回环地址；Rust 只接受回环连接，并校验**每一帧**的 `token`，不匹配立即断开。
- 插件断线后按 250ms → 4s 退避重连，重连成功后**重发全部会话快照**；Rust 按事件
  `seq` 去重，重复快照不会产生重复行。
- 插件不读 stdin、不写 stdout（stdout 属于 SDK JSON-RPC 协议槽）。

### 8.2 NDJSON（插件 → Rust）

每行一个 JSON 对象；所有帧都带 `token`。字段名是 camelCase。

```jsonc
// 连接后的第一帧
{ "type": "hello", "token": "<token>" }

// 每个存活会话一帧，连接时（含重连）发送；events 是 dsh SessionEvent 原样数组
{ "type": "snapshot", "token": "<token>", "sessionId": "probe-1", "events": [ /* SessionEvent[] */ ] }

// 每个 agent/assistant-stream 帧一行，frame 原样透传（见 4.2 的 AssistantStreamFrame）
{ "type": "stream", "token": "<token>", "sessionId": "probe-1", "frame": { /* AssistantStreamFrame */ } }
```

`event`（单条事件）是保留类型：Rust 已能接收 `{type:"event",token,sessionId,event}`，
当前插件不发（已提交事件走 SDK 的 `session.event`，两边共用同一个 ingest）。

`start` / `end` / `usage` / `finish` 帧不产生增量，不向上转发；`end(committed)` 之后
必然跟一条已提交的 `assistant/message` 行，前端据此把 live 文本换成持久行。

### 8.3 持久行 `DshEntry`

按 `seq` 唯一；`at` 是事件自带 `time`（epoch ms）转成的 RFC3339 UTC（毫秒精度）。
`kind` 四种：

```jsonc
{ "kind": "user", "seq": 3, "at": "2026-11-16T12:00:00.000Z", "text": "hello" }

{ "kind": "assistant", "seq": 5, "at": "…", "text": "…", "reasoning": "…" } // reasoning 可省略

{ "kind": "tool", "seq": 6, "at": "…", "callId": "call_1", "name": "bash",
  "args": "{\"cmd\":\"ls\"}",          // 模型产出的原始 JSON 字符串，由前端解析
  "status": "running",                 // running | ok | error
  "result": "file.txt" }               // ok/error 后出现，字符串（工具结果的文本）

{ "kind": "turn", "seq": 0, "at": "…", "state": "start" }   // state: start | end
{ "kind": "turn", "seq": 9, "at": "…", "state": "end", "reason": "error" } // reason = TurnEndReason.kind
```

规则（实现见 `crates/dsh-host/src/transcript.rs`）：

- `tool` 行使用 **`tool/call` 的 seq**；`tool/result` 到达时原地更新该行并以同一 `seq`
  重新发一条 `dsh://entry`。前端按 `seq` 覆盖即可，不要按到达顺序追加。
- 只有工具调用、没有文本/推理的 assistant 消息**不产生行**（对应的 `tool` 行已表达）。
- `user/message` 只在 `data.source.kind == "user"`（无 `source` 的旧日志也按人类输入处理）时产生
  `user` 行；`agent-instructions`、时间采样等注入上下文虽然也是 `user/message`，但**不进入对话**
  （否则会把 AGENTS.md 渲染成用户气泡），它们仍留在 dsh 自己的会话日志里。
- 目前只渲染 `text` / `reasoning` 块；image / file 块不进 `text`（附件仍在 TAPD 侧）。
- 未知事件类型（`step/start`、`request/header` 等）忽略，每种类型只记一条 debug 日志。
- 跨来源去重：快照与 `session.event` 可能重复同一 `seq`，只应用一次。

### 8.4 会话 `DshSession`

```jsonc
{ "id": "probe-1", "title": "hello", "updatedAt": "2026-11-16T12:00:00.000Z",
  "status": "idle", "messageCount": 1 }   // status: idle | running | failed
```

- `title`：第一条人类 user 行的首行，最多 60 字符（超长以 `…` 结尾）；还没有 user 行时为空串，
  UI 自己渲染空态，不要伪造标题。
- `messageCount`：已提交的 user + assistant 行数（tool / turn 不计）。
- `status`：`turn/start` 或 `session.status(running)` → `running`；`turn/end` 且
  `reason.kind` 为 `error` / `blocked` → `failed`，其余 → `idle`；随后到达的
  `session.status(idle)` 是权威值，可把失败会话改回 `idle`（失败原因保留在 `turn` 行里）；
  运行时进程退出时，仍为 `running` 的会话改为 `failed`。
- `updatedAt` 是固定宽度的 RFC3339（毫秒、UTC），字典序即时间序；列表按它降序。

### 8.5 实时增量 `DshStream`

```jsonc
{ "sessionId": "probe-1", "attemptId": "attempt-1", "revision": 1, "index": 7,
  "delta": { "type": "text", "text": "你" } }
{ "sessionId": "probe-1", "attemptId": "attempt-1", "revision": 1, "index": 8,
  "delta": { "type": "reasoning", "text": "…" } }
{ "sessionId": "probe-1", "attemptId": "attempt-1", "revision": 1, "index": 9,
  "delta": { "type": "tool-call", "callId": "call_1", "name": "bash",
             "arguments": "{\"cmd\":" } }
```

- **不持久**：只用于流式渲染。live 文本按 `(sessionId, attemptId, revision)` 分组；
  `revision` 变大表示该 attempt 被替换（重试/改写），先清空再追加，不要拼接。
- 已提交的 `assistant` 行到达后丢弃对应的 live 文本；`turn/end` 到达后清空该会话所有 live。
- 插件不合并 delta（每帧一行）；Rust 也不合并，`index` 保留上游含义。

### 8.6 Tauri 事件与命令

事件（UI 只渲染 `entry` / `stream` / `sessions`，不要从原始事件重建状态）：

| 事件 | 载荷 |
| --- | --- |
| `dsh://entry` | `{ sessionId, entry: DshEntry }`（tool 行更新会再次发送） |
| `dsh://stream` | `{ sessionId, stream: DshStream }` |
| `dsh://sessions` | `{ sessions: DshSession[] }`（新增会话、标题/状态/计数变化时） |
| `dsh://session-event` | SDK 原始 `{sessionId, event}`（保留给调试/原始消费者） |
| `dsh://approval` / `dsh://question` | 见 4.4，回执按 `rpcId` |
| `dsh://request-settled` | `{ rpcId }`：该请求已在别的面（胶囊 / 手机 / 主窗口）作答，或运行时退出清空了 pending；各面据此撤卡 |
| `dsh://status` / `dsh://ready` / `dsh://error` | 运行时状态机 |

命令（桌面 `invoke` 与手机 `feature_router` 的 `dsh_*` 是同一实现）：

| 名称 | 入参 | 返回 |
| --- | --- | --- |
| `dsh_status` | — | `DshStatus` |
| `dsh_start` / `dsh_stop` | — | `DshStatus` |
| `dsh_sessions` | — | `{ sessions: DshSession[] }`（按 `updatedAt` 降序） |
| `dsh_session_entries` | `{ sessionId, sinceSeq? }` | `{ sessionId, known, entries: DshEntry[], lastSeq }`（`known: false` = 运行时没见过该会话，UI 回退而不是报错；带 `sinceSeq` 时只返回 `seq > sinceSeq` 的行，手机轮询用它避免全量重下；`lastSeq` 小于本地值时说明运行时重启过，回退全量读） |
| `dsh_new_session` | — | `{ sessionId }`（空会话，已进入列表） |
| `dsh_pending` | — | `{ requests: PendingRequest[] }`（见 8.7） |
| `dsh_prompt` | `{ sessionId, text }` | `{ sessionId, receipt }`；必要时先启动运行时 |
| `dsh_approval_answer` | `{ rpcId, outcome }` | `{ ok: true }` |
| `dsh_question_answer` | `{ rpcId, answers }`（`answers: null` = 取消） | `{ ok: true }` |

### 8.7 阻塞请求快照 `dsh_pending`

事件可能在页面打开之前到达（例如手机发起、桌面还没进 Agent 页），所以阻塞请求必须可查：

```jsonc
{ "requests": [
  { "rpcId": 12, "sessionId": "s1", "kind": "approval",
    "request": { "sessionId": "s1", "toolName": "bash", "callId": "c1", "reason": "…" } },
  { "rpcId": 13, "sessionId": "s1", "kind": "question",
    "request": { "requestId": "q1", "sessionId": "s1", "questions": [ … ] } }
] }
```

- 唯一 owner 是 `RuntimeState.pending`：请求到达时登记、`dsh_approval_answer` /
  `dsh_question_answer` 成功时移除、运行时退出或 `dsh_stop` 时清空。
- 桌面在 Agent 页 bootstrap 时拉一次并喂给与实时事件相同的 reducer；手机在每次会话轮询时拉取。
- 顺序：先登记再发事件，所以事件到达后立刻查快照也能看到同一条。

### 8.8 当前未实现（UI 不要假设）

- 归一化视图只在内存中；App 重启后需要等新快照/事件重建（dsh 自己仍持久化会话）。
- 没有历史分页：快照是全量 `snapshotEvents()`，大仓库会话首次连接会一次推完。
- image / file 内容块、子 agent 会话树、`subagent.*` 的归一化行都未实现。
- `assistant/attempt`（失败/被取消的模型尝试）与 `session/title` 被忽略：模型失败只通过
  `turn` 行的 `reason` 呈现，标题由第一条人类 user 行生成（不用 dsh 自带的标题投影）。
- 未做 token 侧合并（见 8.5），高吞吐模型下 NDJSON 行数等于 delta 帧数。

## 9. 任务工作流与权限模式（P3 / P4 契约）

本节是 P3/P4 的唯一契约。前端只消费本节的结构；实现分别落在
`dsh/policy.rs`（P3）与 `dsh/tasks.rs`（P4）。

### 9.1 统一任务 `DshTask`

一个列表项 = 一条 dsh 会话 + 我们附加的任务元数据。运行时不再区分
「运行中 / 待审核 / 历史」三个清单，全部由 `workflow` 字段表达。

```jsonc
{
  "id": "<dsh session id>",
  "kind": "chat" | "bug" | "local_item",
  "project": { "id": "45336192", "name": "UU-Rust", "kind": "tapd" }
           | { "id": "lp_…", "name": "test", "kind": "local" }
           | null,                       // 无项目的自由会话
  "title": "登录崩溃",                    // bug 标题 / 事项标题 / 首条用户消息
  "bugId": "11223344",                   // kind=bug 才有
  "workflow": "running" | "awaiting_review" | "awaiting_merge"
            | "done" | "failed" | "canceled",
  "status": "idle" | "running" | "failed", // dsh 会话实时状态
  "repoPath": "/repo",
  "worktreePath": "<data>/worktrees/<session id>",  // 开启 Worktree 才有
  "branch": "tapd/11223344-…",
  "jsonPath": "/…/bug.json",
  "createdAt": "RFC3339", "updatedAt": "RFC3339",
  "messageCount": 3,
  "changes": { "files": 2, "additions": 30, "deletions": 4 } | null,
  "review": { "summary": "…", "files": ["src/a.rs"], "risk": "…" } | null,
  "merge": { "error": "…", "instructions": "…" } | null
}
```

自由会话同样进这个列表：`kind: "chat"`、`project: null`，`workflow` 保持 `running`
（列表不显示 chip，只显示实时状态点），标题取第一条人类消息的首行（≤60 字）。
它在回合结束后不做 worktree / 审核判定——没有仓库可审。

迁移规则（单一入口，终态防回退）：

- 创建：`bug` / `local_item` 任务先导出（`bug.json` / `quest.json`），
  Worktree 开启时建 worktree 并把会话 cwd 指过去，然后发送渲染好的提示词。
- `running → awaiting_review`：回合结束（`turn/end`）且有改动；无改动 → `done`。
- `awaiting_review → awaiting_merge`：`dsh_task_approve` 提交改动后（Worktree 关闭时直接 `done` 并回写）。
- **approve 拒绝有活跃回合的会话**（`dsh.task.approve.busy`）：提交是对当前树的快照，
  回合继续写会让快照之后的内容在合并时被 `worktree remove` 丢掉。持久化行不带 live
  状态，判定读 bridge 注册表。
- `awaiting_merge → done`：`dsh_task_merge` 合并成功且分支已是 HEAD 祖先，随后回写 TAPD。
  **合并前要求分支 tip ≠ baseline**：`merge --no-ff` 对未前进的分支返回 exit 0
  （"Already up to date"），ancestor 校验会恒真，任务会被假判成功并回写 resolved。
- 合并成功但 worktree 有未提交改动（审核后用户又编辑过）时**保留 worktree 目录**，
  不执行 `remove --force`；目录已不存在则 prune。
- `dsh_task_cancel` 与 `dsh_task_merge` 共用一把进程内互斥锁：合并期间取消返回
  「正在合并」，取消先赢时合并直接返回；取消本地事项任务会把事项退回 attach 前的状态
  并清掉 `agentTaskId`。
- 失败只在准备阶段（导出 / worktree / 启动）置 `failed`；运行中的模型失败仍由 `turn` 行为准。

### 9.2 命令面（桌面 invoke 与手机 feature 同一实现）

| 名称 | 入参 | 返回 |
| --- | --- | --- |
| `dsh_tasks` | — | `{ tasks: DshTask[] }`（按 `updatedAt` 降序） |
| `dsh_task_enqueue_bug` | `{ workspaceId, bugId, extraPrompt?, attachments? }` | `{ task }` |
| `dsh_task_enqueue_local` | `{ projectId, itemId, extraPrompt?, attachments? }` | `{ task }` |
| `dsh_task_approve` | `{ sessionId }` | `{ task }` |
| `dsh_task_merge` | `{ sessionId }` | `{ task }` |
| `dsh_task_cancel` | `{ sessionId, stash? }` | `{ task }` |
| `dsh_task_diff` | `{ sessionId, file? }` | `{ diff }`（统一 diff 文本） |
| `dsh_task_resume` | `{ sessionId }` | `{ task }`（恢复 dsh 持久化会话） |
| `dsh_policy_get` / `dsh_policy_set` | `{ mode }` | `{ mode }` |

事件：`dsh://tasks { tasks }`（列表变化），其余沿用第 8 节。

持久化：`cache.sqlite3` 新表 `dsh_tasks`（schema v9），元数据进库，transcript 仍由 dsh 自己保存。
重启后 `dsh_tasks` 提供列表；打开任务时按需 `dsh_task_resume`。

### 9.3 权限模式

| 模式 | 行为 | 判定 |
| --- | --- | --- |
| `auto`（默认） | 只在有风险时请求授权 | 命中「硬 / 软」规则 → `ask`；其余放行 |
| `notify` | 全部放行，执行前推一条通知 | 命中硬 / 软规则 → 通知（不阻塞） |
| `full` | 除硬黑名单外全部放行 | 仅命中硬规则 → `ask` |

- 规则由 `dsh/plugins/tapd-policy` 在 `tools/pre-execute` 判定，返回
  `{kind:'allow'|'ask'|'deny'}`；`ask` 走 `user-approval` → 我们的审批卡。
- 硬规则：`rm -rf /`、`mkfs`、`dd` 写磁盘、`sudo`、`git push --force`、
  `DROP TABLE`、`curl … | sh`、写 `~/.ssh` / `~/.aws` / keychain、`chmod -R 777 /`。
- 软规则：工作区外写入、删除工作区文件、安装依赖、`git push`、网络上传。
- 提示词只要求模型「改代码 + 跑测试」，明确不 commit、不 push、不写 TAPD：提交、合并与回写
  由宿主在审核后确定性地做。仍带 `tapd_add_bug_comment` / `tapd_update_bug_status` 等旧工具的
  模板会被判定为失效并替换成新默认模板（校验而非迁移）。
- 模式来自 `agent.json.permissionMode`，通过 `TAPD_DSH_PERMISSION_MODE`
  传入运行时；切换模式需要重启运行时（UI 明说）。
- 不做模型审查：规则是确定性的，零 token，可单测。若以后要模型审查，
  再挂上游 `dsh-experimental-auto-review` 作为 `auto` 的一层。

### 9.4 胶囊与移动端

- 审批：胶囊 AI 卡（`notification::raise_ai`），动作「允许一次 / 拒绝」，
  回执走 `dsh_approval_answer`；超时/关闭不放行。
- 提问：单问题单选 → 直接在胶囊作答；多问题/多选 → 胶囊只提示
  「需要你选择 N 项」+「去处理」，主窗口打开对应会话的 QuestionSheet。
- `notify` 模式：每次写/执行前推一张非阻塞通知卡（不等待）。
- 手机：任务页可回答审批与提问（`dsh_approval_answer` / `dsh_question_answer`），
  Agent tab 用角标显示待处理数量；PWA 没有系统推送，进程内轮询为准。

### 9.5 Agent Teams（P5）

团队协作默认关闭；开启后按会话持久化（dsh 的 `team/mode`），重启沿用。

```jsonc
// dsh_team_get { sessionId } / dsh_team_set { sessionId, enabled } → { team }
{
  "sessionId": "…",
  "enabled": false,
  "tasks": [
    { "id": "task-1", "subject": "改登录页", "description": "…",
      "status": "pending" | "in_progress" | "completed",
      "ownerId": "<subagent session id>", "ownerName": "架构/author",
      "blockedBy": [], "writeScopes": ["src/login"], "ready": true }
  ],
  "failure": "…"                       // 投影自身报错时才有
}
```

- 事件 `dsh://team { sessionId, team }`：连接、Team 开关、任务/归属变化时推送。
- 运行行已在 `dsh-sdk-app` 的 profile 里（`agent-team` + `tool-agent-team`），
  `defaultEnabled: false`；P5 不新增依赖。
- 开启团队时，宿主向会话追加一条**同事名单**消息：已启用同事的角色、
  技能包 `SKILL.md` 绝对路径，并要求把可拆分工作指派给匹配的同事/子 agent
  并在任务板登记；没有匹配同事时按性质派给普通子 agent。
- 任务板不创建独立工作目录；成员共用当前 checkout（worktree 语义不变）。
